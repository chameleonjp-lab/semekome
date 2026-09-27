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
import { registerPlazaGuardDispatch } from "../../src/simulation/plaza-guards.ts";

const NEUTRAL: BattleDirection = { x: 0, y: 0 };
const PLAZA_Y = 35_500;
const P1_AMMO_APPROACH_X = 94_500;
const P1_AMMO_PICKUP_Y = 13_500;
const P1_TURRET_TRAVEL_Y = 12_000;
const P1_TURRET_APPROACH_X = 105_850;
const P1_EXIT_ROUTE_Y = 25_500;
const P1_EXIT_X = 123_500;

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

function p1ToAmmoDirection(state: BattleState, firstDelivery: boolean): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (firstDelivery) {
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

/** Leave turret A through the authored lower passage, then approach the exit. */
function p1ToPlazaDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (position.x !== P1_EXIT_X) {
    if (position.y !== P1_EXIT_ROUTE_Y) return { x: 0, y: sign(P1_EXIT_ROUTE_Y - position.y) };
    return { x: sign(P1_EXIT_X - position.x), y: 0 };
  }
  if (position.y !== PLAZA_Y) return { x: 0, y: sign(PLAZA_Y - position.y) };
  return { x: 1, y: 0 };
}

test("主人公の公開入力は補給・砲台から広場へ進み、警備を無視した敵城侵入を止める", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2d-player-plaza-route", seed: 20260913 });
  // Keep the route assertion deterministic: the real guard roster is
  // dispatched and remains live, while spawn protection holds enemy combat
  // movement so the test can reach the opposing edge with public input.
  registerPlazaGuardDispatch(state, "enemy", "E25");
  for (const actor of Object.values(state.actors)) {
    if (actor.team === "enemy") actor.protectedUntilTick = 99_999;
  }
  let phase: "pickup" | "turret" | "plaza-route" | "plaza-cross" = "pickup";
  let deliveries = 0;
  let reachedPlaza = false;
  let attemptedOpposingEntry = false;

  for (let tick = 0; tick < 6_000 && state.phase === "running"; tick += 1) {
    let intent = publicP1Intent(state, { direction: NEUTRAL });
    if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", 0);
      intent = interaction.handles.includes("pickup")
        ? publicP1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToAmmoDirection(state, deliveries === 0) });
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", 0);
      intent = interaction.handles.includes("deliver")
        ? publicP1Intent(state, { handle: "deliver", slot: 0, route: "direct", part: "P1", contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToTurretDirection(state) });
    } else if (phase === "plaza-route") {
      intent = publicP1Intent(state, { direction: p1ToPlazaDirection(state) });
    } else {
      // The edge attempt is still an ordinary held direction. There is no
      // bridge, placement, or direct crossing input in this scenario.
      intent = publicP1Intent(state, { direction: { x: 1, y: 0 } });
    }

    state = stepBattle(state, intent);
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = "plaza-route";
    }
    if (state.actors.P1.location.area === "plaza") {
      reachedPlaza = true;
      phase = "plaza-cross";
    }
    if (reachedPlaza && state.fixedActors.P1.position.x >= 125_500) {
      attemptedOpposingEntry = true;
      break;
    }
  }

  assert.equal(deliveries, 1, "the route uses one normal P1 delivery before leaving the home castle");
  assert.equal(reachedPlaza, true, `P1 reaches the plaza through fixed-point movement (tick=${state.tick}, phase=${phase}, outcome=${state.outcome}, area=${state.actors.P1.location.area}, room=${state.actors.P1.currentRoomId}, position=${JSON.stringify(state.fixedActors.P1.position)})`);
  assert.equal(attemptedOpposingEntry, true, "P1 reaches the opposing-side plaza boundary with a held direction");
  assert.equal(state.actors.P1.location.area, "plaza", "live plaza guards block the opposing castle entry");
  assert.deepEqual(state.plaza.guardDeployments.enemy?.guardGenerations, { E25: 0, E26: 0, E27: 0 });
  assert.equal(state.plaza.enemyCrossings["P1:0"]?.allowed, undefined);
  assert.equal(state.lastStep.acceptedInputKinds.includes("bridge:plaza_entry"), false);
  assert.ok(Object.entries(state.plaza.guardDeployments.enemy?.guardGenerations ?? {}).some(([id, generation]) => {
    const guard = state.actors[id];
    return guard?.alive === true && guard.generation === generation;
  }), "at least one live dispatched guard generation remains as the physical crossing blocker");
});
