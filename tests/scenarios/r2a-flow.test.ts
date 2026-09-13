import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { SessionClock } from "../../src/input/session-clock.ts";
import {
  createBattle,
  getInteraction,
  stepBattle,
  type BattleDirection,
  type BattleIntent,
  type BattleState,
} from "../../src/simulation/battle.ts";
import { GATE_IDS, PART_IDS, type ActorId, type ObjectLocation, type TeamId, type WorldEvent } from "../../src/domain/types.ts";

const ENEMY_SHOOTERS = ["E01", "E02", "E03", "E04"] as const;
const PLAYER_ACTORS = ["P1", "P2", "P3"] as const;
const NEUTRAL: BattleDirection = { x: 0, y: 0 };
const MAX_LIVE_SOURCE_GROUPS_PER_TEAM = 48;
// Four complete public deliveries exercise pickup/drop/repick, both routes,
// shooter handoff, and a repeated walk without making the scenario's runtime
// depend on 24 long traversals of the authored castle corridor.
const P1_DELIVERY_TARGET = 4;

type Cell = { x: number; y: number };
type FlowPhase = "to-pickup" | "drop-first" | "repick-first" | "to-turret" | "done";
type RecordedEvent = { tick: number; event: WorldEvent };

interface FlowRecord {
  events: RecordedEvent[];
  launches: Array<{
    tick: number;
    event: Extract<WorldEvent, { type: "projectile_launched" }>;
    sourcePortId: string;
    originGroupId: string;
    caseType: string;
  }>;
  spawns: Map<string, Extract<WorldEvent, { type: "case_spawned" }>>;
  moveKinds: Map<string, Array<{ kind: ObjectLocation["kind"]; actorId?: ActorId; team?: TeamId }>>;
  carriedPositions: Map<string, Set<string>>;
  launchRoutes: Map<string, "direct" | "detour">;
  benchmarkMs: number;
}

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

function isNearPlayerTurret(state: BattleState): boolean {
  const turret = state.artillery.turrets["player:T1"];
  const position = state.fixedActors.P1.position;
  const dx = position.x - turret.position.x;
  const dy = position.y - turret.position.y;
  return dx * dx + dy * dy <= 800 * 800;
}

/**
 * The public input is a direction pad, so the flow drives one cardinal leg at
 * a time.  Targeting an authored cell centre with a diagonal direction is
 * subtly wrong around the 0.6-cell equipment bodies: when the remaining
 * distance on one axis is only a few fixed subunits, the diagonal can press
 * into the body and leave the actor permanently stuck.  These legs are the
 * same ordinary floor route used by the battle UI/browser flow.
 */
function axisDirection(state: BattleState, targetX?: number, targetY?: number): BattleDirection {
  const position = state.fixedActors.P1.position;
  const sign = (value: number): -1 | 0 | 1 => value > 0 ? 1 : value < 0 ? -1 : 0;
  // A carried weight-3 case advances by 42.5 subunits/tick and retains a
  // fractional remainder.  A 50-subunit deadband hands control to the next
  // leg without bouncing across an exact cell centre.
  if (targetX !== undefined && Math.abs(position.x - targetX) > 50) return { x: sign(targetX - position.x), y: 0 };
  if (targetY !== undefined && Math.abs(position.y - targetY) > 50) return { x: 0, y: sign(targetY - position.y) };
  return NEUTRAL;
}

const P1_AMMO_APPROACH_X = 94_500;
const P1_AMMO_PICKUP_Y = 13_500;
// y=12.0 remains inside passage_12 while leaving a >1-cell clearance from
// the turret body; the final south leg then stops at its walkable approach.
const P1_TURRET_TRAVEL_Y = 12_000;
// Stop on the walkable operator side of turret A so P1 can both hand off and
// satisfy the authored shooter-operation point when the queue launches.
const P1_TURRET_APPROACH_X = 105_850;
const P1_AUTHORED_ROUTE_CELLS: readonly Cell[] = [
  { x: 92, y: 33 }, // respawn
  { x: 94, y: 33 }, // central corridor
  { x: 94, y: 13 }, // ammo_A approach
  { x: 93, y: 13 }, // ammo_A port cell
  { x: 100, y: 12 }, // ammo_A -> battery_A passage
  { x: 106, y: 12 }, // turret_A approach
];

function assertP1AuthoredFloorRoute(state: BattleState): void {
  const floor = new Set(state.layout.home.floorCells.map(cellKey));
  for (const cell of P1_AUTHORED_ROUTE_CELLS) assert.ok(floor.has(cellKey(cell)), `P1 route cell ${cellKey(cell)} is authored floor`);
}

function p1ToAmmoDirection(state: BattleState, firstDelivery: boolean): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (firstDelivery) {
    const horizontal = axisDirection(state, P1_AMMO_APPROACH_X);
    if (horizontal.x !== 0) return horizontal;
    const vertical = axisDirection(state, undefined, P1_AMMO_PICKUP_Y);
    if (vertical.y !== 0) return vertical;
  } else {
    // From the turret, go above the equipment, cross the authored passage,
    // then descend on the clear side of ammo_A before approaching its port.
    // Once the horizontal leg reaches its staging x, never re-enter the up
    // leg: the carried fractional remainder can otherwise bounce between two
    // y positions while the actor is trying to descend toward ammo_A.
    if (position.x > P1_AMMO_APPROACH_X + 50) {
      const up = axisDirection(state, undefined, P1_TURRET_TRAVEL_Y);
      if (up.y !== 0) return up;
      return { x: -1, y: 0 };
    }
    const down = axisDirection(state, undefined, P1_AMMO_PICKUP_Y);
    if (position.y < P1_AMMO_PICKUP_Y - 50 && down.y !== 0) return down;
  }
  // Once the staging point is reached, walk toward the port until its public
  // pickup handle appears.  Collision stops at a physically valid approach.
  return { x: -1, y: 0 };
}

function p1ToTurretDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  // Finish the up leg before crossing the narrow passage.  After x reaches
  // the turret's vertical line, stay on the south leg; do not compare y to
  // the old travel waypoint again (that would oscillate at a 42.5 speed).
  if (position.x < P1_TURRET_APPROACH_X - 50) {
    if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
    return { x: 1, y: 0 };
  }
  if (!isNearPlayerTurret(state)) return { x: 0, y: 1 };
  return NEUTRAL;
}

function publicP1Intent(state: BattleState, partial: Partial<BattleIntent> = {}): BattleIntent {
  return {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    ...partial,
  };
}

function locationMeta(location: ObjectLocation): { kind: ObjectLocation["kind"]; actorId?: ActorId; team?: TeamId } {
  if (location.kind === "carried" || location.kind === "reserved-carried") return { kind: location.kind, actorId: location.actorId };
  if (location.kind === "queue") return { kind: location.kind, team: location.team };
  return { kind: location.kind };
}

function recordStep(state: BattleState, record: FlowRecord): void {
  const tick = state.lastStep.processedTick;
  assert.notEqual(tick, null, "a running battle step has a processed tick");
  for (const event of state.lastStep.events) {
    const recorded = { tick: tick!, event: structuredClone(event) };
    record.events.push(recorded);
    if (event.type === "case_spawned") {
      record.spawns.set(event.objectId, structuredClone(event));
    } else if (event.type === "object_moved") {
      const entries = record.moveKinds.get(event.objectId) ?? [];
      entries.push(locationMeta(event.location));
      record.moveKinds.set(event.objectId, entries);
    } else if (event.type === "projectile_launched") {
      const caseState = state.battleCases[event.objectId];
      assert.ok(caseState, `launch ${event.projectileId} has a case lineage`);
      assert.equal(caseState.location, "flying", `launch ${event.projectileId} owns the flying case`);
      assert.equal(caseState.sourcePortId.length > 0, true, `launch ${event.projectileId} records a source port`);
      assert.equal(caseState.originGroupId.length > 0, true, `launch ${event.projectileId} records an origin group`);
      const shooter = state.actors[event.sourceActorId];
      const turret = state.artillery.turrets[`${event.team}:${event.turretId}`];
      assert.ok(shooter?.alive, `${event.projectileId} source shooter is alive at launch`);
      if (event.team === "enemy") assert.equal(shooter?.role, "shooter", `${event.projectileId} source is a dedicated enemy shooter`);
      else assert.ok(PLAYER_ACTORS.includes(event.sourceActorId as (typeof PLAYER_ACTORS)[number]), `${event.projectileId} source is a player operator`);
      assert.equal(shooter?.generation, event.sourceGeneration, `${event.projectileId} source generation is current`);
      assert.ok(shooter?.protectedUntilTick === null || (shooter?.protectedUntilTick ?? 0) <= tick!, `${event.projectileId} source is not spawn-protected at launch`);
      assert.ok(turret?.operatorActorIds.includes(event.sourceActorId), `${event.projectileId} source owns its turret`);
      if (shooter && turret) {
        const dx = state.fixedActors[shooter.id].position.x - turret.position.x;
        const dy = state.fixedActors[shooter.id].position.y - turret.position.y;
        // The public firing contract is the turret body action radius.  The
        // authored operatorPosition is an AI walk target, not a launch gate.
        assert.ok(dx * dx + dy * dy <= 800 * 800, `${event.projectileId} shooter is in turret action range`);
      }
      record.launches.push({
        tick: tick!,
        event: structuredClone(event),
        sourcePortId: caseState.sourcePortId,
        originGroupId: caseState.originGroupId,
        caseType: caseState.type,
      });
      record.launchRoutes.set(event.projectileId, event.route);
    }
  }
  for (const caseState of Object.values(state.battleCases)) {
    if (caseState.location !== "carried" || !caseState.ownerActorId || !caseState.currentPosition) continue;
    const positions = record.carriedPositions.get(caseState.id) ?? new Set<string>();
    positions.add(`${caseState.currentPosition.x},${caseState.currentPosition.y}`);
    record.carriedPositions.set(caseState.id, positions);
  }
}

/** Every case must have exactly one physical owner/location at all times. */
function assertCaseOwnership(state: BattleState): void {
  const listed = new Map<string, string>();
  const listOnce = (caseId: string, where: string): void => {
    assert.ok(state.battleCases[caseId], `${where} references an existing case`);
    assert.equal(listed.has(caseId), false, `${caseId} is listed twice (${listed.get(caseId)} and ${where})`);
    listed.set(caseId, where);
  };
  for (const actor of Object.values(state.actors)) {
    assert.equal(new Set(actor.cargoIds).size, actor.cargoIds.length, `${actor.id} has duplicate cargo ids`);
    for (const caseId of actor.cargoIds) {
      const caseState = state.battleCases[caseId];
      assert.equal(caseState?.location, "carried", `${actor.id} cargo is carried`);
      assert.equal(caseState?.ownerActorId, actor.id, `${caseId} owner is ${actor.id}`);
      listOnce(caseId, `${actor.id}.cargoIds`);
    }
    const slots = state.cargoSlots[actor.id] ?? [null, null];
    assert.equal(slots.length, 2, `${actor.id} has stable two cargo slots`);
    for (const caseId of slots) if (caseId !== null) {
      assert.ok(actor.cargoIds.includes(caseId), `${caseId} slot belongs to ${actor.id}`);
      assert.equal(slots.filter((candidate) => candidate === caseId).length, 1, `${caseId} occupies one slot for ${actor.id}`);
    }
    for (const caseId of actor.cargoIds) assert.equal(slots.includes(caseId), true, `${caseId} cargo is represented by a slot for ${actor.id}`);
  }
  for (const turret of Object.values(state.artillery.turrets)) {
    assert.equal(new Set(turret.queueIds).size, turret.queueIds.length, `${turret.team}:${turret.id} queue has no duplicates`);
    assert.equal(new Set(turret.handoffIds).size, turret.handoffIds.length, `${turret.team}:${turret.id} handoff has no duplicates`);
    assert.equal(turret.stagingSlots.length, 2, `${turret.team}:${turret.id} has two stable staging slots`);
    const staged = new Set<string>();
    for (const [slotIndex, caseId] of turret.stagingSlots.entries()) {
      if (caseId === null) continue;
      assert.equal(staged.has(caseId), false, `${caseId} occupies two staging slots`);
      staged.add(caseId);
      const caseState = state.battleCases[caseId];
      assert.equal(caseState?.location, "handoff", `${caseId} staging slot location`);
      assert.equal(caseState?.turretId, turret.id, `${caseId} staging slot turret`);
      assert.equal(caseState?.stagingSlot, slotIndex, `${caseId} retains physical staging slot ${slotIndex}`);
      assert.ok(turret.handoffIds.includes(caseId), `${caseId} staging slot is listed by handoffIds`);
      listOnce(caseId, `${turret.team}:${turret.id}.stagingSlots[${slotIndex}]`);
    }
    for (const caseId of turret.queueIds) {
      const caseState = state.battleCases[caseId];
      assert.equal(caseState?.location, "queue", `${caseId} queue location`);
      assert.equal(caseState?.turretId, turret.id, `${caseId} queue turret`);
      listOnce(caseId, `${turret.team}:${turret.id}.queue`);
    }
    for (const caseId of turret.handoffIds) {
      const caseState = state.battleCases[caseId];
      assert.equal(caseState?.location, "handoff", `${caseId} handoff location`);
      assert.equal(caseState?.turretId, turret.id, `${caseId} handoff turret`);
      assert.ok(staged.has(caseId), `${caseId} handoff retains a physical staging slot`);
    }
  }
  for (const flight of Object.values(state.artillery.flights)) {
    const caseState = state.battleCases[flight.objectId];
    assert.equal(caseState?.location, "flying", `${flight.id} flying location`);
    assert.equal(caseState?.flightId, flight.id, `${flight.id} case link`);
    listOnce(flight.objectId, `${flight.id}.objectId`);
  }
  for (const caseState of Object.values(state.battleCases)) {
    assert.ok(state.logistics.groups[caseState.originGroupId], `${caseState.id} origin group exists`);
    if (caseState.location === "carried" || caseState.location === "handoff" || caseState.location === "queue" || caseState.location === "flying") {
      assert.equal(listed.get(caseState.id) !== undefined, true, `${caseState.id} active case has one owner list`);
    } else {
      assert.equal(listed.has(caseState.id), false, `${caseState.id} floor/consumed case is not owned twice`);
    }
  }
  for (const team of ["player", "enemy"] as const) {
    const activeGroups = Object.values(state.logistics.groups).filter((group) => group.team === team && !group.retired).length;
    assert.ok(activeGroups <= MAX_LIVE_SOURCE_GROUPS_PER_TEAM, `${team} source vehicle keeps its four-port live group cap`);
  }
}

function assertGatePrefix(state: BattleState, team: TeamId): void {
  const castle = state.castles[team];
  assert.equal(castle.destroyedPartIds.length, castle.openGateIds.length, `${team} destroyed parts equal open gates`);
  assert.deepEqual(castle.openGateIds, GATE_IDS.slice(0, castle.destroyedPartIds.length), `${team} gates remain a prefix`);
  for (const partId of PART_IDS) {
    assert.equal(castle.exterior[partId].destroyed, castle.destroyedPartIds.includes(partId), `${team} ${partId} destroyed index agrees`);
  }
}

function nextEnemyPart(state: BattleState): (typeof PART_IDS)[number] {
  return PART_IDS.find((partId) => !state.castles.enemy.exterior[partId].destroyed) ?? "P1";
}

function runClockAtHz(hz: number): BattleState {
  let state = createBattle({ matchId: "r2a-clock", seed: 20260913 });
  const clock = new SessionClock();
  clock.advance(0);
  for (let frame = 1; frame <= hz * 10; frame += 1) {
    const result = clock.advance(frame * 1000 / hz);
    for (let tick = 0; tick < result.ticks; tick += 1) {
      const direction: BattleDirection = state.tick < 60 ? { x: 1, y: 0 } : state.tick < 120 ? { x: -1, y: 0 } : NEUTRAL;
      state = stepBattle(state, publicP1Intent(state, { direction }));
    }
  }
  return state;
}

test("R2a flow keeps 33 actors and carries real supply into all enemy turrets", { timeout: 180_000 }, () => {
  const matchId = "r2a-flow-long";
  const seed = 20260913;
  const benchmarkStart = performance.now();
  let benchmark = createBattle({ matchId: "r2a-flow-benchmark", seed });
  for (let tick = 0; tick < 1000; tick += 1) benchmark = stepBattle(benchmark, publicP1Intent(benchmark, { direction: NEUTRAL }));
  const benchmarkMs = performance.now() - benchmarkStart;
  assert.equal(benchmark.tick, 1000);

  let state = createBattle({ matchId, seed });
  const initialActorIds = Object.keys(state.actors).sort();
  const record: FlowRecord = {
    events: [],
    launches: [],
    spawns: new Map(),
    moveKinds: new Map(),
    carriedPositions: new Map(),
    launchRoutes: new Map(),
    benchmarkMs,
  };
  let phase: FlowPhase = "to-pickup";
  let deliveryCount = 0;
  const phaseAtEnd: FlowPhase[] = [];
  const longRunStart = performance.now();
  const longRunTicks = 25_000;

  assert.equal(initialActorIds.length, 33);
  assert.deepEqual(initialActorIds, [
    ...PLAYER_ACTORS,
    ...Array.from({ length: 30 }, (_, index) => `E${String(index + 1).padStart(2, "0")}`),
  ].sort());
  assert.deepEqual(Object.values(state.artillery.turrets).filter((turret) => turret.team === "enemy").flatMap((turret) => turret.operatorActorIds).sort(), [...ENEMY_SHOOTERS].sort());
  assert.equal(Object.values(state.logistics.ports).filter((port) => port.team === "player").length, 4);
  assert.equal(Object.values(state.logistics.ports).filter((port) => port.team === "enemy").length, 4);
  assert.deepEqual(state.fixedActors.P1.position, { x: 92_500, y: 33_500 });
  assertP1AuthoredFloorRoute(state);

  for (let tick = 0; tick < longRunTicks; tick += 1) {
    let intent: BattleIntent = publicP1Intent(state, { direction: NEUTRAL });
    if (phase === "to-pickup" || phase === "repick-first") {
      const interaction = getInteraction(state, "P1", 0);
      if (interaction.handles.includes("pickup")) {
        intent = publicP1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken });
      } else if (phase === "repick-first") {
        // The first drop is intentionally followed by a fresh public pickup
        // token at the same physical point; do not walk away while waiting.
        intent = publicP1Intent(state, { direction: NEUTRAL });
      } else {
        intent = publicP1Intent(state, { direction: p1ToAmmoDirection(state, deliveryCount === 0) });
      }
    } else if (phase === "drop-first") {
      const interaction = getInteraction(state, "P1", 0);
      if (interaction.handles.includes("drop")) {
        intent = publicP1Intent(state, { handle: "drop", slot: 0, contextToken: interaction.contextToken });
      }
    } else if (phase === "to-turret") {
      const interaction = getInteraction(state, "P1", 0);
      if (interaction.handles.includes("deliver")) {
        intent = publicP1Intent(state, {
          handle: "deliver",
          slot: 0,
          route: deliveryCount % 2 === 0 ? "detour" : "direct",
          part: nextEnemyPart(state),
          contextToken: interaction.contextToken,
        });
      } else {
        intent = publicP1Intent(state, { direction: p1ToTurretDirection(state) });
      }
    }

    state = stepBattle(state, intent);
    recordStep(state, record);
    assertCaseOwnership(state);
    assertGatePrefix(state, "player");
    assertGatePrefix(state, "enemy");
    assert.equal(Object.keys(state.actors).length, 33, "AI never adds or removes a combatant");
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) {
      if (phase === "to-pickup" && deliveryCount === 0) phase = "drop-first";
      else if (phase === "to-pickup" || phase === "repick-first") phase = "to-turret";
    }
    if (state.lastStep.acceptedInputKinds.includes("handle:drop") && phase === "drop-first") phase = "repick-first";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveryCount += 1;
      phase = deliveryCount < P1_DELIVERY_TARGET ? "to-pickup" : "done";
    }
    phaseAtEnd.push(phase);
  }
  const longRunMs = performance.now() - longRunStart;
  const launchesByTeam = (team: TeamId) => record.launches.filter((launch) => launch.event.team === team);
  const enemyLaunches = launchesByTeam("enemy");
  const playerLaunches = launchesByTeam("player");
  const lastLaunchTick = Object.fromEntries(([
    "player", "enemy",
  ] as const).map((team) => [team, launchesByTeam(team).at(-1)?.tick ?? -1])) as Record<TeamId, number>;
  const lateLaunchCutoff = longRunTicks - 5_000;
  const allEvents = record.events.map((entry) => entry.event);
  const interceptions = allEvents.filter((event): event is Extract<WorldEvent, { type: "projectile_intercepted" }> => event.type === "projectile_intercepted");
  const partDamageByTeam = Object.fromEntries(([
    "player", "enemy",
  ] as const).map((team) => [team, allEvents.filter((event): event is Extract<WorldEvent, { type: "part_damaged" }> => event.type === "part_damaged" && event.team === team).length])) as Record<TeamId, number>;

  const summary = {
    scenario: "r2a-flow",
    seed,
    benchmarkTicks: 1000,
    benchmarkMs: Number(record.benchmarkMs.toFixed(1)),
    longRunTicks,
    longRunMs: Number(longRunMs.toFixed(1)),
    p1Deliveries: deliveryCount,
    launches: { player: playerLaunches.length, enemy: enemyLaunches.length },
    lastLaunchTick,
    lateLaunchCutoff,
    interceptions: interceptions.length,
    partDamageByTeam,
    gates: { player: state.castles.player.openGateIds.length, enemy: state.castles.enemy.openGateIds.length },
    outcome: state.outcome,
    finalPhase: phaseAtEnd.at(-1),
  };
  console.info(JSON.stringify(summary));
  assert.equal(phase, "done", `P1 completed ${P1_DELIVERY_TARGET} public supply deliveries (got ${deliveryCount})`);
  assert.ok([...record.spawns.values()].some((spawn) => spawn.team === "player"), "player produced real supply cases");
  assert.ok([...record.spawns.values()].some((spawn) => spawn.team === "enemy"), "enemy produced real supply cases");
  assert.ok(record.carriedPositions.get(record.launches.find((launch) => launch.event.team === "player")?.event.objectId ?? "")?.size && (record.carriedPositions.get(record.launches.find((launch) => launch.event.team === "player")?.event.objectId ?? "")?.size ?? 0) > 2, "a player case visibly walked while carried");
  assert.ok([...record.carriedPositions.entries()].some(([caseId, positions]) => caseId.startsWith("case-enemy-") && positions.size > 2), "an enemy case visibly walked from supply to a turret");
  assert.ok(enemyLaunches.length >= 16, `enemy AI keeps launching after the opening cycle (got ${enemyLaunches.length})`);
  assert.ok(playerLaunches.length >= P1_DELIVERY_TARGET, `player-side support AI and P1 keep launching (got ${playerLaunches.length})`);
  assert.ok(lastLaunchTick.player >= lateLaunchCutoff, `player artillery remains live after tick ${lateLaunchCutoff} (last ${lastLaunchTick.player})`);
  assert.ok(lastLaunchTick.enemy >= lateLaunchCutoff, `enemy artillery remains live after tick ${lateLaunchCutoff} (last ${lastLaunchTick.enemy})`);
  assert.deepEqual(new Set(enemyLaunches.map((launch) => launch.event.turretId)), new Set(["T1", "T2", "T3", "T4"]), "every dedicated enemy turret reaches a launch");
  const playerSources = new Set(playerLaunches.map((launch) => launch.event.sourceActorId));
  assert.ok(playerSources.has("P1"), "the public P1 operator launches a real supplied case");
  assert.ok([...playerSources].every((id) => PLAYER_ACTORS.includes(id as (typeof PLAYER_ACTORS)[number])), "player launches come only from P1/P2/P3 operators");
  assert.equal(new Set(record.launches.map((launch) => launch.event.route)).size, 2, "both direct and detour routes are exercised");
  assert.ok(interceptions.length > 0, "opposing projectiles meet on a shared route");
  for (const interception of interceptions) {
    const firstRoute = record.launchRoutes.get(interception.firstProjectileId);
    const secondRoute = record.launchRoutes.get(interception.secondProjectileId);
    assert.ok(firstRoute && secondRoute, "interception points back to launch records");
    assert.equal(firstRoute, secondRoute, "only the same route can intercept");
  }
  for (const team of ["player", "enemy"] as const) {
    const launchTicks = launchesByTeam(team).map((launch) => launch.tick);
    for (let index = 1; index < launchTicks.length; index += 1) {
      assert.ok(launchTicks[index] - launchTicks[index - 1] >= 48, `${team} shared launch slot is at least 48 ticks`);
    }
  }
  for (const launch of record.launches) {
    const spawn = record.spawns.get(launch.event.objectId);
    assert.ok(spawn, `${launch.event.objectId} has a spawn event`);
    assert.equal(spawn?.portId, launch.sourcePortId, `${launch.event.objectId} keeps source port lineage`);
    assert.equal(launch.originGroupId.startsWith(`group-${launch.event.team}-`), true, `${launch.event.objectId} group is team-scoped`);
    assert.equal(launch.event.sourceActorId.startsWith(launch.event.team === "enemy" ? "E" : "P"), true, `${launch.event.objectId} operator belongs to its team`);
    const sequence = record.moveKinds.get(launch.event.objectId) ?? [];
    const queueIndex = sequence.findIndex((entry) => entry.kind === "queue");
    assert.ok(queueIndex >= 0, `${launch.event.objectId} reached a queue`);
    const shooterPickup = sequence.findIndex((entry, index) => index < queueIndex && entry.kind === "carried" && entry.actorId === launch.event.sourceActorId);
    assert.ok(shooterPickup >= 0, `${launch.event.objectId} was picked up by its live operator before queueing`);
  }
  assert.equal(state.outcome, "ongoing", "R2a never resolves an invasion/core victory");
  assert.equal(state.phase, "running", "R2a remains a running battle after artillery work");
  assert.ok(partDamageByTeam.player > 0, "enemy projectiles produce real player exterior damage");
  assert.ok(partDamageByTeam.enemy > 0, "player projectiles produce real enemy exterior damage");
  // Gate updates remain prefix-checked on every tick above; R2a does not
  // resolve a core victory, so full seven-gate destruction is covered by the
  // dedicated exterior/gate rule tests rather than required here.
  const launchedParts = new Set(record.launches.map((launch) => launch.event.targetPart).filter((part): part is (typeof PART_IDS)[number] => part !== undefined));
  assert.ok(launchedParts.size >= 1, "real launches retain a validated partP1..partP7 target");
  assert.ok([...launchedParts].every((part) => PART_IDS.includes(part)), "launch targets remain within partP1..partP7");
  assert.equal(initialActorIds.length, Object.keys(state.actors).length, "actor population remains fixed over long run");
});

test("R2a fixed battle state is identical through 30/60/120Hz SessionClock ticks", () => {
  const at30 = runClockAtHz(30);
  const at60 = runClockAtHz(60);
  const at120 = runClockAtHz(120);
  assert.equal(at30.tick, 600);
  assert.equal(at60.tick, 600);
  assert.equal(at120.tick, 600);
  assert.deepEqual(at30, at60);
  assert.deepEqual(at60, at120);
});
