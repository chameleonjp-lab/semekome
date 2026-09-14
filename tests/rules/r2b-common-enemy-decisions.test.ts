import assert from "node:assert/strict";
import test from "node:test";
import { floorCell } from "../../src/actors/movement.ts";
import { createBattle, stepBattle, type BattleState } from "../../src/simulation/physical-battle.ts";

function p1Intent(state: BattleState) {
  return {
    matchId: state.matchId,
    actorId: "P1" as const,
    generation: state.actors.P1.generation,
    direction: { x: 0 as const, y: 0 as const },
  };
}

function placeP1InEnemyRoom(state: BattleState, enemyId: "E05" | "E09"): { x: number; y: number } {
  const enemy = state.actors[enemyId];
  const enemyPosition = { ...state.fixedActors[enemyId].position };
  const actor = state.actors.P1;
  actor.location = {
    area: "castle",
    castleTeam: "enemy",
    roomId: enemy.currentRoomId,
    pathRooms: [enemy.currentRoomId],
    pathGates: [],
  };
  actor.currentRoomId = enemy.currentRoomId;
  actor.position = { x: floorCell(enemyPosition.x - 1_200), y: floorCell(enemyPosition.y) };
  state.fixedActors.P1.position = { x: enemyPosition.x - 1_200, y: enemyPosition.y };
  state.fixedActors.P1.remainder = { x: 0, y: 0 };
  return enemyPosition;
}

test("R2b physical enemy decisions use the shared priority for every role", () => {
  const state = createBattle({ matchId: "r2b-common-decisions", seed: 401 });
  const next = stepBattle(state, p1Intent(state));

  assert.deepEqual(next.enemyDecisions.E01.intent, { kind: "move_goal", roomId: "battery_a", purpose: "operate" });
  assert.deepEqual(next.enemyDecisions.E05.intent, { kind: "wait", reason: "guard_assigned_room" });
  assert.deepEqual(next.enemyDecisions.E09.intent, { kind: "move_goal", roomId: "ammo_a", purpose: "return" });
  assert.deepEqual(next.enemyDecisions.E17.intent, { kind: "move_goal", roomId: "central_corridor", purpose: "patrol" });
  assert.deepEqual(next.enemyDecisions.E25.intent, { kind: "move_goal", roomId: "central_corridor", purpose: "plaza" });
  assert.deepEqual(next.enemyDecisions.E29.intent, { kind: "move_goal", roomId: "central_corridor", purpose: "assault" });
  assert.equal(Object.keys(next.enemyDecisions).length, 30);
});

test("R2b shooter guards defend through the physical mover without teleporting", () => {
  const state = createBattle({ matchId: "r2b-common-guard", seed: 403 });
  const start = placeP1InEnemyRoom(state, "E05");
  const next = stepBattle(state, p1Intent(state));

  assert.deepEqual(next.enemyDecisions.E05.intent, { kind: "defend", targetId: "P1" });
  assert.equal(next.crew.assignments.E05.task, "defend");
  assert.notDeepEqual(next.fixedActors.E05.position, start);
});

test("R2b ammo carriers retreat through the physical mover when threatened", () => {
  const state = createBattle({ matchId: "r2b-common-carrier", seed: 407 });
  const start = placeP1InEnemyRoom(state, "E09");
  const next = stepBattle(state, p1Intent(state));

  assert.deepEqual(next.enemyDecisions.E09.intent, { kind: "retreat", awayFromId: "P1" });
  assert.equal(next.crew.assignments.E09.task, "retreat");
  assert.ok(next.fixedActors.E09.position.x > start.x || next.fixedActors.E09.position.y !== start.y);
});
