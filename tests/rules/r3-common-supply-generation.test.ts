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
    reservationId,
    matchId: world.matchId,
  });

  assert.equal(reserved.lastStep.rejected.length, 0);
  assert.equal(reserved.objects[objectId]?.location.kind, "reserved-carried");
  assert.equal(reserved.objects[objectId]?.location.kind === "reserved-carried" && reserved.objects[objectId].location.reservationId, reservationId);
  assert.equal(reserved.reservations[reservationId]?.kind, "delivery");
  assert.equal(reserved.reservations[reservationId]?.targetTurretId, turret.id);
  assert.equal(reserved.actors.P1.reservationIds.includes(reservationId), true);
  assertObjectLocationsUnique(reserved);
});
