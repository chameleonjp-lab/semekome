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
function p1ToActorDirection(state: BattleState, actorId: string): BattleDirection {
  const position = state.fixedActors.P1.position;
  const target = state.fixedActors[actorId]?.position;
  if (!target) return { x: 1, y: 0 };
  const direction = { x: sign(target.x - position.x), y: sign(target.y - position.y) };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

function p1ToNearestGuardDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  const target = PLAZA_GUARD_IDS
    .map((actorId) => state.actors[actorId])
    .filter((actor) => actor.alive && actor.location.area === "plaza")
    .map((actor) => ({ actor, position: state.fixedActors[actor.id].position }))
    .sort((left, right) => {
      // Keep the public chase focused on the most damaged live guard. Health
      // is an ordinary actor observation; it is never sent as an input.
      const healthDelta = left.actor.health - right.actor.health;
      const leftDistance = (left.position.x - position.x) ** 2 + (left.position.y - position.y) ** 2;
      const rightDistance = (right.position.x - position.x) ** 2 + (right.position.y - position.y) ** 2;
      return healthDelta || leftDistance - rightDistance || left.actor.id.localeCompare(right.actor.id);
    })[0];

  if (!target) return { x: 1, y: 0 };
  const direction = {
    x: sign(target.position.x - position.x),
    y: sign(target.position.y - position.y),
  };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

test("標準配分の主人公P1は広場警備3人を公開接触攻撃で撃破し敵城側へ越境する", { timeout: 300_000 }, () => {
  let state = createBattle({ matchId: "r2r-standard-plaza-breakthrough", seed: 20260913 });
  assert.deepEqual(state.logistics.playerAllocation, STANDARD_ALLOCATION);

  for (const actorId of ["P1", "P2", "P3", ...PLAZA_GUARD_IDS] as const) {
    assert.equal(state.actors[actorId].protectedUntilTick, null, actorId + " starts without test protection");
  }

  let phase: "pickup" | "turret" | "plaza-route" | "return-plaza" | "combat" = "pickup";
  let deliveries = 0;
  let reachedPlaza = false;
  let enteredEnemyCastle = false;
  let attackCount = 0;
  const guardHits: Record<(typeof PLAZA_GUARD_IDS)[number], number> = {
    E25: 0,
    E26: 0,
    E27: 0,
  };

  for (let tick = 0; tick < state.matchLimitTicks && state.phase === "running"; tick += 1) {
    if (!state.actors.P1.alive) {
      state = stepBattle(state);
      if (state.actors.P1.alive) phase = deliveries === 0 ? "pickup" : "return-plaza";
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
      nextState = stepBattle(state, publicP1Intent(state, { direction: p1ToPlazaDirection(state) }));
    } else {
      const interaction = getInteraction(state, "P1", 0);
      const dashReady = state.tick >= (state.dashCooldownUntilTick.P1 ?? 0);
      if (state.dashes.P1) {
        nextState = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
      } else if (interaction.attackTargetId) {
        const targetId = interaction.attackTargetId;
        const targetHealth = state.actors[targetId].health;
        const direction = p1ToActorDirection(state, targetId);
        const isPlazaGuard = PLAZA_GUARD_IDS.includes(targetId as (typeof PLAZA_GUARD_IDS)[number]);
        const finishWithDash = isPlazaGuard && dashReady;
        const intent = finishWithDash
          ? publicP1Intent(state, { direction: NEUTRAL, dash: direction })
          : publicP1Intent(state, { direction: NEUTRAL, attack: true });
        nextState = stepBattle(state, intent);
        if (nextState.lastStep.acceptedInputKinds.includes("bridge:actor_contact")) {
          attackCount += 1;
          if (PLAZA_GUARD_IDS.includes(targetId as (typeof PLAZA_GUARD_IDS)[number])) {
            const guardId = targetId as (typeof PLAZA_GUARD_IDS)[number];
            guardHits[guardId] += 1;
            assert.equal(nextState.actors[guardId].health, targetHealth - nextState.rules.dashActorDamage);
          }
        }
      } else {
        // Keep chasing with ordinary movement until a real contact snapshot
        // exists; a dash without a contact would discard steering time.
        nextState = stepBattle(state, publicP1Intent(state, { direction: p1ToNearestGuardDirection(state) }));
      }
    }

    state = nextState;
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
  assert.deepEqual(
    state.plaza.guardDeployments.enemy?.guardGenerations,
    { E25: 0, E26: 0, E27: 0 },
    "the standard AI registers the three generation-zero plaza guards",
  );
  assert.ok(attackCount > 0, "the battle uses public contact attacks");
  for (const guardId of PLAZA_GUARD_IDS) {
    assert.equal(guardHits[guardId] >= 4, true, guardId + " receives the configured repeated contact damage (hits=" + guardHits[guardId] + ", health=" + state.actors[guardId].health + ", alive=" + state.actors[guardId].alive + ", tick=" + state.tick + ", p1=" + JSON.stringify(state.fixedActors.P1.position) + ", guard=" + JSON.stringify(state.fixedActors[guardId] ? state.fixedActors[guardId].position : null) + ", attacks=" + attackCount + ", p1DeathCount=" + state.actors.P1.deathCount + ")");
    assert.equal(state.actors[guardId].alive, false, guardId + " is defeated before the crossing");
  }
  assert.equal(enteredEnemyCastle, true, "held public direction crosses after every live plaza guard is defeated");
  assert.equal(state.actors.P1.location.castleTeam, "enemy");
  assert.equal(state.plaza.enemyCrossings["P1:" + state.actors.P1.generation]?.allowed, true);
  assert.equal(state.lastStep.acceptedInputKinds.includes("direction"), true);
});