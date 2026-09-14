import assert from "node:assert/strict";
import test from "node:test";
import { assertObjectLocationsUnique } from "../../src/domain/objects.ts";
import { createWorld, stepWorld } from "../../src/simulation/world.ts";

test("R3 common supply generation accepts one authored floor object", () => {
  const world = createWorld({ matchId: "r3-common-spawn", seed: 727 });
  const port = world.layout.home.supplyPorts[0];
  assert.ok(port);
  const input = {
    kind: "spawn_supply" as const,
    objectId: "case-player-supply_1-g01",
    team: "player" as const,
    portId: port.id,
    weaponId: "standard_slug",
    weight: 1,
    originGroupId: "group-player-supply_1-g01",
    roomId: port.roomId,
    position: { ...port.cell },
    matchId: world.matchId,
  };

  const next = stepWorld(world, input);
  const object = next.objects[input.objectId];
  assert.equal(next.lastStep.rejected.length, 0);
  assert.equal(next.lastStep.acceptedInputKinds.includes("spawn_supply"), true);
  assert.deepEqual(object?.location, {
    kind: "floor",
    team: "player",
    roomId: port.roomId,
    position: port.cell,
  });
  assert.equal(next.lastStep.events.filter((event) => event.type === "case_spawned" && event.objectId === input.objectId).length, 1);
  assertObjectLocationsUnique(next);
});

test("R3 common supply generation rejects duplicate ids without consuming another object", () => {
  const world = createWorld({ matchId: "r3-common-spawn-duplicate", seed: 733 });
  const port = world.layout.home.supplyPorts[0];
  assert.ok(port);
  const input = {
    kind: "spawn_supply" as const,
    objectId: "case-player-supply_1-g01",
    team: "player" as const,
    portId: port.id,
    weaponId: "standard_slug",
    weight: 1,
    originGroupId: "group-player-supply_1-g01",
    roomId: port.roomId,
    position: { ...port.cell },
    matchId: world.matchId,
  };
  const spawned = stepWorld(world, input);
  const duplicate = stepWorld(spawned, input);

  assert.equal(duplicate.lastStep.rejected.length, 1);
  assert.equal(duplicate.lastStep.rejected[0]?.reason, "invalid_object_transition");
  assert.equal(Object.keys(duplicate.objects).length, 1);
  assert.equal(duplicate.lastStep.events.some((event) => event.type === "case_spawned"), false);
  assertObjectLocationsUnique(duplicate);
});

test("R3 common delivery reservation captures the turret and cargo owner", () => {
  const world = createWorld({ matchId: "r3-common-delivery", seed: 739 });
  const port = world.layout.home.supplyPorts[0];
  const turret = world.layout.home.turrets[0];
  assert.ok(port);
  assert.ok(turret);
  const objectId = "case-player-supply_1-g01";
  const spawned = stepWorld(world, {
    kind: "spawn_supply",
    objectId,
    team: "player",
    portId: port.id,
    weaponId: "standard_slug",
    weight: 1,
    originGroupId: "group-player-supply_1-g01",
    roomId: port.roomId,
    position: { ...port.cell },
    matchId: world.matchId,
  });
  const pickedUp = stepWorld(spawned, {
    kind: "pickup_object",
    objectId,
    actorId: "P1",
    generation: spawned.actors.P1.generation,
    matchId: world.matchId,
  });
  const reservationId = "delivery:r3-common-delivery:P1:case-player-supply_1-g01";
  const reserved = stepWorld(pickedUp, {
    kind: "reserve_delivery",
    objectId,
    actorId: "P1",
    generation: pickedUp.actors.P1.generation,
    team: "player",
    turretId: turret.id,
    stagingSlot: 0,
    reservationId,
    matchId: world.matchId,
  });

  assert.equal(reserved.lastStep.rejected.length, 0);
  assert.equal(reserved.objects[objectId]?.location.kind, "reserved-carried");
  assert.equal(reserved.objects[objectId]?.location.kind === "reserved-carried" && reserved.objects[objectId].location.reservationId, reservationId);
  assert.equal(reserved.reservations[reservationId]?.kind, "delivery");
  assert.equal(reserved.reservations[reservationId]?.targetTurretId, turret.id);
  assert.equal(reserved.reservations[reservationId]?.targetStagingSlot, 0);
  assert.equal(reserved.actors.P1.reservationIds.includes(reservationId), true);
  assertObjectLocationsUnique(reserved);

  const dropped = stepWorld(reserved, {
    kind: "drop_object",
    objectId,
    actorId: "P1",
    generation: reserved.actors.P1.generation,
    matchId: world.matchId,
  });
  assert.equal(dropped.lastStep.rejected.length, 0);
  assert.equal(dropped.reservations[reservationId], undefined);
  assert.equal(dropped.actors.P1.reservationIds.includes(reservationId), false);
  assert.equal(dropped.objects[objectId]?.location.kind, "floor");
  assertObjectLocationsUnique(dropped);
});

test("R3 common delivery reservation rejects a duplicate handoff slot", () => {
  const world = createWorld({ matchId: "r3-common-delivery-slot", seed: 743 });
  const port = world.layout.home.supplyPorts[0];
  const turret = world.layout.home.turrets[0];
  assert.ok(port);
  assert.ok(turret);
  const spawn = (objectId: string, groupId: string) => stepWorld(world, {
    kind: "spawn_supply",
    objectId,
    team: "player",
    portId: port.id,
    weaponId: "standard_slug",
    weight: 1,
    originGroupId: groupId,
    roomId: port.roomId,
    position: { ...port.cell },
    matchId: world.matchId,
  });
  const firstId = "case-player-supply_1-g01";
  const secondId = "case-player-supply_1-g02";
  const spawned = spawn(firstId, "group-player-supply_1-g01");
  const spawnedTwice = stepWorld(spawned, {
    kind: "spawn_supply",
    objectId: secondId,
    team: "player",
    portId: port.id,
    weaponId: "standard_slug",
    weight: 1,
    originGroupId: "group-player-supply_1-g02",
    roomId: port.roomId,
    position: { ...port.cell },
    matchId: world.matchId,
  });
  const firstPickedUp = stepWorld(spawnedTwice, {
    kind: "pickup_object",
    objectId: firstId,
    actorId: "P1",
    generation: spawnedTwice.actors.P1.generation,
    matchId: world.matchId,
  });
  const secondPickedUp = stepWorld(firstPickedUp, {
    kind: "pickup_object",
    objectId: secondId,
    actorId: "P2",
    generation: firstPickedUp.actors.P2.generation,
    matchId: world.matchId,
  });
  const firstReserved = stepWorld(secondPickedUp, {
    kind: "reserve_delivery",
    objectId: firstId,
    actorId: "P1",
    generation: secondPickedUp.actors.P1.generation,
    team: "player",
    turretId: turret.id,
    stagingSlot: 0,
    reservationId: "delivery:r3-common-delivery-slot:P1:first",
    matchId: world.matchId,
  });
  const duplicate = stepWorld(firstReserved, {
    kind: "reserve_delivery",
    objectId: secondId,
    actorId: "P2",
    generation: firstReserved.actors.P2.generation,
    team: "player",
    turretId: turret.id,
    stagingSlot: 0,
    reservationId: "delivery:r3-common-delivery-slot:P2:second",
    matchId: world.matchId,
  });

  assert.equal(firstReserved.lastStep.rejected.length, 0);
  assert.equal(duplicate.lastStep.rejected.length, 1);
  assert.equal(duplicate.lastStep.rejected[0]?.reason, "invalid_object_transition");
  assert.equal(duplicate.objects[secondId]?.location.kind, "carried");
  assert.equal(duplicate.reservations["delivery:r3-common-delivery-slot:P2:second"], undefined);
  assertObjectLocationsUnique(duplicate);
});
