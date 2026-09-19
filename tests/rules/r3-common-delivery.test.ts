import assert from "node:assert/strict";
import test from "node:test";
import { assertObjectLocationsUnique, createFloorObject } from "../../src/domain/objects.ts";
import { assertBattleConsistent, createBattle, stepBattle } from "../../src/simulation/battle.ts";
import { observeEnemy } from "../../src/simulation/enemy-rules.ts";

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
