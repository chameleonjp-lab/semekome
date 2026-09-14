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

function placeP1InEnemyRoom(state: BattleState, roomId: string, position: { x: number; y: number }): void {
  const actor = state.actors.P1;
  actor.location = { area: "castle", castleTeam: "enemy", roomId, pathRooms: [roomId], pathGates: [] };
  actor.currentRoomId = roomId;
  actor.position = { x: floorCell(position.x), y: floorCell(position.y) };
  state.fixedActors.P1.position = { ...position };
  state.fixedActors.P1.remainder = { x: 0, y: 0 };
}

test("R2b internal soldiers choose authored plaza/assault goals and move without teleporting", () => {
  const state = createBattle({ matchId: "r2b-internal-goals", seed: 311 });
  const next = stepBattle(state, p1Intent(state));

  assert.deepEqual(next.enemyDecisions.E25.intent, { kind: "move_goal", roomId: "central_corridor", purpose: "plaza" });
  assert.deepEqual(next.enemyDecisions.E29.intent, { kind: "move_goal", roomId: "central_corridor", purpose: "assault" });
  assert.equal(next.actors.E25.currentRoomId, "repair");
  assert.equal(next.actors.E29.currentRoomId, "command");
  assert.equal(next.fixedActors.E25.position.x, state.fixedActors.E25.position.x - 50);
  assert.equal(next.fixedActors.E29.position.x, state.fixedActors.E29.position.x - 50);
  assert.equal(next.fixedActors.E25.position.y, state.fixedActors.E25.position.y);
  assert.equal(next.fixedActors.E29.position.y, state.fixedActors.E29.position.y);
});

test("R2b internal soldier defense starts an AI dash and bridges damage with the public tick", () => {
  const state = createBattle({ matchId: "r2b-internal-defend", seed: 313 });
  const enemyPosition = { ...state.fixedActors.E17.position };
  placeP1InEnemyRoom(state, "central_corridor", { x: enemyPosition.x - 1_200, y: enemyPosition.y });

  let next = state;
  for (let index = 0; index < 12 && next.actors.P1.health === next.actors.P1.maxHealth; index += 1) {
    next = stepBattle(next, p1Intent(next));
  }

  assert.deepEqual(next.enemyDecisions.E17.intent, { kind: "defend", targetId: "P1" });
  assert.equal(next.actors.P1.health, next.actors.P1.maxHealth - next.rules.dashActorDamage);
  assert.equal(next.lastStep.events.some((event) => event.type === "actor_damaged" && event.actorId === "P1"), true);
});

test("R2b low-health internal soldiers retreat away from a local threat", () => {
  const state = createBattle({ matchId: "r2b-internal-retreat", seed: 317 });
  const enemy = state.actors.E17;
  enemy.health = 2;
  const enemyStart = { ...state.fixedActors.E17.position };
  placeP1InEnemyRoom(state, "central_corridor", { x: enemyStart.x - 1_200, y: enemyStart.y });

  const next = stepBattle(state, p1Intent(state));

  assert.deepEqual(next.enemyDecisions.E17.intent, { kind: "retreat", awayFromId: "P1" });
  assert.ok(next.fixedActors.E17.position.x > enemyStart.x);
  assert.equal(next.lastStep.events.some((event) => event.type === "actor_damaged"), false);
});
