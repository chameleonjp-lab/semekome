import assert from "node:assert/strict";
import test from "node:test";
import { assertObjectLocationsUnique, createFloorObject } from "../../src/domain/objects.ts";
import { cloneWorld, createWorld, stepWorld } from "../../src/simulation/world.ts";

test("death is reserved once, drops cargo once, and the player respawns after 300 battle ticks with a new generation", () => {
  let world = createWorld({ seed: 20, matchId: "respawn" });
  world = createFloorObject(world, {
    id: "case-1",
    sourceTeam: "player",
    weight: 1,
    roomId: "central_corridor",
    position: { ...world.actors.P1.position },
  });
  world = stepWorld(world, { kind: "pickup_object", matchId: "respawn", objectId: "case-1", actorId: "P1", generation: 0 });
  assert.deepEqual(world.actors.P1.cargoIds, ["case-1"]);
  world = stepWorld(world, { kind: "damage_actor", matchId: "respawn", actorId: "P1", generation: 0, amount: 99 });
  assert.equal(world.actors.P1.alive, false);
  assert.equal(world.actors.P1.respawnAtTick, 301);
  assert.equal(world.objects["case-1"].location.kind, "floor");
  assert.equal(world.actors.P1.cargoIds.length, 0);
  world = stepWorld(world, { kind: "damage_actor", matchId: "respawn", actorId: "P1", generation: 0, amount: 99 });
  assert.equal(world.lastStep.rejected[0]?.reason, "dead_actor");
  for (let index = 0; index < 300; index += 1) world = stepWorld(world);
  assert.equal(world.actors.P1.alive, true);
  assert.equal(world.actors.P1.generation, 1);
  assert.equal(world.actors.P1.currentRoomId, "respawn");
  assert.deepEqual(world.actors.P1.cargoIds, []);
  assert.equal(world.actors.P1.protectedUntilTick, 361);
  const stale = stepWorld(world, { kind: "move_actor", matchId: "respawn", actorId: "P1", generation: 0, toRoomId: "central_corridor" });
  assert.equal(stale.lastStep.rejected[0]?.reason, "stale_generation");
});

test("enemy respawn deadline is 1200 ticks and preserves role/home while generation increments", () => {
  let world = createWorld({ seed: 21, matchId: "enemy-respawn" });
  world = stepWorld(world, { kind: "damage_actor", matchId: "enemy-respawn", actorId: "E01", generation: 0, amount: 99 });
  assert.equal(world.actors.E01.respawnAtTick, 1200);
  for (let index = 0; index < 1199; index += 1) world = stepWorld(world);
  assert.equal(world.actors.E01.alive, false);
  world = stepWorld(world);
  assert.equal(world.actors.E01.alive, true);
  assert.equal(world.actors.E01.generation, 1);
  assert.equal(world.actors.E01.currentRoomId, world.actors.E01.homeRoomId);
  assert.equal(world.actors.E01.role, "shooter");
});

test("match end cancels pending respawn and does not mutate later", () => {
  let world = createWorld({ seed: 22, matchId: "end", rules: { matchLimitTicks: 2 } });
  world = stepWorld(world, { kind: "damage_actor", matchId: "end", actorId: "E01", generation: 0, amount: 99 });
  assert.equal(world.actors.E01.alive, false);
  world = stepWorld(world);
  assert.equal(world.outcome, "draw");
  assert.equal(world.actors.E01.respawnAtTick, null);
  const frozen = stepWorld(world);
  assert.deepEqual(frozen, world);
});

test("explicit pause and visibility pause stop the world without wall-clock catch-up", () => {
  let world = createWorld({ seed: 23, matchId: "pause" });
  world = stepWorld(world, { kind: "pause", matchId: "pause" });
  assert.equal(world.phase, "paused");
  assert.equal(world.tick, 0);
  world = stepWorld(world, { kind: "damage_part", matchId: "pause", team: "enemy", partId: "P1", amount: 50, source: "projectile" });
  assert.equal(world.tick, 0);
  assert.equal(world.castles.enemy.exterior.P1.health, 50);
  world = stepWorld(world, { kind: "resume", matchId: "pause" });
  assert.equal(world.phase, "running");
  assert.equal(world.tick, 1);
  world = stepWorld(world, { kind: "visibility", matchId: "pause", visible: false });
  assert.equal(world.phase, "paused");
  assert.equal(world.tick, 1);
  world = stepWorld(world, { kind: "visibility", matchId: "pause", visible: true });
  assert.equal(world.phase, "running");
  assert.equal(world.tick, 2);
});

test("wrong match id cannot pause or mutate the world", () => {
  const world = createWorld({ seed: 24, matchId: "new-match" });
  const next = stepWorld(world, [
    { kind: "pause", matchId: "old-match" },
    { kind: "damage_part", matchId: "old-match", team: "enemy", partId: "P1", amount: 50, source: "projectile" },
  ]);
  assert.equal(next.phase, "running");
  assert.equal(next.tick, 1);
  assert.equal(next.castles.enemy.exterior.P1.health, 50);
  assert.deepEqual(next.lastStep.rejected.map((entry) => entry.reason), ["wrong_match", "wrong_match"]);
});

test("object location transitions preserve a single ownership location", () => {
  let world = createWorld({ seed: 25 });
  world = createFloorObject(world, {
    id: "case-unique",
    sourceTeam: "player",
    weight: 1,
    roomId: "central_corridor",
    position: { x: 70, y: 35 },
  });
  world = stepWorld(world, { kind: "pickup_object", matchId: world.matchId, objectId: "case-unique", actorId: "P1", generation: 0 });
  assertObjectLocationsUnique(world);
  world = stepWorld(world, { kind: "reserve_object", matchId: world.matchId, objectId: "case-unique", actorId: "P1", generation: 0, reservationId: "r1" });
  assert.equal(world.objects["case-unique"].location.kind, "reserved-carried");
  assertObjectLocationsUnique(world);
  const old = cloneWorld(world);
  const stale = stepWorld(world, { kind: "drop_object", matchId: world.matchId, objectId: "case-unique", actorId: "P1", generation: 1 });
  assert.equal(stale.lastStep.rejected[0]?.reason, "stale_generation");
  assert.deepEqual(stale.objects["case-unique"], old.objects["case-unique"]);
});

test("mutation inputs require match identity and actor generation, and unknown damage sources are rejected", () => {
  const world = createWorld({ seed: 26, matchId: "boundary" });
  const noMatch = stepWorld(world, { kind: "damage_actor", actorId: "P1", generation: 0, amount: 99 });
  assert.equal(noMatch.actors.P1.alive, true);
  assert.equal(noMatch.lastStep.rejected[0]?.reason, "missing_match");

  const noGeneration = stepWorld(world, { kind: "damage_actor", matchId: "boundary", actorId: "P1", amount: 99 });
  assert.equal(noGeneration.actors.P1.alive, true);
  assert.equal(noGeneration.lastStep.rejected[0]?.reason, "missing_generation");

  const noSource = stepWorld(world, {
    kind: "damage_part",
    matchId: "boundary",
    team: "enemy",
    partId: "P1",
    amount: 50,
    source: "actor",
  } as unknown as { kind: "damage_part"; matchId: string; team: "enemy"; partId: "P1"; amount: number; source: string });
  assert.equal(noSource.castles.enemy.exterior.P1.health, world.castles.enemy.exterior.P1.health);
  assert.equal(noSource.lastStep.rejected[0]?.reason, "invalid_transition");
});

test("queued objects are team-scoped and flying projectiles remain after shooter death", () => {
  let world = createWorld({ seed: 27, matchId: "projectile" });
  const add = (id: string, sourceTeam: "player" | "enemy", roomId: string): void => {
    world = createFloorObject(world, {
      id,
      sourceTeam,
      weight: 1,
      roomId,
      position: { x: 70, y: 35 },
    });
  };
  add("player-shot", "player", "central_corridor");
  world = stepWorld(world, { kind: "pickup_object", matchId: "projectile", objectId: "player-shot", actorId: "P1", generation: 0 });
  world = stepWorld(world, { kind: "enqueue_object", matchId: "projectile", objectId: "player-shot", actorId: "P1", generation: 0, team: "player", turretId: "T1" });
  world = stepWorld(world, { kind: "fly_object", matchId: "projectile", objectId: "player-shot", actorId: "P1", generation: 0, team: "player", targetTeam: "enemy", projectileId: "shot-1" });
  assert.deepEqual(world.objects["player-shot"].location, { kind: "flying", projectileId: "shot-1" });
  assert.deepEqual(world.projectiles["shot-1"], {
    id: "shot-1",
    objectId: "player-shot",
    team: "player",
    sourceActorId: "P1",
    sourceGeneration: 0,
    targetTeam: "enemy",
    targetPartId: undefined,
  });
  world = stepWorld(world, { kind: "damage_actor", matchId: "projectile", actorId: "P1", generation: 0, amount: 99 });
  assert.equal(world.actors.P1.alive, false);
  assert.equal(world.projectiles["shot-1"].sourceGeneration, 0);
  assertObjectLocationsUnique(world);
  world = stepWorld(world, { kind: "consume_object", matchId: "projectile", objectId: "player-shot", reason: "impact" });
  assert.equal(world.projectiles["shot-1"], undefined);
  assert.equal(world.objects["player-shot"].location.kind, "consumed");
  assertObjectLocationsUnique(world);
});

test("invalid actorless object transitions reject without corrupting cargo or reservations", () => {
  let world = createWorld({ seed: 28, matchId: "object-boundary" });
  world = createFloorObject(world, {
    id: "reserved-case",
    sourceTeam: "player",
    weight: 1,
    roomId: "central_corridor",
    position: { x: 70, y: 35 },
  });
  world = stepWorld(world, { kind: "pickup_object", matchId: "object-boundary", objectId: "reserved-case", actorId: "P1", generation: 0 });
  const actorlessQueue = stepWorld(world, { kind: "enqueue_object", matchId: "object-boundary", objectId: "reserved-case", turretId: "T1", team: "player" });
  assert.equal(actorlessQueue.lastStep.rejected[0]?.reason, "invalid_object_transition");
  assert.equal(actorlessQueue.objects["reserved-case"].location.kind, "carried");
  assert.deepEqual(actorlessQueue.actors.P1.cargoIds, ["reserved-case"]);
  world = stepWorld(actorlessQueue, { kind: "reserve_object", matchId: "object-boundary", objectId: "reserved-case", actorId: "P1", generation: 0, reservationId: "reservation-1" });
  const actorlessConsume = stepWorld(world, { kind: "consume_object", matchId: "object-boundary", objectId: "reserved-case" });
  assert.equal(actorlessConsume.lastStep.rejected[0]?.reason, "invalid_object_transition");
  assert.equal(actorlessConsume.objects["reserved-case"].location.kind, "reserved-carried");
  assert.deepEqual(actorlessConsume.actors.P1.reservationIds, ["reservation-1"]);
  world = stepWorld(actorlessConsume, { kind: "enqueue_object", matchId: "object-boundary", objectId: "reserved-case", actorId: "P1", generation: 0, turretId: "T1", team: "player" });
  assert.equal(world.objects["reserved-case"].location.kind, "queue");
  assert.deepEqual(world.actors.P1.reservationIds, []);
  assert.equal(world.reservations["reservation-1"], undefined);
  assertObjectLocationsUnique(world);
});

test("turret queue capacity is independent for the two castle teams", () => {
  let world = createWorld({ seed: 29, matchId: "queue-teams" });
  for (const id of ["p-queue-1", "p-queue-2"]) {
    world = createFloorObject(world, {
      id,
      sourceTeam: "player",
      weight: 1,
      roomId: "central_corridor",
      position: { x: 70, y: 35 },
    });
    world = stepWorld(world, { kind: "pickup_object", matchId: "queue-teams", objectId: id, actorId: "P1", generation: 0 });
    world = stepWorld(world, { kind: "enqueue_object", matchId: "queue-teams", objectId: id, actorId: "P1", generation: 0, team: "player", turretId: "T1" });
  }
  assert.deepEqual(Object.values(world.objects).filter((object) => object.location.kind === "queue" && object.location.team === "player").map((object) => object.id), ["p-queue-1", "p-queue-2"]);
  world = createFloorObject(world, {
    id: "e-queue-1",
    sourceTeam: "enemy",
    weight: 1,
    roomId: "battery_a",
    position: { x: 106, y: 13 },
  });
  world = stepWorld(world, { kind: "pickup_object", matchId: "queue-teams", objectId: "e-queue-1", actorId: "E01", generation: 0 });
  world = stepWorld(world, { kind: "enqueue_object", matchId: "queue-teams", objectId: "e-queue-1", actorId: "E01", generation: 0, team: "enemy", turretId: "T1" });
  assert.equal(world.objects["e-queue-1"].location.kind, "queue");
  assert.equal(world.objects["e-queue-1"].location.kind === "queue" && world.objects["e-queue-1"].location.team, "enemy");
  assertObjectLocationsUnique(world);
});

test("removing a queued object compacts its team turret indexes before the next enqueue", () => {
  let world = createWorld({ seed: 30, matchId: "queue-hole" });
  for (const id of ["queue-a", "queue-b"]) {
    world = createFloorObject(world, {
      id,
      sourceTeam: "player",
      weight: 1,
      roomId: "central_corridor",
      position: { x: 70, y: 35 },
    });
    world = stepWorld(world, { kind: "pickup_object", matchId: "queue-hole", objectId: id, actorId: "P1", generation: 0 });
    world = stepWorld(world, { kind: "enqueue_object", matchId: "queue-hole", objectId: id, actorId: "P1", generation: 0, team: "player", turretId: "T1" });
  }
  world = stepWorld(world, { kind: "fly_object", matchId: "queue-hole", objectId: "queue-a", actorId: "P1", generation: 0, team: "player", targetTeam: "enemy", projectileId: "queue-shot" });
  world = createFloorObject(world, {
    id: "queue-c",
    sourceTeam: "player",
    weight: 1,
    roomId: "central_corridor",
    position: { x: 70, y: 35 },
  });
  world = stepWorld(world, { kind: "pickup_object", matchId: "queue-hole", objectId: "queue-c", actorId: "P1", generation: 0 });
  world = stepWorld(world, { kind: "enqueue_object", matchId: "queue-hole", objectId: "queue-c", actorId: "P1", generation: 0, team: "player", turretId: "T1" });
  assert.equal(world.objects["queue-b"].location.kind, "queue");
  assert.equal(world.objects["queue-c"].location.kind, "queue");
  if (world.objects["queue-b"].location.kind === "queue" && world.objects["queue-c"].location.kind === "queue") {
    assert.equal(world.objects["queue-b"].location.index, 0);
    assert.equal(world.objects["queue-c"].location.index, 1);
  }
  assertObjectLocationsUnique(world);
});
