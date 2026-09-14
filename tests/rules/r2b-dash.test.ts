import assert from "node:assert/strict";
import test from "node:test";
import { floorCell } from "../../src/actors/movement.ts";
import { createBattle, stepBattle } from "../../src/simulation/physical-battle.ts";
import type { BattleDirection, BattleState } from "../../src/simulation/physical-battle.ts";

const NEUTRAL: BattleDirection = { x: 0, y: 0 };

function p1Intent(state: BattleState, extra: Record<string, unknown> = {}) {
  return {
    matchId: state.matchId,
    actorId: "P1" as const,
    generation: state.actors.P1.generation,
    direction: NEUTRAL,
    ...extra,
  };
}

test("R2b dash consumes the configured distance over twelve physical ticks", () => {
  let state = createBattle({ matchId: "r2b-dash-distance", seed: 101 });
  const start = { ...state.fixedActors.P1.position };
  state = stepBattle(state, p1Intent(state, { dash: { x: 1, y: 0 } }));
  for (let tick = 1; tick < state.rules.dashDurationTicks; tick += 1) state = stepBattle(state, p1Intent(state));

  assert.equal(state.tick, state.rules.dashDurationTicks);
  assert.deepEqual(state.fixedActors.P1.position, {
    x: start.x + state.rules.dashDistanceSubunits,
    y: start.y,
  });
  assert.equal(state.dashes.P1, undefined);
  assert.equal(state.dashCooldownUntilTick.P1, state.rules.dashCooldownTicks);
});

test("R2b dash rejects a second start during its cooldown", () => {
  let state = createBattle({ matchId: "r2b-dash-cooldown", seed: 103 });
  state = stepBattle(state, p1Intent(state, { dash: { x: 1, y: 0 } }));
  for (let tick = 1; tick < state.rules.dashDurationTicks; tick += 1) state = stepBattle(state, p1Intent(state));
  const rejected = stepBattle(state, p1Intent(state, { dash: { x: 1, y: 0 } }));
  assert.equal(rejected.lastStep.rejected[0]?.reason, "invalid_transition");
  assert.match(rejected.lastStep.rejected[0]?.detail ?? "", /cooldown/);
  assert.equal(rejected.dashes.P1, undefined);
});

test("R2b dash stops at the first actor and creates the contact bridge automatically", () => {
  const state = createBattle({ matchId: "r2b-dash-contact", seed: 107 });
  const attacker = { x: 49_500, y: 57_500 };
  const target = { x: 50_000, y: 57_500 };
  for (const [actorId, point] of [["P1", attacker], ["E29", target]] as const) {
    const actor = state.actors[actorId];
    actor.location = { area: "castle", castleTeam: "enemy", roomId: "command", pathRooms: ["command"], pathGates: [] };
    actor.currentRoomId = "command";
    actor.position = { x: floorCell(point.x), y: floorCell(point.y) };
    state.fixedActors[actorId].position = { ...point };
    state.fixedActors[actorId].remainder = { x: 0, y: 0 };
  }

  const next = stepBattle(state, p1Intent(state, { dash: { x: 1, y: 0 } }));
  assert.equal(next.actors.E29.health, 3);
  assert.deepEqual(next.fixedActors.P1.position, attacker, "the attacker stops at first contact");
  assert.deepEqual(next.fixedActors.E29.position, { x: 50_600, y: 57_500 });
  assert.equal(next.dashes.P1, undefined);
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), true);
});

test("R2b dash stops at a closed gate instead of tunnelling through it", () => {
  const state = createBattle({ matchId: "r2b-dash-wall", seed: 109 });
  const actor = state.actors.P1;
  const start = { x: 47_500, y: 33_500 };
  actor.position = { x: floorCell(start.x), y: floorCell(start.y) };
  actor.currentRoomId = "corridor_0";
  actor.location = { area: "castle", castleTeam: "player", roomId: "corridor_0", pathRooms: ["central_corridor", "corridor_0"], pathGates: [] };
  state.fixedActors.P1.position = start;
  state.fixedActors.P1.remainder = { x: 0, y: 0 };

  let next = stepBattle(state, p1Intent(state, { dash: { x: -1, y: 0 } }));
  while (next.dashes.P1) next = stepBattle(next, p1Intent(next));
  assert.ok(next.fixedActors.P1.position.x > 46_000, "the actor remains on the approach side of G1");
  assert.equal(next.dashes.P1, undefined, "a wall ends the dash");
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), false);
});
