import assert from "node:assert/strict";
import test from "node:test";
import { assertObjectLocationsUnique, createFloorObject } from "../../src/domain/objects.ts";
import { assertBattleConsistent, createBattle, stepBattle } from "../../src/simulation/battle.ts";
import { observeEnemy } from "../../src/simulation/enemy-rules.ts";
import { stepWorld } from "../../src/simulation/world.ts";

function runThroughFirstEnemySpawn() {
  let state = createBattle({ matchId: "r3-common-delivery-auto", seed: 1201 });
  while (state.world.tick <= 30) state = stepBattle(state);
  return state;
}

test("common ammo carrier picks up a same-room case and reserves the preferred turret slot", () => {
  const state = runThroughFirstEnemySpawn();
  const spawned = Object.values(state.world.objects).find((object) => object.sourceTeam === "enemy" && object.id.startsWith("common-case-enemy-"));
  assert.ok(spawned);
  assert.equal(spawned.location.kind, "floor");
  assert.equal(spawned.location.kind === "floor" && spawned.location.roomId, "ammo_a");

  const next = stepBattle(state);
  const reserved = next.world.objects[spawned.id];
  assert.ok(reserved);
  assert.equal(reserved.location.kind, "reserved-carried");
  assert.equal(reserved.location.kind === "reserved-carried" && reserved.location.actorId, "E09");
  const reservation = reserved.location.kind === "reserved-carried" ? next.world.reservations[reserved.location.reservationId] : undefined;
  assert.equal(reservation?.kind, "delivery");
  assert.equal(reservation?.targetTurretId, "T1");
  assert.equal(reservation?.targetStagingSlot, 0);
  assert.equal(next.world.actors.E09.cargoIds.includes(spawned.id), true);
  assert.deepEqual(observeEnemy(next, next.world.actors.E09).cargo, [spawned.id]);
  assert.equal(next.world.lastStep.acceptedInputKinds.filter((kind) => kind === "pickup_object").length, 1);
  assert.equal(next.world.lastStep.acceptedInputKinds.filter((kind) => kind === "reserve_delivery").length, 1);
  assertObjectLocationsUnique(next.world);
  assertBattleConsistent(next);
});

test("reserved common carrier advances one authored room link toward the turret", () => {
  const spawnedState = runThroughFirstEnemySpawn();
  let state = stepBattle(spawnedState);
  const reservation = Object.values(state.world.reservations).find((candidate) => candidate.kind === "delivery");
  assert.ok(reservation);
  const targetTurret = state.world.layout.enemy.turrets.find((turret) => turret.id === reservation.targetTurretId);
  assert.ok(targetTurret);
  assert.equal(state.world.actors.E09.currentRoomId, "ammo_a");

  const next = stepBattle(state);
  assert.equal(next.world.lastStep.rejected.length, 0);
  assert.equal(next.world.lastStep.acceptedInputKinds.includes("move_actor"), true);
  assert.equal(next.world.actors.E09.currentRoomId, targetTurret.roomId);
  assert.deepEqual(next.world.actors.E09.location.pathRooms.slice(-2), ["ammo_a", targetTurret.roomId]);
  assert.equal(next.world.objects[reservation.objectIds[0]]?.location.kind, "reserved-carried");
  assert.equal(next.world.reservations[reservation.id]?.targetTurretId, targetTurret.id);
  assertObjectLocationsUnique(next.world);
  assertBattleConsistent(next);
});

test("common carrier enqueues the reserved case after reaching the turret room", () => {
  let state = createBattle({ matchId: "r3-common-delivery-handoff", seed: 1227 });
  state.world = createFloorObject(state.world, {
    id: "manual-common-handoff-case",
    weaponId: "standard_slug",
    sourceTeam: "enemy",
    weight: 1,
    originGroupId: "manual-common-handoff-group",
    roomId: "ammo_a",
    position: { x: 90, y: 13 },
  });

  state = stepBattle(state);
  const reservation = Object.values(state.world.reservations).find((candidate) => candidate.kind === "delivery");
  assert.ok(reservation);
  assert.equal(reservation.targetTurretId, "T1");
  assert.equal(state.world.actors.E09.currentRoomId, "ammo_a");

  state = stepBattle(state);
  assert.equal(state.world.actors.E09.currentRoomId, "battery_a");
  assert.equal(state.world.lastStep.acceptedInputKinds.includes("enqueue_object"), false);

  state = stepBattle(state);
  const object = state.world.objects["manual-common-handoff-case"];
  assert.ok(object);
  assert.deepEqual(object.location, { kind: "queue", team: "enemy", turretId: "T1", index: 0 });
  assert.deepEqual(state.world.actors.E09.cargoIds, []);
  assert.equal(state.world.reservations[reservation.id], undefined);
  assert.deepEqual(state.queued[object.id], state.turrets.enemy.T1.settings);
  assert.equal(state.world.lastStep.acceptedInputKinds.includes("enqueue_object"), true);
  assertObjectLocationsUnique(state.world);
  assertBattleConsistent(state);
});

test("common carrier keeps a reserved case while the target turret queue is full", () => {
  let state = createBattle({ matchId: "r3-common-delivery-queue-full", seed: 1229 });
  for (const id of ["manual-common-queue-a", "manual-common-queue-b"]) {
    state.world = createFloorObject(state.world, {
      id,
      weaponId: "standard_slug",
      sourceTeam: "enemy",
      weight: 1,
      originGroupId: `${id}-group`,
      roomId: "battery_a",
      position: { x: 106, y: 13 },
    });
    state.world = stepWorld(state.world, {
      kind: "pickup_object",
      objectId: id,
      actorId: "E01",
      generation: state.world.actors.E01.generation,
      matchId: state.world.matchId,
    });
    state.world = stepWorld(state.world, {
      kind: "enqueue_object",
      objectId: id,
      actorId: "E01",
      generation: state.world.actors.E01.generation,
      team: "enemy",
      turretId: "T1",
      matchId: state.world.matchId,
    });
    state.queued[id] = { ...state.turrets.enemy.T1.settings };
  }
  state.world = createFloorObject(state.world, {
    id: "manual-common-queue-full-case",
    weaponId: "standard_slug",
    sourceTeam: "enemy",
    weight: 1,
    originGroupId: "manual-common-queue-full-group",
    roomId: "ammo_a",
    position: { x: 90, y: 13 },
  });
  assertBattleConsistent(state);

  state = stepBattle(state);
  const reservation = Object.values(state.world.reservations).find((candidate) => candidate.kind === "delivery");
  assert.ok(reservation);
  state = stepBattle(state);
  assert.equal(state.world.actors.E09.currentRoomId, "battery_a");
  state = stepBattle(state);

  const object = state.world.objects["manual-common-queue-full-case"];
  assert.ok(object);
  assert.equal(object.location.kind, "reserved-carried");
  assert.equal(state.world.reservations[reservation.id]?.targetTurretId, "T1");
  assert.deepEqual(state.world.actors.E09.cargoIds, [object.id]);
  assert.equal(state.world.lastStep.acceptedInputKinds.includes("enqueue_object"), false);
  assert.equal(Object.values(state.world.objects).filter((candidate) =>
    candidate.location.kind === "queue" && candidate.location.team === "enemy" && candidate.location.turretId === "T1",
  ).length, 2);
  assertObjectLocationsUnique(state.world);
  assertBattleConsistent(state);
});

test("reserved common carrier does not skip an intermediate room", () => {
  let state = createBattle({ matchId: "r3-common-delivery-route", seed: 1221 });
  state.turrets.enemy.T1.disabledUntilTick = 120;
  state.world = createFloorObject(state.world, {
    id: "manual-common-route-case",
    weaponId: "standard_slug",
    sourceTeam: "enemy",
    weight: 1,
    originGroupId: "manual-common-route-group",
    roomId: "ammo_a",
    position: { x: 90, y: 13 },
  });

  state = stepBattle(state);
  const reservation = Object.values(state.world.reservations).find((candidate) => candidate.kind === "delivery");
  assert.ok(reservation);
  assert.equal(reservation.targetTurretId, "T2");
  assert.equal(state.world.actors.E09.currentRoomId, "ammo_a");

  state = stepBattle(state);
  assert.equal(state.world.lastStep.rejected.length, 0);
  assert.equal(state.world.actors.E09.currentRoomId, "central_corridor");

  state = stepBattle(state);
  assert.equal(state.world.lastStep.rejected.length, 0);
  assert.equal(state.world.actors.E09.currentRoomId, "battery_b");
  assert.equal(state.world.objects["manual-common-route-case"]?.location.kind, "reserved-carried");
  assertObjectLocationsUnique(state.world);
  assertBattleConsistent(state);
});

test("two common carriers claim separate staging slots without duplicating a case", () => {
  let state = createBattle({ matchId: "r3-common-delivery-slots", seed: 1207 });
  const roomId = "ammo_a";
  state.world = createFloorObject(state.world, {
    id: "manual-common-case-a",
    weaponId: "standard_slug",
    sourceTeam: "enemy",
    weight: 1,
    originGroupId: "manual-common-group-a",
    roomId,
    position: { x: 90, y: 13 },
  });
  state.world = createFloorObject(state.world, {
    id: "manual-common-case-b",
    weaponId: "dense_payload",
    sourceTeam: "enemy",
    weight: 2,
    originGroupId: "manual-common-group-b",
    roomId,
    position: { x: 91, y: 13 },
  });

  state = stepBattle(state);
  const reservations = Object.values(state.world.reservations).filter((reservation) => reservation.kind === "delivery");
  assert.equal(reservations.length, 2);
  assert.deepEqual(reservations.map((reservation) => `${reservation.targetTurretId}:${reservation.targetStagingSlot}`), ["T1:0", "T1:1"]);
  assert.deepEqual(state.world.actors.E09.cargoIds, ["manual-common-case-a"]);
  assert.deepEqual(state.world.actors.E10.cargoIds, ["manual-common-case-b"]);
  assertObjectLocationsUnique(state.world);
  assertBattleConsistent(state);
});

test("common delivery reselects a stable alternate turret when the preferred one is disabled", () => {
  let state = createBattle({ matchId: "r3-common-delivery-disabled", seed: 1213 });
  state.turrets.enemy.T1.disabledUntilTick = 120;
  state.world = createFloorObject(state.world, {
    id: "manual-common-case-disabled",
    weaponId: "standard_slug",
    sourceTeam: "enemy",
    weight: 1,
    originGroupId: "manual-common-group-disabled",
    roomId: "ammo_a",
    position: { x: 90, y: 13 },
  });

  state = stepBattle(state);
  const reservation = Object.values(state.world.reservations).find((candidate) => candidate.kind === "delivery");
  assert.equal(reservation?.targetTurretId, "T2");
  assert.equal(reservation?.targetStagingSlot, 0);
  assert.equal(state.world.objects["manual-common-case-disabled"]?.location.kind, "reserved-carried");
  assertObjectLocationsUnique(state.world);
  assertBattleConsistent(state);
});
