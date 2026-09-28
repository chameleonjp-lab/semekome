import assert from "node:assert/strict";
import test from "node:test";
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

function p1ToAmmoDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (Math.abs(position.x - P1_AMMO_APPROACH_X) > 50) return { x: sign(P1_AMMO_APPROACH_X - position.x), y: 0 };
  if (Math.abs(position.y - P1_AMMO_PICKUP_Y) > 50) return { x: 0, y: sign(P1_AMMO_PICKUP_Y - position.y) };
  return { x: -1, y: 0 };
}

function isNearPlayerTurret(state: BattleState): boolean {
  const turret = state.artillery.turrets["player:T1"];
  const position = state.fixedActors.P1.position;
  const dx = position.x - turret.position.x;
  const dy = position.y - turret.position.y;
  return dx * dx + dy * dy <= 800 * 800;
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

/**
 * Steer with current physical observations only. The input still remains a
 * public direction; no guard id, coordinate, health, or crossing permission
 * is sent to the battle.
 */
function p1FromRespawnToPlazaDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (Math.abs(position.y - PLAZA_Y) > 50) return { x: 0, y: sign(PLAZA_Y - position.y) };
  // The player respawn room sits left of the central corridor. Re-enter the
  // corridor at its authored horizontal passage before taking the public
  // front-entry route; reusing the first-life route would walk into the room
  // wall and leave a respawned P1 stranded.
  if (position.x < 66_500) return { x: 1, y: 0 };
  if (Math.abs(position.x - P1_EXIT_X) > 50) return { x: sign(P1_EXIT_X - position.x), y: 0 };
  return { x: 1, y: 0 };
}

function p1ToEnemyCastleDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  const enemyPlazaEdgeX = state.layout.plaza.x1 * 1_000 - 500;
  const direction = {
    x: sign(enemyPlazaEdgeX - position.x),
    y: sign(PLAZA_Y - position.y),
  };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

function p1ToActorDirection(state: BattleState, actorId: string): BattleDirection {
  const position = state.fixedActors.P1.position;
  const target = state.fixedActors[actorId]?.position;
  if (!target) {
    // A dispatched guard may still be walking from its castle. Stay in the
    // current public snapshot until every current guard generation is dead;
    // moving to the edge early would let a respawned guard reopen the gate.
    if (PLAZA_GUARD_IDS.some((actorId) => state.actors[actorId].alive)) return NEUTRAL;
    return p1ToEnemyCastleDirection(state);
  }
  const direction = { x: sign(target.x - position.x), y: sign(target.y - position.y) };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
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
  const preferred = preferredGuardId
    ? candidates.find((candidate) => candidate.actor.id === preferredGuardId)
    : undefined;
  const target = preferred ?? candidates.sort((left, right) => {
    // Keep the public chase focused on one observed live guard until it is
    // defeated. Health is an ordinary actor observation; it is never sent as
    // an input.
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
    if (Math.abs(position.y - laneY) > 50) {
      return { x: 0, y: sign(laneY - position.y) };
    }
    return { x: sign(target.position.x - position.x), y: 0 };
  }
  if (Math.abs(target.position.y - position.y) > 50) {
    return { x: 0, y: sign(target.position.y - position.y) };
  }
  const direction = {
    x: sign(target.position.x - position.x),
    y: sign(target.position.y - position.y),
  };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

test("標準配分の主人公P1は広場警備3人を公開接触攻撃で撃破し敵城側へ越境する", { timeout: 300_000 }, () => {
  let state = createBattle({ matchId: "r2r-standard-plaza-breakthrough", seed: 20260901 });
  assert.deepEqual(state.logistics.playerAllocation, STANDARD_ALLOCATION);

  for (const actorId of ["P1", "P2", "P3", ...PLAZA_GUARD_IDS] as const) {
    assert.equal(state.actors[actorId].protectedUntilTick, null, actorId + " starts without test protection");
  }

  let phase: "pickup" | "turret" | "plaza-route" | "return-plaza" | "combat" = "pickup";
  let deliveries = 0;
  let reachedPlaza = false;
  let enteredEnemyCastle = false;
  let attackCount = 0;
  let focusGuardId: (typeof PLAZA_GUARD_IDS)[number] | undefined;
  const guardDamage: Record<(typeof PLAZA_GUARD_IDS)[number], number> = {
    E25: 0,
    E26: 0,
    E27: 0,
  };

  for (let tick = 0; tick < state.matchLimitTicks && state.phase === "running"; tick += 1) {
    if (!state.actors.P1.alive) {
      state = stepBattle(state);
      if (state.actors.P1.alive) {
        focusGuardId = undefined;
        phase = deliveries === 0 ? "pickup" : "return-plaza";
      }
      continue;
    }

    let nextState: BattleState;
    if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", 0);
      const intent = interaction.handles.includes("pickup")
        ? publicP1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToAmmoDirection(state) });
      nextState = stepBattle(state, intent);
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", 0);
      const intent = interaction.handles.includes("deliver")
        ? publicP1Intent(state, { handle: "deliver", slot: 0, route: "direct", part: "P1", contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToTurretDirection(state) });
      nextState = stepBattle(state, intent);
    } else if (phase === "plaza-route" || phase === "return-plaza") {
      const direction = phase === "return-plaza" ? p1FromRespawnToPlazaDirection(state) : p1ToPlazaDirection(state);
      nextState = stepBattle(state, publicP1Intent(state, { direction }));
    } else {
      const interaction = getInteraction(state, "P1", 0);
      const dashReady = state.tick >= (state.dashCooldownUntilTick.P1 ?? 0);
      if (state.dashes.P1) {
        nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
      } else if (interaction.attackTargetId &&
          PLAZA_GUARD_IDS.includes(interaction.attackTargetId as (typeof PLAZA_GUARD_IDS)[number])) {
        const targetId = interaction.attackTargetId;
        const direction = p1ToActorDirection(state, targetId);
        nextState = stepBattle(state, publicP1Intent(state, { direction, attack: true }));
        if (nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact")) {
          attackCount += 1;
        }
      } else if (PLAZA_GUARD_IDS.every((actorId) => !state.actors[actorId].alive)) {
        const routeDirection = p1ToEnemyCastleDirection(state);
        nextState = dashReady
          ? stepBattle(state, publicP1Intent(state, { direction: NEUTRAL, dash: routeDirection }))
          : stepBattle(state, publicP1Intent(state, { direction: routeDirection }));
      } else {
        // Keep one observed guard in focus until that actor is defeated; a
        // dash without a contact would discard steering time.
        if (!focusGuardId || !state.actors[focusGuardId].alive) {
          focusGuardId = nearestLiveGuardId(state);
        }
        const focusDirection = focusGuardId ? p1ToActorDirection(state, focusGuardId) : { x: 1, y: 0 } as BattleDirection;
        const focusPosition = focusGuardId ? state.fixedActors[focusGuardId]?.position : undefined;
        const focusDistance = focusPosition
          ? Math.hypot(focusPosition.x - state.fixedActors.P1.position.x, focusPosition.y - state.fixedActors.P1.position.y)
          : Number.POSITIVE_INFINITY;
        const focusActor = focusGuardId ? state.actors[focusGuardId] : undefined;
        const focusSharesPlazaSpace = focusActor?.location.area === "plaza" &&
          state.actors.P1.location.area === "plaza" &&
          focusActor.currentRoomId === state.actors.P1.currentRoomId;
        if (focusGuardId && focusSharesPlazaSpace) {
          // Keep the public combat snapshot stable while the observed guard
          // is in contact recovery. The direction is still public movement
          // toward that observed target, so P1 closes the knockback gap while
          // attack suppresses a stale NPC movement snapshot.
          nextState = stepBattle(state, publicP1Intent(state, { direction: focusDirection, attack: true }));
        } else if (focusGuardId && dashReady && focusDistance <= state.rules.dashDistanceSubunits + 1_000) {
          nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL, dash: focusDirection }));
          if (nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact")) {
            attackCount += 1;
          }
        } else {
          nextState = stepBattle(state, publicP1Intent(state, { direction: p1ToNearestGuardDirection(state, focusGuardId) }));
        }
      }
    }
    state = nextState;
    for (const event of state.lastStep.events) {
      if (event.type !== "actor_damaged" ||
          !PLAZA_GUARD_IDS.includes(event.actorId as (typeof PLAZA_GUARD_IDS)[number])) continue;
      const guardId = event.actorId as (typeof PLAZA_GUARD_IDS)[number];
      guardDamage[guardId] += event.amount;
    }
    if (focusGuardId && !state.actors[focusGuardId].alive) focusGuardId = undefined;
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = "plaza-route";
    }
    if (state.actors.P1.location.area === "plaza") {
      reachedPlaza = true;
      phase = "combat";
    }
    if (state.actors.P1.location.area === "castle" && state.actors.P1.location.castleTeam === "enemy") {
      enteredEnemyCastle = true;
      break;
    }
  }

  assert.equal(deliveries, 1, "P1 performs one public delivery before the first plaza entry");
  assert.equal(reachedPlaza, true, "P1 reaches the plaza through the standard public route");
  const guardGenerations = state.plaza.guardDeployments.enemy?.guardGenerations ?? {};
  assert.deepEqual(
    Object.keys(guardGenerations).sort(),
    [...PLAZA_GUARD_IDS].sort(),
    "the standard AI keeps all three plaza guard registrations generation-bound",
  );
  assert.ok(attackCount > 0, "the battle uses public contact attacks");
  for (const guardId of PLAZA_GUARD_IDS) {
    assert.equal(guardDamage[guardId] >= state.rules.actorHealth, true, guardId + " receives enough public contact damage to be defeated");
    assert.equal(state.actors[guardId].alive, false, guardId + " is defeated before the crossing");
  }
  assert.equal(enteredEnemyCastle, true, "held public direction crosses after every live plaza guard is defeated");
  assert.equal(state.actors.P1.location.castleTeam, "enemy");
  assert.equal(state.plaza.enemyCrossings["P1:" + state.actors.P1.generation]?.allowed, true);
  assert.equal(state.lastStep.acceptedInputKinds.includes("direction"), true);
});
