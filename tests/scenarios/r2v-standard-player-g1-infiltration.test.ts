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
const P1_AMMO_PICKUP_Y = 13_500;
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
  return {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    ...partial,
  };
}

function sign(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function p1ToAmmoDirection(state: BattleState, firstPickup: boolean): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (firstPickup) {
    if (Math.abs(position.x - P1_AMMO_APPROACH_X) > 50) return { x: sign(P1_AMMO_APPROACH_X - position.x), y: 0 };
    if (Math.abs(position.y - P1_AMMO_PICKUP_Y) > 50) return { x: 0, y: sign(P1_AMMO_PICKUP_Y - position.y) };
  } else {
    if (position.x > P1_AMMO_APPROACH_X + 50) {
      if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
      return { x: -1, y: 0 };
    }
    if (position.y < P1_AMMO_PICKUP_Y - 50) return { x: 0, y: 1 };
  }
  return { x: -1, y: 0 };
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
  const direction = { x: sign(target.x - position.x), y: sign(target.y - position.y) };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

function nearestEnemyInP1Room(state: BattleState): string | undefined {
  const player = state.actors.P1;
  const position = state.fixedActors.P1.position;
  const target = Object.values(state.actors)
    .filter((actor) => actor.team === "enemy" && actor.alive && actor.location.area === player.location.area &&
      actor.currentRoomId === player.currentRoomId && actor.location.castleTeam === player.location.castleTeam)
    .sort((left, right) => {
      const leftPosition = state.fixedActors[left.id].position;
      const rightPosition = state.fixedActors[right.id].position;
      return (leftPosition.x - position.x) ** 2 + (leftPosition.y - position.y) ** 2 -
        ((rightPosition.x - position.x) ** 2 + (rightPosition.y - position.y) ** 2) || left.id.localeCompare(right.id);
    })[0];
  if (!target) return undefined;
  const targetPosition = state.fixedActors[target.id].position;
  const engagementRange = state.rules.dashDistanceSubunits + 1_000;
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

test("標準配分の通常ルートでG2を越え、支援射撃がP3へ届く", { timeout: 300_000 }, () => {
  let state = createBattle({ matchId: "r2z-standard-player-g2-corridor2", seed: 20260913 });
  assert.deepEqual(state.logistics.playerAllocation, STANDARD_ALLOCATION);
  const initialP3Health = state.castles.enemy.exterior.P3.health;
  for (const actorId of ["P1", "P2", "P3", ...PLAZA_GUARD_IDS] as const) {
    assert.equal(state.actors[actorId].protectedUntilTick, null, actorId + " starts without test protection");
  }

  let phase: "pickup" | "turret" | "plaza-route" | "return-plaza" | "combat" | "gate-route" = "pickup";
  let deliveries = 0;
  let reachedPlaza = false;
  let crossedG1 = false;
  let crossedG2 = false;
  let p2DestructionTick: number | null = null;
  let g2CrossingTick: number | null = null;
  let p3SupportLaunchTick: number | null = null;
  let p3SupportImpactTick: number | null = null;
  let p3SupportImpactDamage = 0;
  let supportDetourP2Launches = 0;
  let supportDetourP2Impacts = 0;
  let supportDetourP2Interceptions = 0;
  let p1AwaySupportLaunches = 0;
  let attackCount = 0;
  let focusGuardId: (typeof PLAZA_GUARD_IDS)[number] | undefined;
  const guardDamage: Record<(typeof PLAZA_GUARD_IDS)[number], number> = { E25: 0, E26: 0, E27: 0 };
  const supportP2ProjectileIds = new Set<string>();
  const supportP3ProjectileIds = new Set<string>();

  for (let tick = 0; tick < state.matchLimitTicks && state.phase === "running"; tick += 1) {
    if (state.actors.P1.location.area === "castle" && state.actors.P1.location.castleTeam === "enemy" &&
        state.actors.P1.currentRoomId === "corridor_2" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2") {
      crossedG2 = true;
      g2CrossingTick ??= state.tick;
    }
    if (!state.actors.P1.alive) {
      state = stepBattle(state);
      if (state.actors.P1.alive) {
        focusGuardId = undefined;
        phase = deliveries === 0 ? "pickup" : "return-plaza";
      }
      continue;
    }

    if (phase === "combat" && state.actors.P1.location.area !== "plaza") phase = "return-plaza";
    const startPosition = state.fixedActors.P1.position;
    const turretPosition = state.artillery.turrets["player:T1"].position;
    const p1AwayFromTurret = Math.hypot(startPosition.x - turretPosition.x, startPosition.y - turretPosition.y) > 800;
    let nextState: BattleState;
    if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", 0);
      nextState = interaction.handles.includes("load")
        ? stepBattle(state, publicP1Intent(state, { handle: "load", slot: 0, contextToken: interaction.contextToken }))
        : interaction.handles.includes("pickup")
          ? stepBattle(state, publicP1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken }))
          : stepBattle(state, publicP1Intent(state, { direction: p1ToAmmoDirection(state, deliveries === 0) }));
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", 0);
      nextState = interaction.handles.includes("deliver")
        ? stepBattle(state, publicP1Intent(state, { handle: "deliver", slot: 0, route: "detour", part: "P1", contextToken: interaction.contextToken }))
        : stepBattle(state, publicP1Intent(state, { direction: p1ToTurretDirection(state) }));
    } else if (phase === "plaza-route" || phase === "return-plaza") {
      nextState = stepBattle(state, publicP1Intent(state, {
        direction: phase === "return-plaza" ? p1FromRespawnToPlazaDirection(state) : p1ToPlazaDirection(state),
      }));
    } else if (phase === "gate-route") {
      const threatId = nearestEnemyInP1Room(state);
      const interaction = getInteraction(state, "P1", 0);
      const targetPosition = threatId ? state.fixedActors[threatId]?.position : undefined;
      const p1Position = state.fixedActors.P1.position;
      const distance = targetPosition ? Math.hypot(targetPosition.x - p1Position.x, targetPosition.y - p1Position.y) : Number.POSITIVE_INFINITY;
      const direction = threatId ? p1ToActorDirection(state, threatId) : { x: 1, y: 0 } as BattleDirection;
      const dashReady = state.tick >= (state.dashCooldownUntilTick.P1 ?? 0);
      if (state.dashes.P1) {
        nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
      } else if (threatId && interaction.attackTargetId === threatId) {
        nextState = stepBattle(state, publicP1Intent(state, { direction, attack: true }));
        if (nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact")) attackCount += 1;
      } else if (threatId && dashReady && distance <= state.rules.dashDistanceSubunits + 1_000) {
        nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL, dash: direction }));
        if (nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact")) attackCount += 1;
      } else {
        nextState = stepBattle(state, publicP1Intent(state, { direction }));
      }
    } else {
      const interaction = getInteraction(state, "P1", 0);
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
        nextState = stepBattle(state, publicP1Intent(state, { direction: p1ToActorDirection(state, targetId), attack: true }));
        if (nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact")) attackCount += 1;
      } else if (allGuardsClearedFromPlaza) {
        if (!state.castles.enemy.openGateIds.includes("G1")) {
          nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
        } else {
          const direction = p1ToEnemyCastleDirection(state);
          nextState = dashReady
            ? stepBattle(state, publicP1Intent(state, { direction: NEUTRAL, dash: direction }))
            : stepBattle(state, publicP1Intent(state, { direction }));
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
          nextState = stepBattle(state, publicP1Intent(state, { direction: focusDirection, attack: true }));
          if (nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact")) attackCount += 1;
        } else if (focusGuardId && dashReady && focusDistance <= state.rules.dashDistanceSubunits + 1_000) {
          nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL, dash: focusDirection }));
          if (nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact")) attackCount += 1;
        } else {
          nextState = stepBattle(state, publicP1Intent(state, { direction: p1ToNearestGuardDirection(state, focusGuardId) }));
        }
      }
    }

    state = nextState;
    let trackedP3ProjectileImpactedThisTick = false;
    let p3PartDamageThisTick = 0;
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
      if (crossedG2 && event.type === "projectile_launched" && event.team === "player" &&
          (event.sourceActorId === "P2" || event.sourceActorId === "P3") &&
          event.route === "detour" && event.targetPart === "P3") {
        const launchedCase = state.battleCases[event.objectId];
        if ((caseDefinition(launchedCase?.type ?? "")?.partDamage ?? 0) > 0) {
          supportP3ProjectileIds.add(event.projectileId);
          p3SupportLaunchTick ??= state.tick;
        }
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
      if (event.type === "part_damaged" && event.team === "enemy" && event.partId === "P3") {
        p3PartDamageThisTick += event.amount;
      }
      if (event.type === "projectile_intercepted" &&
          (supportP2ProjectileIds.has(event.firstProjectileId) || supportP2ProjectileIds.has(event.secondProjectileId))) {
        supportDetourP2Interceptions += 1;
      }
      if (event.type === "part_destroyed" && event.team === "enemy" && event.partId === "P2") {
        p2DestructionTick = state.tick;
      }
    }
    if (trackedP3ProjectileImpactedThisTick) p3SupportImpactDamage += p3PartDamageThisTick;
    if (focusGuardId && !state.actors[focusGuardId].alive) focusGuardId = undefined;
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = deliveries < 4 ? "pickup" : "plaza-route";
    }
    if (state.actors.P1.location.area === "plaza") {
      reachedPlaza = true;
      phase = "combat";
    }
    if (state.actors.P1.location.area === "castle" && state.actors.P1.location.castleTeam === "enemy") phase = "gate-route";
    if (phase === "gate-route" && state.actors.P1.currentRoomId === "corridor_1") {
      crossedG1 = true;
    }
    if (phase === "gate-route" && state.actors.P1.currentRoomId === "corridor_2" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2") {
      crossedG2 = true;
      g2CrossingTick ??= state.tick;
    }
    if (crossedG2 && p3SupportImpactTick !== null && p3SupportImpactDamage > 0) break;
  }

  assert.ok(deliveries >= 4, "P1 stages at least four ordinary public deliveries before leaving the turret");
  assert.equal(reachedPlaza, true, "P1 reaches the plaza through the standard public route");
  assert.ok(p1AwaySupportLaunches > 0, "P2/P3 AI operates queued artillery after P1 leaves the turret");
  assert.ok(supportDetourP2Launches > 0, "P2/P3 switch to the detour route and target P2 after G1 opens");
  assert.ok(supportDetourP2Impacts > 0, "a P2/P3 detour projectile reaches enemy exterior P2");
  assert.equal(supportDetourP2Interceptions, 0, "enemy direct fire does not intercept the P2/P3 detour shots");
  assert.ok(state.castles.enemy.openGateIds.includes("G1"), `the standard player artillery opens G1 during the route (tick=${state.tick}, deliveries=${deliveries}, supportLaunches=${p1AwaySupportLaunches}, P1health=${state.castles.enemy.exterior.P1.health}, guards=${JSON.stringify(guardDamage)}, P1area=${state.actors.P1.location.area}, P1room=${state.actors.P1.currentRoomId}, phase=${phase}, outcome=${state.outcome})`);
  assert.ok(attackCount > 0, "the plaza fight uses public contact attacks");
  const dispatchedGuardGenerations = state.plaza.guardDeployments.enemy?.guardGenerations ?? {};
  for (const guardId of PLAZA_GUARD_IDS) {
    assert.ok(guardDamage[guardId] >= state.rules.actorHealth, `${guardId} receives enough contact damage to be defeated`);
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
    supports: ["P2", "P3"].map((id) => ({ id, alive: state.actors[id].alive, deaths: state.actors[id].deathCount,
      location: state.actors[id].location, position: state.fixedActors[id].position })),
    lastCoreContact: state.eventLog.filter((event) => event.type === "core_hit_candidate").at(-1),
  })}`);
  assert.equal(state.actors.P1.location.area, "castle");
  assert.equal(state.actors.P1.location.castleTeam, "enemy");
  assert.equal(state.actors.P1.currentRoomId, "corridor_2");
  assert.deepEqual(state.actors.P1.location.pathGates, ["G1", "G2"], "P1 crosses the opened G1 and G2 in order");
  assert.ok(p2DestructionTick !== null && p2DestructionTick <= state.tick, "P2 is destroyed during the ordinary match");
  assert.ok(g2CrossingTick !== null && p2DestructionTick < g2CrossingTick, "P2 opens G2 before P1 crosses it");
  assert.ok(p3SupportLaunchTick !== null && g2CrossingTick < p3SupportLaunchTick,
    "P2/P3 launch a new detour shot at P3 after P1 has crossed G2");
  assert.ok(p3SupportImpactTick !== null && p3SupportLaunchTick < p3SupportImpactTick,
    "the post-G2 support shot reaches enemy exterior P3");
  assert.ok(p3SupportImpactDamage > 0, "a damaging post-G2 support projectile lowers P3 health on impact");
  assert.ok(state.castles.enemy.exterior.P3.health < initialP3Health,
    `P3 loses health during the ordinary route (${initialP3Health} -> ${state.castles.enemy.exterior.P3.health})`);
  assert.deepEqual(state.castles.enemy.destroyedPartIds, ["P1", "P2"]);
  assert.deepEqual(state.castles.enemy.openGateIds, ["G1", "G2"]);
  assert.equal(state.rules.enemyRespawnTicks, 1_200, "enemy generations keep their required 20-second respawn");
  assert.equal(state.outcome, "ongoing", "crossing G1 does not end the battle");
});
