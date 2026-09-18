import assert from "node:assert/strict";
import test from "node:test";
import { floorCell } from "../../src/actors/movement.ts";
import { createBattle, stepBattle, type BattleState } from "../../src/simulation/physical-battle.ts";

const PLAZA_Y = 35_500;

function p1Intent(state: BattleState, direction: { x: -1 | 0 | 1; y: -1 | 0 | 1 }) {
  return {
    matchId: state.matchId,
    actorId: "P1" as const,
    generation: state.actors.P1.generation,
    direction,
  };
}

function placeInPlaza(state: BattleState, actorId: "P1" | "E25" | "E29", point: { x: number; y: number }): void {
  const actor = state.actors[actorId];
  actor.location = { area: "plaza", pathRooms: [], pathGates: [] };
  actor.currentRoomId = "plaza";
  actor.position = { x: floorCell(point.x), y: floorCell(point.y) };
  state.fixedActors[actorId] = { position: { ...point }, remainder: { x: 0, y: 0 } };
}

test("R2b physical movement crosses the authored front exit into the plaza", () => {
  const state = createBattle({ matchId: "r2b-plaza-exit", seed: 601 });
  const player = state.actors.P1;
  player.position = { x: 123, y: 35 };
  player.currentRoomId = "central_corridor";
  player.location = {
    area: "castle",
    castleTeam: "player",
    roomId: "central_corridor",
    pathRooms: ["central_corridor"],
    pathGates: [],
  };
  state.fixedActors.P1 = { position: { x: 123_500, y: PLAZA_Y }, remainder: { x: 0, y: 0 } };

  const next = stepBattle(state, p1Intent(state, { x: 1, y: 0 }));

  assert.equal(next.actors.P1.location.area, "plaza");
  assert.equal(next.actors.P1.currentRoomId, "plaza");
  assert.deepEqual(next.fixedActors.P1.position, { x: 500, y: PLAZA_Y });
  assert.deepEqual(next.actors.P1.position, { x: 0, y: 35 });
});

test("R2b plaza entry waits for live guards, then enters the opposing castle", () => {
  let state = createBattle({ matchId: "r2b-plaza-guard", seed: 607 });
  placeInPlaza(state, "P1", { x: 125_500, y: PLAZA_Y });
  placeInPlaza(state, "E25", { x: 115_500, y: PLAZA_Y });

  let next = stepBattle(state, p1Intent(state, { x: 1, y: 0 }));
  assert.equal(next.actors.P1.location.area, "plaza");
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:plaza_entry"), false);

  next.actors.E25.alive = false;
  next.actors.E25.health = 0;
  next.actors.E25.respawnAtTick = 9_999;
  next = stepBattle(next, p1Intent(next, { x: 1, y: 0 }));

  assert.equal(next.actors.P1.location.area, "castle");
  assert.equal(next.actors.P1.location.castleTeam, "enemy");
  assert.equal(next.actors.P1.currentRoomId, "central_corridor");
  assert.deepEqual(next.fixedActors.P1.position, { x: 2_500, y: PLAZA_Y });
  assert.equal(next.plaza.enemyCrossings["P1:0"]?.allowed, true);
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:plaza_entry"), false);
});

test("R2b dash contact is resolved between opposing actors in the plaza", () => {
  const state = createBattle({ matchId: "r2b-plaza-dash", seed: 613 });
  placeInPlaza(state, "P1", { x: 10_000, y: PLAZA_Y });
  placeInPlaza(state, "E25", { x: 10_500, y: PLAZA_Y });
  state.actors.P1.protectedUntilTick = null;
  state.actors.E25.protectedUntilTick = null;
  state.actors.E25.damageImmuneUntilTick = null;
  state.enemyDecisions.E25 = {
    generation: state.actors.E25.generation,
    nextDecisionTick: 999,
    intent: { kind: "wait", reason: "test" },
  };

  const next = stepBattle(state, p1Intent(state, { x: 0, y: 0 }));

  // Neutral input alone must not create a contact.
  assert.equal(next.actors.E25.health, next.actors.E25.maxHealth);
  const dashed = stepBattle(next, { ...p1Intent(next, { x: 0, y: 0 }), dash: { x: 1, y: 0 } });
  assert.equal(dashed.actors.E25.health, dashed.actors.E25.maxHealth - dashed.rules.dashActorDamage);
  assert.equal(dashed.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), true);
  assert.equal(dashed.actors.P1.location.area, "plaza");
  assert.equal(dashed.actors.E25.location.area, "plaza");
});

test("R2b assault NPCs can cross from the plaza into the opposing castle", () => {
  const state = createBattle({ matchId: "r2b-plaza-assault", seed: 619 });
  placeInPlaza(state, "E29", { x: 750, y: PLAZA_Y });

  const next = stepBattle(state, p1Intent(state, { x: 0, y: 0 }));

  assert.equal(next.actors.E29.location.area, "castle");
  assert.equal(next.actors.E29.location.castleTeam, "player");
  assert.equal(next.actors.E29.currentRoomId, "central_corridor");
  assert.deepEqual(next.fixedActors.E29.position, { x: 123_500, y: PLAZA_Y });
  assert.equal(next.plaza.playerCrossings["E29:0"]?.allowed, true);
});
