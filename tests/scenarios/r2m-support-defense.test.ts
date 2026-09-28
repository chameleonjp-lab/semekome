import assert from "node:assert/strict";
import test from "node:test";
import { floorCell } from "../../src/actors/movement.ts";
import {
  createBattle,
  stepBattle,
  type BattleDirection,
  type BattleIntent,
  type BattleState,
} from "../../src/simulation/physical-battle.ts";

const NEUTRAL: BattleDirection = { x: 0, y: 0 };

function p1Intent(state: BattleState): BattleIntent {
  return {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    direction: NEUTRAL,
  };
}

function placeInPlayerRoom(state: BattleState, actorId: "P1" | "P2" | "E29", x: number, y: number): void {
  const actor = state.actors[actorId];
  actor.location = {
    area: "castle",
    castleTeam: "player",
    roomId: "central_corridor",
    pathRooms: ["central_corridor"],
    pathGates: [],
  };
  actor.currentRoomId = "central_corridor";
  actor.position = { x: floorCell(x), y: floorCell(y) };
  state.fixedActors[actorId] = { position: { x, y }, remainder: { x: 0, y: 0 } };
}

function keepEnemyDecisionStill(state: BattleState, actorId: "E29"): void {
  state.enemyDecisions[actorId] = {
    generation: state.actors[actorId].generation,
    nextDecisionTick: state.tick + 999,
    intent: { kind: "wait", reason: "r2m_support_defense_fixture" },
  };
}

test("P2はP1が離れていても同室の侵入敵へ物理突進で防衛する", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2m-support-defense", seed: 20260915 });
  placeInPlayerRoom(state, "P1", 34_500, 33_500);
  state.actors.P1.location = {
    area: "castle",
    castleTeam: "enemy",
    roomId: "central_corridor",
    pathRooms: ["central_corridor"],
    pathGates: [],
  };
  placeInPlayerRoom(state, "P2", 94_500, 34_500);
  placeInPlayerRoom(state, "E29", 95_700, 34_500);
  state.actors.E29.health = 1;
  state.actors.E29.canAssaultOtherVehicle = false;
  keepEnemyDecisionStill(state, "E29");

  const start = { ...state.fixedActors.P2.position };
  let contact = false;
  for (let tick = 0; tick < 30 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, p1Intent(state));
    if (state.lastStep.acceptedInputKinds.includes("bridge:actor_contact")) {
      contact = true;
      break;
    }
  }

  assert.equal(state.actors.P1.location.castleTeam, "enemy", "the public player remains away from the home defence room");
  assert.equal(contact, true, "P2 reaches the intruder through the physical dash bridge");
  assert.equal(state.actors.E29.alive, false, "the local support dash defeats the intruder");
  assert.ok((state.actors.E29.respawnAtTick ?? 0) > state.tick, "the defeated intruder keeps its own respawn deadline");
  assert.notDeepEqual(state.fixedActors.P2.position, start, "P2 moves through fixed-point simulation instead of teleporting");
  assert.equal(state.lastStep.rejected.length, 0);
});

test("P2は同室でない敵を見て別室へ移動せず、敵が消えると補給運搬へ戻る", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2m-support-local-defense", seed: 20260916 });
  placeInPlayerRoom(state, "P1", 34_500, 33_500);
  state.actors.P1.location = {
    area: "castle",
    castleTeam: "enemy",
    roomId: "central_corridor",
    pathRooms: ["central_corridor"],
    pathGates: [],
  };
  placeInPlayerRoom(state, "P2", 94_500, 34_500);
  const p2Start = { ...state.fixedActors.P2.position };
  state.actors.E29.location = {
    area: "castle",
    castleTeam: "player",
    roomId: "battery_a",
    pathRooms: ["battery_a"],
    pathGates: [],
  };
  state.actors.E29.currentRoomId = "battery_a";
  state.actors.E29.position = { x: 103, y: 13 };
  state.fixedActors.E29 = { position: { x: 103_500, y: 13_500 }, remainder: { x: 0, y: 0 } };
  state.actors.E29.health = 1;
  state.actors.E29.canAssaultOtherVehicle = false;
  keepEnemyDecisionStill(state, "E29");

  state = stepBattle(state, p1Intent(state));
  assert.equal(state.dashes.P2, undefined, "a different room is not a hidden support target");
  assert.deepEqual(state.fixedActors.P2.position, p2Start, "P2 does not leave its room for an unseen enemy");
  assert.notEqual(state.crew.assignments.P2.task, "defend");

  state.actors.E29.location = {
    area: "castle",
    castleTeam: "player",
    roomId: "central_corridor",
    pathRooms: ["central_corridor"],
    pathGates: [],
  };
  state.actors.E29.currentRoomId = "central_corridor";
  state.actors.E29.position = { x: floorCell(95_700), y: floorCell(34_500) };
  state.fixedActors.E29 = { position: { x: 95_700, y: 34_500 }, remainder: { x: 0, y: 0 } };
  for (let tick = 0; tick < 30 && state.actors.E29.alive; tick += 1) state = stepBattle(state, p1Intent(state));
  assert.equal(state.actors.E29.alive, false,
    `the same intruder becomes local when it enters the room (tick=${state.tick}, p2=${JSON.stringify(state.fixedActors.P2.position)}, ` +
    `dash=${JSON.stringify(state.dashes.P2)}, e29=${JSON.stringify(state.fixedActors.E29.position)}, ` +
    `assignment=${JSON.stringify(state.crew.assignments.P2)})`);

  state.logistics.ports["player:supply_1"].nextSpawnTick = state.tick;
  for (let tick = 0; tick < 4; tick += 1) state = stepBattle(state, p1Intent(state));
  assert.ok(["carry", "deliver", "idle"].includes(state.crew.assignments.P2.task), "P2 returns to the normal support loop after defence");
  assert.equal(state.actors.P2.location.area, "castle");
});
