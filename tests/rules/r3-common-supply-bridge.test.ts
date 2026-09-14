import assert from "node:assert/strict";
import test from "node:test";
import { cellCenter, floorCell } from "../../src/actors/movement.ts";
import { assertObjectLocationsUnique } from "../../src/domain/objects.ts";
import {
  createBattle,
  getInteraction,
  stepBattle,
  type BattleState,
} from "../../src/simulation/physical-battle.ts";

function spawnOnePlayerBatch(state: BattleState): BattleState {
  for (const port of Object.values(state.logistics.ports)) {
    port.nextSpawnTick = port.team === "player" ? 0 : state.tick + 10_000;
  }
  return stepBattle(state);
}

function placePlayerAt(state: BattleState, position: { x: number; y: number }, roomId: string): void {
  const actor = state.actors.P1;
  actor.location = { area: "castle", castleTeam: "player", roomId, pathRooms: [roomId], pathGates: [] };
  actor.currentRoomId = roomId;
  actor.position = { x: floorCell(position.x), y: floorCell(position.y) };
  state.fixedActors.P1 = { position: { ...position }, remainder: { x: 0, y: 0 } };
}

test("R3 supply cases project their common weapon identity and origin", () => {
  const state = spawnOnePlayerBatch(createBattle({ matchId: "r3-common-projection", seed: 701 }));
  const spawned = state.lastStep.events.find((event) => event.type === "case_spawned" && event.team === "player");
  assert.ok(spawned && spawned.type === "case_spawned");

  const caseState = state.battleCases[spawned.objectId];
  const object = state.objects[spawned.objectId];
  assert.ok(caseState);
  assert.ok(object);
  assert.equal(object.weaponId, caseState.type);
  assert.equal(object.sourceTeam, caseState.sourceTeam);
  assert.equal(object.originGroupId, caseState.originGroupId);
  assertObjectLocationsUnique(state);
});

test("R3 handoff enqueues the same case through the common object transition", () => {
  let state = spawnOnePlayerBatch(createBattle({ matchId: "r3-common-enqueue", seed: 709 }));
  const caseState = Object.values(state.battleCases).find((candidate) => candidate.currentTeam === "player" && candidate.location === "floor");
  assert.ok(caseState?.position);

  placePlayerAt(state, caseState.position, caseState.roomId);
  let interaction = getInteraction(state, "P1", 0);
  assert.equal(interaction.pickupCaseId, caseState.id);
  state = stepBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    handle: "pickup",
    slot: 0,
    contextToken: interaction.contextToken,
  });
  assert.equal(state.lastStep.rejected.length, 0);

  const turret = state.artillery.turrets["player:T1"];
  assert.ok(turret);
  placePlayerAt(state, turret.operatorPosition, turret.roomId);
  state.artillery.nextLaunchTick.player = state.tick + 1_000;
  state.nextLaunchTick.player = state.artillery.nextLaunchTick.player;
  interaction = getInteraction(state, "P1", 0);
  assert.equal(interaction.handles.includes("deliver"), true);

  state = stepBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    handle: "deliver",
    slot: 0,
    route: "detour",
    part: "P3",
    contextToken: interaction.contextToken,
  });

  const queued = state.battleCases[caseState.id];
  const projected = state.objects[caseState.id];
  const currentTurret = state.artillery.turrets["player:T1"];
  assert.equal(state.lastStep.rejected.length, 0);
  assert.equal(queued.location, "queue");
  assert.equal(queued.turretId, currentTurret.id);
  assert.equal(queued.route, "detour");
  assert.equal(queued.targetPart, "P3");
  assert.deepEqual(currentTurret.queueIds, [caseState.id]);
  assert.equal(projected.weaponId, queued.type);
  assert.deepEqual(projected.location, { kind: "queue", team: "player", turretId: currentTurret.id, index: 0 });
  assert.equal(state.lastStep.events.filter((event) => event.type === "object_moved" && event.objectId === caseState.id && event.location.kind === "queue").length, 1);
  assertObjectLocationsUnique(state);
});

test("R3 common queue rejection restores the physical handoff", () => {
  let state = spawnOnePlayerBatch(createBattle({ matchId: "r3-common-enqueue-reject", seed: 719 }));
  const caseState = Object.values(state.battleCases).find((candidate) => candidate.currentTeam === "player" && candidate.location === "floor");
  assert.ok(caseState);
  const turret = state.artillery.turrets["player:T1"];
  assert.ok(turret);
  const layoutTurret = state.layout.home.turrets.find((candidate) => candidate.id === turret.id);
  assert.ok(layoutTurret);
  layoutTurret.queueCapacity = 0;

  placePlayerAt(state, turret.operatorPosition, turret.roomId);
  caseState.location = "handoff";
  caseState.position = { ...turret.stagingPositions[0] };
  caseState.currentPosition = { ...caseState.position };
  caseState.ownerActorId = undefined;
  caseState.ownerGeneration = undefined;
  caseState.turretId = turret.id;
  caseState.stagingSlot = 0;
  turret.handoffIds = [caseState.id];
  turret.stagingSlots = [caseState.id, null];
  state.artillery.nextLaunchTick.player = state.tick + 1_000;
  state.nextLaunchTick.player = state.artillery.nextLaunchTick.player;

  state = stepBattle(state);

  assert.equal(state.battleCases[caseState.id].location, "handoff");
  assert.deepEqual(state.actors.P1.cargoIds, []);
  assert.deepEqual(state.artillery.turrets["player:T1"].handoffIds, [caseState.id]);
  assert.deepEqual(state.artillery.turrets["player:T1"].stagingSlots, [caseState.id, null]);
  assert.deepEqual(state.artillery.turrets["player:T1"].queueIds, []);
  assertObjectLocationsUnique(state);
});
