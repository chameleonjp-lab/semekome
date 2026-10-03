import { createPracticeProgress } from "../../src/presentation/practice-progress.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { caseDefinition } from "../../src/content/cases.ts";
import {
  createBattle,
  getInteraction,
  stepBattle,
  type BattleDirection,
  type BattleIntent,
  type BattleState,
} from "../../src/simulation/physical-battle.ts";

const NEUTRAL: BattleDirection = { x: 0, y: 0 };
const PLAZA_Y = 35_500;
const P1_AMMO_APPROACH_X = 94_500;
const P1_AMMO_PICKUP_Y = 12_500;
const P1_TURRET_TRAVEL_Y = 12_000;
const P1_TURRET_APPROACH_X = 105_850;
const P1_EXIT_ROUTE_Y = 25_500;
const P1_EXIT_X = 123_500;
const PLAZA_GUARD_IDS = ["E25", "E26", "E27"] as const;
const STANDARD_ALLOCATION = [
  "standard_slug", "standard_slug", "standard_slug",
  "dense_payload", "dense_payload", "screen_panel", "screen_panel", "fast_dart",
] as const;

function publicP1Intent(state: BattleState, partial: Partial<BattleIntent> = {}): BattleIntent {
  // Use the current public support controls: escort through the plaza, then
  // return to artillery while P1 advances through the opened gate prefix.
  const p1 = state.actors.P1;
  const position = state.fixedActors.P1.position;
  const leavingHome = p1.location.castleTeam === "player" && position.x > 105_000 && position.y > 20_000;
  const kind = leavingHome || p1.location.area === "plaza" || p1.location.pathGates.length === 0 ? "follow" : "artillery";
  const part = (Object.keys(state.castles.enemy.exterior) as Array<keyof typeof state.castles.enemy.exterior>)
    .find(id => !state.castles.enemy.exterior[id].destroyed) ?? "P7";
  const allyId = leavingHome || p1.location.area === "plaza" || p1.location.castleTeam === "enemy"
    ? (["P2", "P3"] as const).find(id => state.actors[id].alive && (state.allyOrders[id]?.kind !== kind || kind === "artillery" &&
      (state.allyOrders[id]?.route !== "detour" || state.allyOrders[id]?.part !== part)))
    : undefined;
  return {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    ...(allyId ? { allyCommand: { allyId, kind, ...(kind === "artillery" ? { route: "detour" as const, part } : {}) } } : {}),
    ...partial,
  };
}

function sign(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function p1ToAmmoDirection(state: BattleState, firstPickup: boolean): BattleDirection {
  const position = state.fixedActors.P1.position;
  // Cases now spawn on walkable cells around the port. Approach the actual
  // floor case from above the equipment instead of walking into its body.
  const candidate = Object.values(state.battleCases)
    .filter(item => item.currentTeam === "player" && item.location === "floor" && item.roomId === "ammo_a")
    .sort((a, b) => a.createdTick - b.createdTick || a.id.localeCompare(b.id))[0];
  const target = candidate?.position ?? { x: P1_AMMO_APPROACH_X, y: P1_AMMO_PICKUP_Y };
  const sign = (value: number): -1 | 0 | 1 => value > 0 ? 1 : value < 0 ? -1 : 0;
  if (position.y > 25_500 && Math.abs(position.x - P1_AMMO_APPROACH_X) > 50)
    return { x: sign(P1_AMMO_APPROACH_X - position.x), y: 0 };
  if (Math.abs(position.x - target.x) > 50) {
    if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
    return { x: sign(target.x - position.x), y: 0 };
  }
  return { x: 0, y: sign(target.y - position.y) };
}

function isNearPlayerTurret(state: BattleState): boolean {
  const turret = state.artillery.turrets["player:T1"];
  const position = state.fixedActors.P1.position;
  return (position.x - turret.position.x) ** 2 + (position.y - turret.position.y) ** 2 <= 800 ** 2;
}

function p1ToTurretDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (position.x < P1_TURRET_APPROACH_X - 50) {
    if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
    return { x: 1, y: 0 };
  }
  if (!isNearPlayerTurret(state)) return { x: 0, y: 1 };
  return NEUTRAL;
}

function p1ToPlazaDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  // A delayed siege impact can finish while P1 is collecting the next case.
  // Leave the ammo equipment via its clear upper edge before heading south.
  if (position.y < 20_000 && position.x < P1_AMMO_APPROACH_X - 50) {
    if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
    return { x: 1, y: 0 };
  }
  if (Math.abs(position.x - P1_EXIT_X) > 50) {
    if (Math.abs(position.y - P1_EXIT_ROUTE_Y) > 50) return { x: 0, y: sign(P1_EXIT_ROUTE_Y - position.y) };
    return { x: sign(P1_EXIT_X - position.x), y: 0 };
  }
  if (Math.abs(position.y - PLAZA_Y) > 50) return { x: 0, y: sign(PLAZA_Y - position.y) };
  return { x: 1, y: 0 };
}

function p1FromRespawnToPlazaDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (Math.abs(position.y - PLAZA_Y) > 50) return { x: 0, y: sign(PLAZA_Y - position.y) };
  if (position.x < 66_500) return { x: 1, y: 0 };
  if (Math.abs(position.x - P1_EXIT_X) > 50) return { x: sign(P1_EXIT_X - position.x), y: 0 };
  return { x: 1, y: 0 };
}

function p1ToEnemyCastleDirection(state: BattleState): BattleDirection {
  const enemyPlazaEdgeX = state.layout.plaza.x1 * 1_000 - 500;
  const direction = {
    x: sign(enemyPlazaEdgeX - state.fixedActors.P1.position.x),
    y: sign(PLAZA_Y - state.fixedActors.P1.position.y),
  };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

function p1ToActorDirection(state: BattleState, actorId: string): BattleDirection {
  const position = state.fixedActors.P1.position;
  const target = state.fixedActors[actorId]?.position;
  if (!target) {
    if (PLAZA_GUARD_IDS.some((guardId) => state.actors[guardId].alive)) return NEUTRAL;
    return p1ToEnemyCastleDirection(state);
  }
  // Cardinal weapons need a firing lane; diagonal pursuit is not aiming.
  const dx = target.x - position.x, dy = target.y - position.y;
  const direction: BattleDirection = Math.abs(dy) > 300 && Math.abs(dx) > 300
    ? { x: 0, y: sign(dy) }
    : Math.abs(dx) >= Math.abs(dy) ? { x: sign(dx), y: 0 } : { x: 0, y: sign(dy) };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

function nearestEnemyInP1Room(state: BattleState): string | undefined {
  const player = state.actors.P1;
  const position = state.fixedActors.P1.position;
  const target = Object.values(state.actors)
    .filter((actor) => actor.team === "enemy" && actor.alive && actor.location.area === player.location.area &&
      actor.currentRoomId === player.currentRoomId && actor.location.castleTeam === player.location.castleTeam &&
      Math.hypot(state.fixedActors[actor.id].position.x - position.x, state.fixedActors[actor.id].position.y - position.y) <= 8_000)
    .sort((left, right) => {
      const leftPosition = state.fixedActors[left.id].position;
      const rightPosition = state.fixedActors[right.id].position;
      return (leftPosition.x - position.x) ** 2 + (leftPosition.y - position.y) ** 2 -
        ((rightPosition.x - position.x) ** 2 + (rightPosition.y - position.y) ** 2) || left.id.localeCompare(right.id);
    })[0];
  if (!target) return undefined;
  const targetPosition = state.fixedActors[target.id].position;
  const engagementRange = 8_000;
  return (targetPosition.x - position.x) ** 2 + (targetPosition.y - position.y) ** 2 <= engagementRange ** 2
    ? target.id
    : undefined;
}

function nearestLiveGuardId(state: BattleState): (typeof PLAZA_GUARD_IDS)[number] | undefined {
  const position = state.fixedActors.P1.position;
  return PLAZA_GUARD_IDS
    .map((actorId) => state.actors[actorId])
    .filter((actor) => actor.alive && actor.location.area === "plaza")
    .map((actor) => ({ actor, position: state.fixedActors[actor.id]!.position }))
    .sort((left, right) => {
      const leftDistance = (left.position.x - position.x) ** 2 + (left.position.y - position.y) ** 2;
      const rightDistance = (right.position.x - position.x) ** 2 + (right.position.y - position.y) ** 2;
      return leftDistance - rightDistance || left.actor.id.localeCompare(right.actor.id);
    })[0]?.actor.id as (typeof PLAZA_GUARD_IDS)[number] | undefined;
}

function p1ToNearestGuardDirection(state: BattleState, preferredGuardId?: (typeof PLAZA_GUARD_IDS)[number]): BattleDirection {
  const position = state.fixedActors.P1.position;
  const candidates = PLAZA_GUARD_IDS
    .map((actorId) => state.actors[actorId])
    .filter((actor) => actor.alive && actor.location.area === "plaza")
    .map((actor) => ({ actor, position: state.fixedActors[actor.id].position }));
  const preferred = preferredGuardId ? candidates.find((candidate) => candidate.actor.id === preferredGuardId) : undefined;
  const target = preferred ?? candidates.sort((left, right) => {
    const healthDelta = left.actor.health - right.actor.health;
    const leftDistance = (left.position.x - position.x) ** 2 + (left.position.y - position.y) ** 2;
    const rightDistance = (right.position.x - position.x) ** 2 + (right.position.y - position.y) ** 2;
    return healthDelta || leftDistance - rightDistance || left.actor.id.localeCompare(right.actor.id);
  })[0];
  if (!target) return p1ToEnemyCastleDirection(state);
  const laneY = preferredGuardId
    ? Math.max(state.layout.plaza.y0 * 1_000 + 1_000, target.position.y - 7_000)
    : target.position.y;
  if (Math.abs(target.position.x - position.x) > 50) {
    if (Math.abs(position.y - laneY) > 50) return { x: 0, y: sign(laneY - position.y) };
    return { x: sign(target.position.x - position.x), y: 0 };
  }
  if (Math.abs(target.position.y - position.y) > 50) return { x: 0, y: sign(target.position.y - position.y) };
  const direction = { x: sign(target.position.x - position.x), y: sign(target.position.y - position.y) };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

for (const seed of [20260913, 20260914, 20260916]) test(`seed ${seed} の標準配分通常ルートでP1が7門を越え、有効なコア射撃で勝利する`, { timeout: 300_000 }, () => {
  const practiceProgress = createPracticeProgress("core");
  let practiceAchieved = false;
  let state = createBattle({ matchId: "r2af-standard-player-core-victory", seed });
  assert.deepEqual(state.logistics.playerAllocation, STANDARD_ALLOCATION);
  const initialP3Health = state.castles.enemy.exterior.P3.health;
  const coreRoom = state.layout.enemy.rooms.find((room) => room.id === "core");
  assert.ok(coreRoom, "enemy core room is authored");
  const coreCenter = {
    x: Math.round((coreRoom.rect.x0 + coreRoom.rect.x1) * 500),
    y: Math.round((coreRoom.rect.y0 + coreRoom.rect.y1) * 500),
  };
  for (const actorId of ["P1", "P2", "P3", ...PLAZA_GUARD_IDS] as const) {
    assert.equal(state.actors[actorId].protectedUntilTick, null, actorId + " starts without test protection");
  }

  let phase: "pickup" | "turret" | "plaza-route" | "return-plaza" | "combat" | "gate-route" | "core-route" = "pickup";
  let deliveries = 0;
  let reachedPlaza = false;
  let crossedG1 = false;
  let crossedG2 = false;
  let crossedG3 = false;
  let crossedG4 = false;
  let crossedG5 = false;
  let crossedG6 = false;
  let crossedG7 = false;
  let p2DestructionTick: number | null = null;
  let g2CrossingTick: number | null = null;
  let p3SupportLaunchTick: number | null = null;
  let p3SupportImpactTick: number | null = null;
  let p3SupportImpactDamage = 0;
  let p3DestructionTick: number | null = null;
  let g3OpenTick: number | null = null;
  let g3CrossingTick: number | null = null;
  let p4SupportLaunchTick: number | null = null;
  let p4SupportImpactTick: number | null = null;
  let p4SupportImpactDamage = 0;
  let p4DestructionTick: number | null = null;
  let g4OpenTick: number | null = null;
  let g4CrossingTick: number | null = null;
  let p5SupportLaunchTick: number | null = null;
  let p5SupportImpactTick: number | null = null;
  let p5SupportImpactDamage = 0;
  let p5DestructionTick: number | null = null;
  let g5OpenTick: number | null = null;
  let g5CrossingTick: number | null = null;
  let p6SupportLaunchTick: number | null = null;
  let p6SupportImpactTick: number | null = null;
  let p6SupportImpactDamage = 0;
  let p6DestructionTick: number | null = null;
  let g6OpenTick: number | null = null;
  let g6CrossingTick: number | null = null;
  let p7SupportLaunchTick: number | null = null;
  let p7SupportImpactTick: number | null = null;
  let p7SupportImpactDamage = 0;
  let p7DestructionTick: number | null = null;
  let g7OpenTick: number | null = null;
  let g7CrossingTick: number | null = null;
  let supportDetourP2Launches = 0;
  let supportDetourP2Impacts = 0;
  let supportDetourP2Interceptions = 0;
  let p1AwaySupportLaunches = 0;
  let attackCount = 0;
  let corridorDashCount = 0;
  let coreShotIntentCount = 0;
  let coreContactCount = 0;
  let focusGuardId: (typeof PLAZA_GUARD_IDS)[number] | undefined;
  const guardDamage: Record<(typeof PLAZA_GUARD_IDS)[number], number> = { E25: 0, E26: 0, E27: 0 };
  const damagingSupportLaunchTicks = new Map<string, number>();
  const supportP2ProjectileIds = new Set<string>();
  const supportP3ProjectileIds = new Set<string>();
  const supportP4ProjectileIds = new Set<string>();
  const supportP5ProjectileIds = new Set<string>();
  const supportP6ProjectileIds = new Set<string>();
  const supportP7ProjectileIds = new Set<string>();

  for (let tick = 0; tick < state.matchLimitTicks && state.phase === "running"; tick += 1) {
    if (state.actors.P1.location.area === "castle" && state.actors.P1.location.castleTeam === "enemy" &&
        state.actors.P1.currentRoomId === "corridor_2" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2") {
      crossedG2 = true;
      g2CrossingTick ??= state.tick;
    }
    if (state.actors.P1.location.area === "castle" && state.actors.P1.location.castleTeam === "enemy" &&
        state.actors.P1.currentRoomId === "corridor_3" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3") {
      crossedG3 = true;
      g3CrossingTick ??= state.tick;
    }
    if (state.actors.P1.location.area === "castle" && state.actors.P1.location.castleTeam === "enemy" &&
        state.actors.P1.currentRoomId === "corridor_4" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3,G4") {
      crossedG4 = true;
      g4CrossingTick ??= state.tick;
    }
    if (state.actors.P1.location.area === "castle" && state.actors.P1.location.castleTeam === "enemy" &&
        state.actors.P1.currentRoomId === "corridor_5" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3,G4,G5") {
      crossedG5 = true;
      g5CrossingTick ??= state.tick;
    }
    if (state.actors.P1.location.area === "castle" && state.actors.P1.location.castleTeam === "enemy" &&
        state.actors.P1.currentRoomId === "corridor_6" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3,G4,G5,G6") {
      crossedG6 = true;
      g6CrossingTick ??= state.tick;
    }
    if (state.actors.P1.location.area === "castle" && state.actors.P1.location.castleTeam === "enemy" &&
        state.actors.P1.currentRoomId === "core" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3,G4,G5,G6,G7") {
      crossedG7 = true;
      g7CrossingTick ??= state.tick;
      phase = "core-route";
    }
    // Continue observing artillery, deaths and gates throughout P1's five-second spectating period.
    const p1WasAlive = state.actors.P1.alive;

    if (phase === "combat" && state.actors.P1.location.area !== "plaza") phase = "return-plaza";
    if (state.tick % 3000 === 0) console.info(JSON.stringify({ scenario: "standard-support-progress", seed, tick: state.tick,
      phase, gates: state.castles.enemy.openGateIds, supportLaunches: p1AwaySupportLaunches,
      supports: (["P2", "P3"] as const).map(id => ({ id, order: state.allyOrders[id]?.kind, room: state.actors[id].currentRoomId,
        area: state.actors[id].location.area, team: state.actors[id].location.castleTeam,
        position: state.fixedActors[id].position, task: state.crew.assignments[id]?.task })) }));
    const startPosition = state.fixedActors.P1.position;
    const turretPosition = state.artillery.turrets["player:T1"].position;
    const p1AwayFromTurret = Math.hypot(startPosition.x - turretPosition.x, startPosition.y - turretPosition.y) > 800;
    let nextState: BattleState;
    const plazaThreat = state.actors.P1.location.area === "plaza" ? nearestEnemyInP1Room(state) : undefined;
    const regroupAtEnemyEntrance = state.actors.P1.location.area === "plaza" &&
      state.fixedActors.P1.position.x >= state.layout.plaza.x1 * 1_000 - 2_500 && !plazaThreat &&
      ["P2", "P3"].some(id => !state.actors[id].alive || state.actors[id].location.area !== "plaza" ||
        Math.hypot(state.fixedActors[id].position.x - state.fixedActors.P1.position.x, state.fixedActors[id].position.y - state.fixedActors.P1.position.y) > 1_500);
    if (!p1WasAlive) {
      nextState = stepBattle(state);
    } else if (regroupAtEnemyEntrance) {
      nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
    } else if (plazaThreat && !state.dashes.P1) {
      nextState = stepBattle(state, publicP1Intent(state, { direction: p1ToActorDirection(state, plazaThreat), shoot: true }));
      if (nextState.lastStep.acceptedInputKinds.includes("shoot")) attackCount += 1;
    } else if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      nextState = interaction.handles.includes("load")
        ? stepBattle(state, publicP1Intent(state, { handle: "load", slot: Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)), contextToken: interaction.contextToken }))
        : interaction.handles.includes("pickup")
          ? stepBattle(state, publicP1Intent(state, { handle: "pickup", slot: Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)), contextToken: interaction.contextToken }))
          : stepBattle(state, publicP1Intent(state, { direction: p1ToAmmoDirection(state, deliveries === 0) }));
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      nextState = interaction.handles.includes("deliver")
        ? stepBattle(state, publicP1Intent(state, { handle: "deliver", slot: Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)), route: "detour", part: "P1", contextToken: interaction.contextToken }))
        : stepBattle(state, publicP1Intent(state, { direction: p1ToTurretDirection(state) }));
    } else if (phase === "plaza-route" || phase === "return-plaza") {
      const position = state.fixedActors.P1.position;
      const regroup = position.x >= 122_500 && position.y >= 35_000 && ["P2", "P3"].some(id =>
        !state.actors[id].alive || state.actors[id].location.castleTeam !== "player" ||
        Math.hypot(state.fixedActors[id].position.x - position.x, state.fixedActors[id].position.y - position.y) > 1_500);
      nextState = stepBattle(state, publicP1Intent(state, {
        direction: regroup ? NEUTRAL : phase === "return-plaza" ? p1FromRespawnToPlazaDirection(state) : p1ToPlazaDirection(state),
      }));
    } else if (phase === "gate-route" || phase === "core-route") {
      const corridorPosition = state.fixedActors.P1.position;
      const inEntryCorridor = state.actors.P1.currentRoomId === "central_corridor";
      const candidateThreat = nearestEnemyInP1Room(state);
      // Advance on the lower authored lane, engaging only enemies that block
      // that lane instead of charging the central firing line or chasing patrols.
      const threatId = candidateThreat && (!inEntryCorridor ||
        state.fixedActors[candidateThreat].position.x >= corridorPosition.x - 500 &&
        Math.abs(state.fixedActors[candidateThreat].position.y - corridorPosition.y) < 800)
        ? candidateThreat : undefined;
      const corridorDirection: BattleDirection = corridorPosition.x < 3_500 ? { x: 1, y: 0 }
        : corridorPosition.x < 58_500
          ? Math.abs(corridorPosition.y - 43_500) > 50 ? { x: 0, y: sign(43_500 - corridorPosition.y) } : { x: 1, y: 0 }
          : Math.abs(corridorPosition.y - PLAZA_Y) > 50 ? { x: 0, y: sign(PLAZA_Y - corridorPosition.y) } : { x: 1, y: 0 };
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      const targetPosition = threatId ? state.fixedActors[threatId]?.position : undefined;
      const p1Position = state.fixedActors.P1.position;
      const distance = targetPosition ? Math.hypot(targetPosition.x - p1Position.x, targetPosition.y - p1Position.y) : Number.POSITIVE_INFINITY;
      const direction = threatId ? p1ToActorDirection(state, threatId) : inEntryCorridor ? corridorDirection : { x: 1, y: 0 } as BattleDirection;
      const dashReady = state.tick >= (state.dashCooldownUntilTick.P1 ?? 0);
      const isInEnemyCoreRoom = state.actors.P1.currentRoomId === "core" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3,G4,G5,G6,G7";
      if (state.dashes.P1) {
        nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
      } else if (threatId && dashReady && distance <= state.rules.dashDistanceSubunits + 1_000) {
        // This bounded mobility branch must precede the general threat branch.
        // Dash moves only: it never counts as a personal shot or damage.
        nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL, mobilityDash: direction }));
        if (nextState.lastStep.acceptedInputKinds.includes("mobilityDash")) corridorDashCount += 1;
      } else if (threatId) {
        nextState = stepBattle(state, publicP1Intent(state, { direction, shoot: true }));
        if (nextState.lastStep.acceptedInputKinds.includes("shoot")) attackCount += 1;
      } else if (phase === "core-route" && isInEnemyCoreRoom &&
          Math.abs(coreCenter.y - p1Position.y) > 50) {
        nextState = stepBattle(state, publicP1Intent(state, {
          direction: { x: 0, y: sign(coreCenter.y - p1Position.y) },
        }));
      } else if (phase === "core-route" && isInEnemyCoreRoom &&
          Math.abs(coreCenter.x - p1Position.x) <= 8_000) {
        const coreShotDirection = { x: sign(coreCenter.x - p1Position.x) || 1, y: 0 } as BattleDirection;
        coreShotIntentCount += 1;
        nextState = stepBattle(state, publicP1Intent(state, { direction: coreShotDirection, shoot: true }));
      } else {
        const coreApproachDirection = phase === "core-route" && isInEnemyCoreRoom
          ? { x: sign(coreCenter.x - p1Position.x), y: Math.abs(coreCenter.y - p1Position.y) > 50 ? sign(coreCenter.y - p1Position.y) : 0 } as BattleDirection
          : direction;
        nextState = stepBattle(state, publicP1Intent(state, { direction: coreApproachDirection }));
      }
    } else {
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      // A defeated generation respawns at its authored home pad after 20s;
      // home-castle guards do not recreate the old plaza blockade.  The
      // crossing decision therefore waits only for live guards physically in
      // the plaza, not for every actor generation to remain dead.
      const allGuardsClearedFromPlaza = PLAZA_GUARD_IDS.every((actorId) =>
        !state.actors[actorId].alive || state.actors[actorId].location.area !== "plaza");
      const dashReady = state.tick >= (state.dashCooldownUntilTick.P1 ?? 0);
      if (state.dashes.P1) {
        nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
      } else if (interaction.attackTargetId && PLAZA_GUARD_IDS.includes(interaction.attackTargetId as (typeof PLAZA_GUARD_IDS)[number])) {
        const targetId = interaction.attackTargetId;
        nextState = stepBattle(state, publicP1Intent(state, { direction: p1ToActorDirection(state, targetId), shoot: true }));
        if ((nextState.lastStep.acceptedInputKinds.includes("shoot") || nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact"))) attackCount += 1;
      } else if (allGuardsClearedFromPlaza) {
        if (!state.castles.enemy.openGateIds.includes("G1")) {
          nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
        } else {
          const direction = p1ToEnemyCastleDirection(state);
          // Walk with the two followers rather than outrunning the captured group.
          nextState = stepBattle(state, publicP1Intent(state, { direction }));
        }
      } else {
        if (!focusGuardId || !state.actors[focusGuardId].alive) focusGuardId = nearestLiveGuardId(state);
        const focusDirection = focusGuardId ? p1ToActorDirection(state, focusGuardId) : NEUTRAL;
        const focusPosition = focusGuardId ? state.fixedActors[focusGuardId]?.position : undefined;
        const focusDistance = focusPosition
          ? Math.hypot(focusPosition.x - state.fixedActors.P1.position.x, focusPosition.y - state.fixedActors.P1.position.y)
          : Number.POSITIVE_INFINITY;
        const focusActor = focusGuardId ? state.actors[focusGuardId] : undefined;
        const focusSharesPlazaSpace = focusActor?.location.area === "plaza" &&
          state.actors.P1.location.area === "plaza" && focusActor.currentRoomId === state.actors.P1.currentRoomId;
        if (focusGuardId && focusSharesPlazaSpace) {
          nextState = stepBattle(state, publicP1Intent(state, { direction: focusDirection, shoot: true }));
          if ((nextState.lastStep.acceptedInputKinds.includes("shoot") || nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact"))) attackCount += 1;
        } else if (focusGuardId && dashReady && focusDistance <= state.rules.dashDistanceSubunits + 1_000) {
          nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL, mobilityDash: focusDirection }));
          if ((nextState.lastStep.acceptedInputKinds.includes("shoot") || nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact"))) attackCount += 1;
        } else {
          nextState = stepBattle(state, publicP1Intent(state, { direction: p1ToNearestGuardDirection(state, focusGuardId) }));
        }
      }
    }

    if (nextState.lastStep.acceptedInputKinds.includes("bridge:core_contact")) coreContactCount += 1;
    if (process.env.SEMEKOME_ROUTE_DIAGNOSTICS && nextState.actors.P1.health < state.actors.P1.health) {
      const threat = nearestEnemyInP1Room(state);
      console.log(JSON.stringify({ scenario: "route-damage-diagnostic", seed, tick: state.tick, phase,
        position: state.fixedActors.P1.position, room: state.actors.P1.currentRoomId,
        healthBefore: state.actors.P1.health, healthAfter: nextState.actors.P1.health,
        facing: state.actorFacing.P1, accepted: nextState.lastStep.acceptedInputKinds,
        threat, threatPosition: threat ? state.fixedActors[threat].position : null,
        supportOrders: [state.allyOrders.P2?.kind, state.allyOrders.P3?.kind] }));
    }
    state = nextState;
    if (!p1WasAlive && state.actors.P1.alive) {
      focusGuardId = undefined;
      phase = deliveries === 0 ? "pickup" : "return-plaza";
    }
    practiceAchieved = practiceProgress.observe(state);
    let trackedP3ProjectileImpactedThisTick = false;
    let p3PartDamageThisTick = 0;
    let trackedP4ProjectileImpactedThisTick = false;
    let p4PartDamageThisTick = 0;
    let trackedP5ProjectileImpactedThisTick = false;
    let p5PartDamageThisTick = 0;
    let trackedP6ProjectileImpactedThisTick = false;
    let p6PartDamageThisTick = 0;
    let trackedP7ProjectileImpactedThisTick = false;
    let p7PartDamageThisTick = 0;
    for (const event of state.lastStep.events) {
      if (event.type === "actor_damaged" && PLAZA_GUARD_IDS.includes(event.actorId as (typeof PLAZA_GUARD_IDS)[number])) {
        guardDamage[event.actorId as (typeof PLAZA_GUARD_IDS)[number]] += event.amount;
      }
      if (event.type === "projectile_launched" && event.team === "player" &&
          (event.sourceActorId === "P2" || event.sourceActorId === "P3") && p1AwayFromTurret) {
        p1AwaySupportLaunches += 1;
      }
      if (event.type === "projectile_launched" && event.team === "player" &&
          (event.sourceActorId === "P2" || event.sourceActorId === "P3") &&
          event.route === "detour" && event.targetPart === "P2") {
        supportP2ProjectileIds.add(event.projectileId);
        supportDetourP2Launches += 1;
      }
      // A shell can be queued/launched before P1 crosses the previous gate.
      // Follow its real identity to its actual impact target, not pilot timing.
      if (event.type === "projectile_launched" && event.team === "player" &&
          (event.sourceActorId === "P2" || event.sourceActorId === "P3") && event.route === "detour" &&
          (caseDefinition(state.battleCases[event.objectId]?.type ?? "")?.partDamage ?? 0) > 0) {
        damagingSupportLaunchTicks.set(event.projectileId, state.tick);
      }
      if (event.type === "projectile_impacted" && event.targetTeam === "enemy" && damagingSupportLaunchTicks.has(event.projectileId)) {
        const launchedAt = damagingSupportLaunchTicks.get(event.projectileId)!;
        if (event.targetPart === "P3") { supportP3ProjectileIds.add(event.projectileId); p3SupportLaunchTick ??= launchedAt; }
        if (event.targetPart === "P4") { supportP4ProjectileIds.add(event.projectileId); p4SupportLaunchTick ??= launchedAt; }
        if (event.targetPart === "P5") { supportP5ProjectileIds.add(event.projectileId); p5SupportLaunchTick ??= launchedAt; }
        if (event.targetPart === "P6") { supportP6ProjectileIds.add(event.projectileId); p6SupportLaunchTick ??= launchedAt; }
        if (event.targetPart === "P7") { supportP7ProjectileIds.add(event.projectileId); p7SupportLaunchTick ??= launchedAt; }
      }
      if (event.type === "projectile_impacted" && supportP2ProjectileIds.has(event.projectileId) &&
          event.targetTeam === "enemy" && event.targetPart === "P2") {
        supportDetourP2Impacts += 1;
      }
      if (event.type === "projectile_impacted" && supportP3ProjectileIds.has(event.projectileId) &&
          event.targetTeam === "enemy" && event.targetPart === "P3") {
        p3SupportImpactTick ??= state.tick;
        trackedP3ProjectileImpactedThisTick = true;
      }
      if (event.type === "projectile_impacted" && supportP4ProjectileIds.has(event.projectileId) &&
          event.targetTeam === "enemy" && event.targetPart === "P4") {
        p4SupportImpactTick ??= state.tick;
        trackedP4ProjectileImpactedThisTick = true;
      }
      if (event.type === "projectile_impacted" && supportP5ProjectileIds.has(event.projectileId) &&
          event.targetTeam === "enemy" && event.targetPart === "P5") {
        p5SupportImpactTick ??= state.tick;
        trackedP5ProjectileImpactedThisTick = true;
      }
      if (event.type === "projectile_impacted" && supportP6ProjectileIds.has(event.projectileId) &&
          event.targetTeam === "enemy" && event.targetPart === "P6") {
        p6SupportImpactTick ??= state.tick;
        trackedP6ProjectileImpactedThisTick = true;
      }
      if (event.type === "projectile_impacted" && supportP7ProjectileIds.has(event.projectileId) &&
          event.targetTeam === "enemy" && event.targetPart === "P7") {
        p7SupportImpactTick ??= state.tick;
        trackedP7ProjectileImpactedThisTick = true;
      }
      if (event.type === "part_damaged" && event.team === "enemy" && event.partId === "P3") {
        p3PartDamageThisTick += event.amount;
      }
      if (event.type === "part_damaged" && event.team === "enemy" && event.partId === "P4") {
        p4PartDamageThisTick += event.amount;
      }
      if (event.type === "part_damaged" && event.team === "enemy" && event.partId === "P5") {
        p5PartDamageThisTick += event.amount;
      }
      if (event.type === "part_damaged" && event.team === "enemy" && event.partId === "P6") {
        p6PartDamageThisTick += event.amount;
      }
      if (event.type === "part_damaged" && event.team === "enemy" && event.partId === "P7") {
        p7PartDamageThisTick += event.amount;
      }
      if (event.type === "projectile_intercepted" &&
          (supportP2ProjectileIds.has(event.firstProjectileId) || supportP2ProjectileIds.has(event.secondProjectileId))) {
        supportDetourP2Interceptions += 1;
      }
      if (event.type === "part_destroyed" && event.team === "enemy" && event.partId === "P2") {
        p2DestructionTick = state.tick;
      }
      if (event.type === "part_destroyed" && event.team === "enemy" && event.partId === "P3") {
        p3DestructionTick = state.tick;
      }
      if (event.type === "part_destroyed" && event.team === "enemy" && event.partId === "P4") {
        p4DestructionTick = state.tick;
      }
      if (event.type === "part_destroyed" && event.team === "enemy" && event.partId === "P5") {
        p5DestructionTick = state.tick;
      }
      if (event.type === "part_destroyed" && event.team === "enemy" && event.partId === "P6") {
        p6DestructionTick = state.tick;
      }
      if (event.type === "part_destroyed" && event.team === "enemy" && event.partId === "P7") {
        p7DestructionTick = state.tick;
      }
    }
    if (trackedP3ProjectileImpactedThisTick) p3SupportImpactDamage += p3PartDamageThisTick;
    if (trackedP4ProjectileImpactedThisTick) p4SupportImpactDamage += p4PartDamageThisTick;
    if (trackedP5ProjectileImpactedThisTick) p5SupportImpactDamage += p5PartDamageThisTick;
    if (trackedP6ProjectileImpactedThisTick) p6SupportImpactDamage += p6PartDamageThisTick;
    if (trackedP7ProjectileImpactedThisTick) p7SupportImpactDamage += p7PartDamageThisTick;
    if (state.castles.enemy.openGateIds.includes("G3")) g3OpenTick ??= state.tick;
    if (state.castles.enemy.openGateIds.includes("G4")) g4OpenTick ??= state.tick;
    if (state.castles.enemy.openGateIds.includes("G5")) g5OpenTick ??= state.tick;
    if (state.castles.enemy.openGateIds.includes("G6")) g6OpenTick ??= state.tick;
    if (state.castles.enemy.openGateIds.includes("G7")) g7OpenTick ??= state.tick;
    if (focusGuardId && !state.actors[focusGuardId].alive) focusGuardId = undefined;
    if (phase === "pickup" && state.actors.P1.cargoIds.length > 0) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = deliveries < 4 ? "pickup" : "plaza-route";
    }
    if (state.actors.P1.location.area === "plaza") {
      reachedPlaza = true;
      phase = "combat";
    }
    if (state.actors.P1.location.area === "castle" && state.actors.P1.location.castleTeam === "enemy") {
      phase = crossedG7 ? "core-route" : "gate-route";
    }
    if (phase === "gate-route" && state.actors.P1.currentRoomId === "corridor_1") {
      crossedG1 = true;
    }
    if (phase === "gate-route" && state.actors.P1.currentRoomId === "corridor_2" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2") {
      crossedG2 = true;
      g2CrossingTick ??= state.tick;
    }
    if (phase === "gate-route" && state.actors.P1.currentRoomId === "corridor_3" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3") {
      crossedG3 = true;
      g3CrossingTick ??= state.tick;
    }
    if (phase === "gate-route" && state.actors.P1.currentRoomId === "corridor_4" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3,G4") {
      crossedG4 = true;
      g4CrossingTick ??= state.tick;
    }
    if (phase === "gate-route" && state.actors.P1.currentRoomId === "corridor_5" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3,G4,G5") {
      crossedG5 = true;
      g5CrossingTick ??= state.tick;
    }
    if (phase === "gate-route" && state.actors.P1.currentRoomId === "corridor_6" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3,G4,G5,G6") {
      crossedG6 = true;
      g6CrossingTick ??= state.tick;
    }
    if (phase === "gate-route" && state.actors.P1.currentRoomId === "core" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3,G4,G5,G6,G7") {
      crossedG7 = true;
      g7CrossingTick ??= state.tick;
    }
  }

  console.info(JSON.stringify({ scenario: "standard-public-shooting-victory", seed, tick: state.tick, outcome: state.outcome,
    phase, deliveries, playerDeaths: state.actors.P1.deathCount, playerRoom: state.actors.P1.currentRoomId,
    traversedGates: state.actors.P1.location.pathGates, enemyGates: state.castles.enemy.openGateIds,
    crossedG1, laterGateCrossingTicks: [ g2CrossingTick, g3CrossingTick, g4CrossingTick, g5CrossingTick, g6CrossingTick, g7CrossingTick],
    supportLaunches: p1AwaySupportLaunches, corridorDashCount, coreShots: coreShotIntentCount, coreContacts: coreContactCount,
    supports: (["P2", "P3"] as const).map(id => ({ id, order: state.allyOrders[id]?.kind,
      area: state.actors[id].location.area, castle: state.actors[id].location.castleTeam, room: state.actors[id].currentRoomId,
      position: state.fixedActors[id].position, task: state.crew.assignments[id]?.task, health: state.actors[id].health })) }));
  assert.ok(deliveries >= 4, "P1 stages at least four ordinary public deliveries before leaving the turret");
  assert.equal(reachedPlaza, true, "P1 reaches the plaza through the standard public route");
  assert.ok(p1AwaySupportLaunches > 0, "P2/P3 AI operates queued artillery after P1 leaves the turret");
  assert.ok(supportDetourP2Launches > 0, "P2/P3 switch to the detour route and target P2 after G1 opens");
  assert.ok(supportDetourP2Impacts > 0, "a P2/P3 detour projectile reaches enemy exterior P2");
  assert.equal(supportDetourP2Interceptions, 0, "enemy direct fire does not intercept the P2/P3 detour shots");
  assert.ok(state.castles.enemy.openGateIds.includes("G1"), `the standard player artillery opens G1 during the route (tick=${state.tick}, deliveries=${deliveries}, supportLaunches=${p1AwaySupportLaunches}, P1health=${state.castles.enemy.exterior.P1.health}, guards=${JSON.stringify(guardDamage)}, P1area=${state.actors.P1.location.area}, P1room=${state.actors.P1.currentRoomId}, phase=${phase}, outcome=${state.outcome})`);
  assert.ok(attackCount > 0, "the route uses public directional shooting");
  assert.ok(corridorDashCount > 0, "a nearby corridor threat reaches the mobility-only dash branch");
  const dispatchedGuardGenerations = state.plaza.guardDeployments.enemy?.guardGenerations ?? {};
  for (const guardId of PLAZA_GUARD_IDS) {
    assert.ok(guardDamage[guardId] >= state.rules.actorHealth, `${guardId} receives enough combat damage to be defeated: ${JSON.stringify({guardDamage, guard: state.actors[guardId], phase, outcome: state.outcome, tick:state.tick, player:state.actors.P1.location, position:state.fixedActors.P1.position})}`);
    assert.ok(Number.isInteger(dispatchedGuardGenerations[guardId]), `${guardId} remains generation-bound to a plaza assignment`);
    assert.ok(dispatchedGuardGenerations[guardId]! <= state.actors[guardId].generation,
      `${guardId}'s plaza assignment never points to a future life generation`);
  }
  assert.equal(crossedG1, true, `P1 crosses G1 using public direction: ${JSON.stringify({
    tick: state.tick,
    phase,
    outcome: state.outcome,
    deliveries,
    supportLaunches: p1AwaySupportLaunches,
    guardDamage,
    guards: Object.fromEntries(PLAZA_GUARD_IDS.map((id) => [id, {
      alive: state.actors[id].alive,
      generation: state.actors[id].generation,
      health: state.actors[id].health,
      location: state.actors[id].location,
    }])),
    P1: { alive: state.actors.P1.alive, deaths: state.actors.P1.deathCount, health: state.actors.P1.health, location: state.actors.P1.location },
    playerGates: state.castles.player.openGateIds,
    enemyGates: state.castles.enemy.openGateIds,
    playerCoreHit: state.castles.player.core.hit,
    enemyCoreHit: state.castles.enemy.core.hit,
    assault: ["E29", "E30"].map((id) => ({ id, alive: state.actors[id].alive, location: state.actors[id].location, gates: state.actors[id].location.pathGates })),
    P1position: state.fixedActors.P1.position,
    supports: (["P2", "P3"] as const).map((id) => ({ id, alive: state.actors[id].alive, deaths: state.actors[id].deathCount,
      location: state.actors[id].location, position: state.fixedActors[id].position })),
    lastCoreContact: state.eventLog.filter((event) => event.type === "core_hit_candidate").at(-1),
  })}`);
  assert.equal(state.actors.P1.location.area, "castle");
  assert.equal(state.actors.P1.location.castleTeam, "enemy");
  assert.equal(state.actors.P1.currentRoomId, "core");
  assert.deepEqual(state.actors.P1.location.pathGates, ["G1", "G2", "G3", "G4", "G5", "G6", "G7"], "P1 crosses the opened G1 through G7 in order");
  assert.ok(p2DestructionTick !== null && p2DestructionTick <= state.tick, "P2 is destroyed during the ordinary match");
  assert.ok(g2CrossingTick !== null && p2DestructionTick < g2CrossingTick, "P2 opens G2 before P1 crosses it");
  assert.ok(p3SupportLaunchTick !== null,
    "P2/P3 launch a real damaging detour shell that impacts P3");
  assert.ok(p3SupportImpactTick !== null && p3SupportLaunchTick < p3SupportImpactTick,
    "the tracked support shot reaches enemy exterior P3");
  assert.ok(p3SupportImpactDamage > 0, "a damaging tracked support projectile lowers P3 health on impact");
  assert.ok(state.castles.enemy.exterior.P3.health < initialP3Health,
    `P3 loses health during the ordinary route (${initialP3Health} -> ${state.castles.enemy.exterior.P3.health})`);
  assert.ok(p3DestructionTick !== null && p3SupportImpactTick <= p3DestructionTick,
    "P3 is destroyed after support fire has dealt real damage");
  assert.ok(g3OpenTick !== null && p3DestructionTick <= g3OpenTick,
    "destroying P3 opens G3 without requiring a fixed P3-to-G3 mapping");
  assert.ok(g3CrossingTick !== null && g3OpenTick < g3CrossingTick,
    "P1 crosses G3 after it has opened");
  assert.ok(p4SupportLaunchTick !== null,
    "P2/P3 launch a real damaging detour shell that impacts P4");
  assert.ok(p4SupportImpactTick !== null && p4SupportLaunchTick < p4SupportImpactTick,
    "the post-P3 support shot reaches enemy exterior P4");
  assert.ok(p4SupportImpactDamage > 0, "a damaging support projectile lowers P4 health on impact");
  assert.ok(p4DestructionTick !== null && p4SupportImpactTick <= p4DestructionTick,
    "P4 is destroyed after support fire has dealt real damage");
  assert.ok(g4OpenTick !== null && p4DestructionTick <= g4OpenTick,
    "destroying P4 opens G4 without requiring a fixed P4-to-G4 mapping");
  assert.ok(g4CrossingTick !== null && g4OpenTick < g4CrossingTick,
    "P1 crosses G4 after it has opened");
  assert.ok(g3CrossingTick !== null && g4CrossingTick !== null && g3CrossingTick < g4CrossingTick,
    "P1 crosses G3 before G4");
  assert.ok(p5SupportLaunchTick !== null,
    "P2/P3 launch a real damaging detour shell that impacts P5");
  assert.ok(p5SupportImpactTick !== null && p5SupportLaunchTick < p5SupportImpactTick,
    "the post-P4 support shot reaches enemy exterior P5");
  assert.ok(p5SupportImpactDamage > 0, "a damaging support projectile lowers P5 health on impact");
  assert.ok(p5DestructionTick !== null && p5SupportImpactTick <= p5DestructionTick,
    "P5 is destroyed after support fire has dealt real damage");
  assert.ok(g5OpenTick !== null && p5DestructionTick <= g5OpenTick,
    "destroying P5 opens G5 without requiring a fixed P5-to-G5 mapping");
  assert.ok(g5CrossingTick !== null && g5OpenTick < g5CrossingTick,
    "P1 crosses G5 after it has opened");
  assert.ok(g4CrossingTick !== null && g5CrossingTick !== null && g4CrossingTick < g5CrossingTick,
    "P1 crosses G4 before G5");
  assert.ok(p6SupportLaunchTick !== null,
    "P2/P3 launch a real damaging detour shell that impacts P6");
  assert.ok(p6SupportImpactTick !== null && p6SupportLaunchTick < p6SupportImpactTick,
    "the post-P5 support shot reaches enemy exterior P6");
  assert.ok(p6SupportImpactDamage > 0, "a damaging support projectile lowers P6 health on impact");
  assert.ok(p6DestructionTick !== null && p6SupportImpactTick <= p6DestructionTick,
    `P6 is destroyed on or after the support impact update that applies real damage (${JSON.stringify({ p6SupportLaunchTick, p6SupportImpactTick, p6SupportImpactDamage, p6DestructionTick, g6OpenTick, g6CrossingTick, destroyedPartIds: state.castles.enemy.destroyedPartIds, p6Health: state.castles.enemy.exterior.P6.health })})`);
  assert.ok(g6OpenTick !== null && p6DestructionTick <= g6OpenTick,
    "destroying P6 opens G6 without requiring a fixed P6-to-G6 mapping");
  assert.ok(g6CrossingTick !== null && g6OpenTick < g6CrossingTick,
    "P1 crosses G6 after it has opened");
  assert.ok(g5CrossingTick !== null && g6CrossingTick !== null && g5CrossingTick < g6CrossingTick,
    "P1 crosses G5 before G6");
  assert.ok(p7SupportLaunchTick !== null,
    "P2/P3 launch a real damaging detour shell that impacts P7");
  assert.ok(p7SupportImpactTick !== null && p7SupportLaunchTick < p7SupportImpactTick,
    "the post-P6 support shot reaches enemy exterior P7");
  assert.ok(p7SupportImpactDamage > 0, "a damaging support projectile lowers P7 health on impact");
  assert.ok(p7DestructionTick !== null && p7SupportImpactTick <= p7DestructionTick,
    "P7 is destroyed on or after the support impact update that applies real damage");
  assert.ok(g7OpenTick !== null && p7DestructionTick <= g7OpenTick,
    "destroying P7 opens G7 without requiring a fixed P7-to-G7 mapping");
  assert.ok(g7CrossingTick !== null && g7OpenTick < g7CrossingTick,
    "P1 crosses G7 after it has opened");
  assert.ok(g6CrossingTick !== null && g7CrossingTick !== null && g6CrossingTick < g7CrossingTick,
    "P1 crosses G6 before G7");
  assert.deepEqual(state.castles.enemy.destroyedPartIds, ["P1", "P2", "P3", "P4", "P5", "P6", "P7"]);
  assert.deepEqual(state.castles.enemy.openGateIds, ["G1", "G2", "G3", "G4", "G5", "G6", "G7"]);
  assert.equal(crossedG7, true, "P1 reaches the core room through G7");
  assert.equal(state.actors.P1.currentRoomId, "core");
  assert.deepEqual(state.actors.P1.location.pathGates, ["G1", "G2", "G3", "G4", "G5", "G6", "G7"]);
  assert.ok(coreShotIntentCount > 0, "P1 issues a public shot after reaching the enemy core room through all seven gates");
  assert.ok(coreContactCount > 0, "the public shot makes a validated first contact with the core");
  assert.ok(state.eventLog.some((event) => event.type === "core_hit_candidate" &&
    event.attackerId === "P1" && event.targetTeam === "enemy"), "P1's core contact reaches the common victory check");
  assert.equal(state.castles.enemy.core.hit, true, "a valid P1 shot hits the enemy core");
  assert.equal(state.castles.player.core.hit, false, "the enemy has not hit the player core before the player victory");
  assert.equal(state.rules.enemyRespawnTicks, 1_200, "enemy generations keep their required 20-second respawn");
  assert.equal(state.outcome, "player_win", "the valid core hit ends the standard battle in a player victory");
  assert.equal(state.phase, "ended");
  assert.equal(practiceAchieved, true, "core practice requires this actual public seven-gate P1 victory");
  assert.equal(state.lastStep.acceptedInputKinds.includes("bridge:core_contact"), true);
  assert.equal(state.lastStep.events.filter((event) => event.type === "outcome").length, 1,
    "the terminal player victory is emitted once");
});
