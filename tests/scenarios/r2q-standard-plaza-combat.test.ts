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

test("標準配分の主人公P1は広場の実警備へ最初の通常接触攻撃を当てる", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2q-standard-plaza-combat", seed: 20260913 });
  assert.deepEqual(state.logistics.playerAllocation, [
    "standard_slug", "standard_slug", "standard_slug",
    "dense_payload", "dense_payload", "screen_panel", "screen_panel", "fast_dart",
  ]);
  for (const actorId of ["P1", "P2", "P3", ...PLAZA_GUARD_IDS] as const) {
    assert.equal(state.actors[actorId].protectedUntilTick, null, `${actorId} starts without test protection`);
  }

  let phase: "pickup" | "turret" | "plaza" = "pickup";
  let floorPickups = 0;
  let deliveries = 0;
  let reachedPlazaAt: number | undefined;
  let attackTick: number | undefined;
  let attackTargetId: (typeof PLAZA_GUARD_IDS)[number] | undefined;
  let guardHealthBefore: number | undefined;
  let p1PositionBeforeAttack: BattleState["fixedActors"]["P1"]["position"] | undefined;

  for (let tick = 0; tick < 3_200 && state.phase === "running"; tick += 1) {
    if (!state.actors.P1.alive) {
      state = stepBattle(state);
      continue;
    }

    let intent = publicP1Intent(state, { direction: NEUTRAL });
    if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", 0);
      if (interaction.handles.includes("pickup")) {
        if (interaction.pickupCaseId && state.battleCases[interaction.pickupCaseId]?.location === "floor") floorPickups += 1;
        intent = publicP1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken });
      } else {
        intent = publicP1Intent(state, { direction: p1ToAmmoDirection(state) });
      }
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", 0);
      intent = interaction.handles.includes("deliver")
        ? publicP1Intent(state, { handle: "deliver", slot: 0, route: "direct", part: "P1", contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToTurretDirection(state) });
    } else {
      const interaction = getInteraction(state, "P1", 0);
      const candidate = PLAZA_GUARD_IDS.find((actorId) => actorId === interaction.attackTargetId);
      if (candidate) {
        attackTick = state.tick;
        attackTargetId = candidate;
        guardHealthBefore = state.actors[candidate].health;
        p1PositionBeforeAttack = { ...state.fixedActors.P1.position };
        state = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL, attack: true }));
        break;
      }
      intent = publicP1Intent(state, { direction: p1ToPlazaDirection(state) });
    }

    state = stepBattle(state, intent);
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = "plaza";
    }
    if (state.actors.P1.location.area === "plaza" && reachedPlazaAt === undefined) reachedPlazaAt = state.tick;
  }

  assert.equal(floorPickups, 1, "P1 picks up one real floor case from the standard initial layout");
  assert.equal(deliveries, 1, "P1 uses one ordinary delivery before the plaza route");
  assert.ok(reachedPlazaAt !== undefined, `P1 reaches the plaza before combat (tick=${state.tick}, area=${state.actors.P1.location.area}, outcome=${state.outcome})`);
  assert.ok(attackTick !== undefined, `P1 reaches a live plaza guard through public movement (tick=${state.tick}, position=${JSON.stringify(state.fixedActors.P1.position)})`);
  assert.ok(attackTargetId !== undefined);
  assert.equal(state.actors.P1.alive, true, "P1 survives until the first public contact attack");
  assert.equal(state.actors.P1.location.area, "plaza");
  assert.equal(state.plaza.guardDeployments.enemy?.guardGenerations[attackTargetId], state.actors[attackTargetId].generation);
  assert.equal(state.actors[attackTargetId].health, guardHealthBefore! - state.rules.dashActorDamage);
  assert.deepEqual(state.fixedActors.P1.position, p1PositionBeforeAttack);
  assert.equal(state.dashes.P1, undefined, "normal contact attack does not start a dash");
  assert.equal(state.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), true);
  assert.equal(state.lastStep.rejected.length, 0);
  assert.equal(state.outcome, "ongoing");
});
