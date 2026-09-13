import assert from "node:assert/strict";
import test from "node:test";
import { ENEMY_ROSTER } from "../../src/content/roster.ts";
import { createFacingCastlesLayout } from "../../src/content/layouts.ts";
import { validateWorldLayout } from "../../src/domain/layout.ts";
import { createWorld, stepWorld } from "../../src/simulation/world.ts";

test("v5 roster is fixed at E01-E30 with the adopted role counts", () => {
  assert.equal(ENEMY_ROSTER.length, 30);
  assert.deepEqual(ENEMY_ROSTER.map((entry) => entry.id), Array.from({ length: 30 }, (_, index) => `E${String(index + 1).padStart(2, "0")}`));
  assert.equal(ENEMY_ROSTER.filter((entry) => entry.role === "shooter").length, 4);
  assert.equal(ENEMY_ROSTER.filter((entry) => entry.role === "shooter_guard").length, 4);
  assert.equal(ENEMY_ROSTER.filter((entry) => entry.role === "ammo_carrier").length, 8);
  assert.equal(ENEMY_ROSTER.filter((entry) => entry.role === "internal_soldier").length, 14);
});

test("floor geometry reaches all authored pads and mirrors without mirroring controls", () => {
  const layout = createFacingCastlesLayout();
  const validation = validateWorldLayout(layout);
  assert.equal(validation.valid, true, validation.errors.join("; "));
  assert.equal(layout.widthCells, 126);
  assert.equal(layout.heightCells, 70);
  assert.equal(layout.mirrorRule.textAndControlsMirrored, false);
  const homeCore = layout.home.rooms.find((room) => room.id === "core")!;
  const enemyCore = layout.enemy.rooms.find((room) => room.id === "core")!;
  assert.equal(enemyCore.rect.x0, 126 - homeCore.rect.x1);
  assert.equal(enemyCore.rect.x1, 126 - homeCore.rect.x0);
  for (const room of layout.enemy.rooms) {
    for (const pad of room.recoveryPads) assert.equal(pad.walkable, true);
  }
});

test("the three player actors occupy distinct floor cells and home turrets have no enemy operators", () => {
  const world = createWorld({ matchId: "layout-ownership" });
  const positions = [world.actors.P1, world.actors.P2, world.actors.P3].map((actor) => `${actor.position.x},${actor.position.y}`);
  assert.equal(new Set(positions).size, 3);
  for (const actor of [world.actors.P1, world.actors.P2, world.actors.P3]) {
    assert.equal(actor.currentRoomId, "central_corridor");
    assert.equal(actor.location.roomId, "central_corridor");
    const room = world.layout.home.rooms.find((candidate) => candidate.id === actor.currentRoomId)!;
    assert.equal(room.rect.x0 <= actor.position.x && actor.position.x < room.rect.x1, true);
    assert.equal(room.rect.y0 <= actor.position.y && actor.position.y < room.rect.y1, true);
    assert.equal(world.layout.home.floorCells.some((cell) => cell.x === actor.position.x && cell.y === actor.position.y), true);
  }
  assert.equal(world.layout.home.turrets.every((turret) => turret.operatorActorId === null), true);
  assert.deepEqual(world.layout.enemy.turrets.map((turret) => turret.operatorActorId), ["E01", "E02", "E03", "E04"]);
  const playerPads = world.layout.home.rooms.find((room) => room.id === "respawn")!.recoveryPads;
  assert.deepEqual(playerPads.map((pad) => [pad.id, pad.actorId, pad.cell.x, pad.cell.y]), [
    ["player_respawn_pad_P1", "P1", 58, 35],
    ["player_respawn_pad_P2", "P2", 60, 35],
    ["player_respawn_pad_P3", "P3", 62, 35],
  ]);
  assert.equal(playerPads.length, 3);
});

test("same seed and input stream produces the same pure state", () => {
  const inputs = [
    { kind: "damage_part", matchId: "same", team: "enemy" as const, partId: "P1" as const, amount: 10, source: "projectile" as const },
    { kind: "damage_part", matchId: "same", team: "player" as const, partId: "P2" as const, amount: 5, source: "trusted_collision" as const },
    { kind: "advance" },
  ];
  let left = createWorld({ seed: 901, matchId: "same" });
  let right = createWorld({ seed: 901, matchId: "same" });
  for (const input of inputs) {
    left = stepWorld(left, input);
    right = stepWorld(right, input);
  }
  assert.deepEqual(left, right);
});

test("world creation rejects a moved, missing, or misowned roster respawn pad", () => {
  const moved = structuredClone(createFacingCastlesLayout());
  const battery = moved.enemy.rooms.find((room) => room.id === "battery_a")!;
  const padIndex = battery.recoveryPads.findIndex((pad) => pad.id === "battery_a_pad_E01");
  const [e01Pad] = battery.recoveryPads.splice(padIndex, 1);
  const core = moved.enemy.rooms.find((room) => room.id === "core")!;
  moved.enemy.rooms.find((room) => room.id === "core")!.recoveryPads.push({
    ...e01Pad,
    roomId: "core",
    cell: { x: core.rect.x0 + 1, y: core.rect.y0 + 1 },
  });
  assert.equal(validateWorldLayout(moved).valid, false);
  assert.throws(() => createWorld({ layout: moved }), /actors:/);

  const missing = structuredClone(createFacingCastlesLayout());
  const missingRoom = missing.enemy.rooms.find((room) => room.id === "battery_a")!;
  missingRoom.recoveryPads = missingRoom.recoveryPads.filter((pad) => pad.id !== "battery_a_pad_E01");
  assert.equal(validateWorldLayout(missing).valid, false);
  assert.throws(() => createWorld({ layout: missing }), /respawn pad/);

  const misowned = structuredClone(createFacingCastlesLayout());
  const misownedPad = misowned.enemy.rooms.find((room) => room.id === "battery_a")!.recoveryPads.find((pad) => pad.id === "battery_a_pad_E01")!;
  misownedPad.actorId = "E02";
  assert.equal(validateWorldLayout(misowned).valid, false);
  assert.throws(() => createWorld({ layout: misowned }), /does not own respawn pad/);
});
