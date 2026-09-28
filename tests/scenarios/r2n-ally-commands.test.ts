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

function p1Intent(state: BattleState, partial: Partial<BattleIntent> = {}): BattleIntent {
  return {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    direction: NEUTRAL,
    ...partial,
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

function freezeEnemyDecision(state: BattleState): void {
  state.enemyDecisions.E29 = {
    generation: state.actors.E29.generation,
    nextDecisionTick: state.tick + 999,
    intent: { kind: "wait", reason: "r2n_ally_command_fixture" },
  };
}

test("P1の守備命令はP2の補給移動を止め、解除後に補給ループへ戻す", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2n-ally-command-hold", seed: 20260917 });
  state.logistics.ports["player:supply_1"].nextSpawnTick = state.tick;
  const start = { ...state.fixedActors.P2.position };

  state = stepBattle(state, p1Intent(state, { allyCommand: { allyId: "P2", kind: "hold" } }));
  assert.deepEqual(state.allyOrders.P2?.kind, "hold");
  assert.ok(state.lastStep.acceptedInputKinds.includes("ally:hold:P2"));
  for (let tick = 0; tick < 12; tick += 1) state = stepBattle(state, p1Intent(state));
  assert.deepEqual(state.fixedActors.P2.position, start, "hold keeps P2 at its current physical position");
  assert.equal(state.crew.assignments.P2.task, "idle");

  state = stepBattle(state, p1Intent(state, { allyCommand: { allyId: "P2", kind: "supply" } }));
  assert.equal(state.allyOrders.P2, null, "supply is an explicit cancellation of hold");
  assert.ok(state.lastStep.acceptedInputKinds.includes("ally:supply:P2"));
  let movedAfterRelease = false;
  for (let tick = 0; tick < 120; tick += 1) {
    const previous = { ...state.fixedActors.P2.position };
    state = stepBattle(state, p1Intent(state));
    if (state.fixedActors.P2.position.x !== previous.x || state.fixedActors.P2.position.y !== previous.y) {
      movedAfterRelease = true;
      break;
    }
  }
  assert.equal(movedAfterRelease, true, "P2 resumes the ordinary supply route after the order is cleared");
});

test("守備命令中のP2は同室の敵だけを防衛し、別室救援は作らない", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2n-ally-command-defense", seed: 20260918 });
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
  freezeEnemyDecision(state);

  state = stepBattle(state, p1Intent(state, { allyCommand: { allyId: "P2", kind: "hold" } }));
  let contact = false;
  for (let tick = 0; tick < 30 && state.actors.E29.alive; tick += 1) {
    state = stepBattle(state, p1Intent(state));
    contact = contact || state.lastStep.acceptedInputKinds.includes("bridge:actor_contact");
  }
  assert.equal(contact, true, "the commanded support actor uses the existing physical contact bridge");
  assert.equal(state.actors.E29.alive, false);
  assert.equal(state.allyOrders.P2?.kind, "hold");
  for (let tick = 0; tick < 4; tick += 1) state = stepBattle(state, p1Intent(state));
  assert.equal(state.crew.assignments.P2.task, "idle", "P2 remains held instead of silently returning to supply");

  const p2Position = { ...state.fixedActors.P2.position };
  state.actors.E29.location = {
    area: "castle",
    castleTeam: "player",
    roomId: "battery_a",
    pathRooms: ["battery_a"],
    pathGates: [],
  };
  state.actors.E29.currentRoomId = "battery_a";
  state.fixedActors.E29 = { position: { x: 103_500, y: 13_500 }, remainder: { x: 0, y: 0 } };
  state.actors.E29.alive = true;
  state.actors.E29.health = 1;
  state = stepBattle(state, p1Intent(state));
  assert.deepEqual(state.fixedActors.P2.position, p2Position, "a held order does not create a hidden cross-room rescue route");
  assert.equal(state.dashes.P2, undefined);
});

test("味方命令はP2/P3と現行世代に限定し、復活後へ古い守備命令を持ち越さない", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2n-ally-command-generation", seed: 20260919 });
  state = stepBattle(state, p1Intent(state, { allyCommand: { allyId: "P2", kind: "hold" } }));
  const rejected = stepBattle(state, p1Intent(state, {
    allyCommand: { allyId: "P1", kind: "hold" } as unknown as BattleIntent["allyCommand"],
  }));
  assert.equal(rejected.lastStep.rejected[0]?.reason, "invalid_transition");
  assert.equal(rejected.allyOrders.P2?.kind, "hold");

  rejected.actors.P2.health = 0;
  state = stepBattle(rejected, p1Intent(state));
  assert.equal(state.actors.P2.alive, false);
  const generationBeforeRespawn = state.actors.P2.generation;
  for (let tick = 0; tick < 400 && !state.actors.P2.alive; tick += 1) state = stepBattle(state);
  assert.equal(state.actors.P2.alive, true);
  assert.equal(state.actors.P2.generation, generationBeforeRespawn + 1);
  assert.equal(state.allyOrders.P2, null, "a new life generation receives the automatic supply policy");
});
