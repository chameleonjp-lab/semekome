import assert from "node:assert/strict";
import test from "node:test";
import { canReachCore, canReachCoreOnFloor, canTraverse, padById } from "../../src/domain/layout.ts";
import { createWorld, cloneWorld, stepWorld } from "../../src/simulation/world.ts";
import { openAllGates, placeActorInCore } from "./helpers.ts";

test("each unique destroyed part opens exactly one prefix gate and castles remain independent", () => {
  let world = createWorld({ seed: 3, matchId: "parts" });
  world = stepWorld(world, { kind: "damage_part", matchId: "parts", team: "enemy", partId: "P4", amount: 50, source: "projectile" });
  assert.deepEqual(world.castles.enemy.openGateIds, ["G1"]);
  world = stepWorld(world, { kind: "damage_part", matchId: "parts", team: "enemy", partId: "P4", amount: 50, source: "projectile" });
  assert.deepEqual(world.castles.enemy.openGateIds, ["G1"]);
  world = stepWorld(world, { kind: "damage_part", matchId: "parts", team: "player", partId: "P1", amount: 50, source: "trusted_collision" });
  assert.deepEqual(world.castles.player.openGateIds, ["G1"]);
  assert.deepEqual(world.castles.enemy.openGateIds, ["G1"]);
  for (const partId of ["P1", "P2", "P3", "P5", "P6", "P7"] as const) {
    world = stepWorld(world, { kind: "damage_part", matchId: "parts", team: "enemy", partId, amount: 50, source: "projectile" });
  }
  assert.deepEqual(world.castles.enemy.openGateIds, ["G1", "G2", "G3", "G4", "G5", "G6", "G7"]);
  assert.equal(world.outcome, "ongoing");
});

test("every closed gate blocks its own edge at tick start", () => {
  const world = createWorld({ seed: 4 });
  for (const team of ["player", "enemy"] as const) {
    const layout = team === "player" ? world.layout.home : world.layout.enemy;
    const actors = Object.values(world.actors).filter((actor) => actor.team === team);
    const starts = new Set<string>();
    const respawnPadCells = new Set<string>();
    for (const actor of actors) {
      starts.add(actor.initialRoomId);
      const pad = padById(layout, actor.respawnPadId);
      assert.ok(pad, `${team} ${actor.id} respawn pad exists`);
      assert.equal(pad!.actorId, actor.id, `${team} ${actor.id} owns its respawn pad`);
      assert.equal(pad!.roomId, actor.respawnRoomId, `${team} ${actor.id} respawn room matches pad`);
      respawnPadCells.add(`${pad!.cell.x},${pad!.cell.y}`);
      starts.add(pad!.roomId);
    }
    assert.equal(respawnPadCells.size, actors.length, `${team} respawn pads are unique`);
    for (const start of starts) {
      assert.equal(canReachCoreOnFloor(layout, start, layout.coreRouteGates), true, `${team} ${start} all gates open`);
      for (let index = 0; index < layout.coreRouteGates.length; index += 1) {
        const gateId = layout.coreRouteGates[index];
        const from = layout.coreRouteRooms[index + 2];
        const to = layout.coreRouteRooms[index + 3];
        if (start === "central_corridor") {
          assert.equal(canTraverse(layout, from, to, []), false, `${team} ${gateId} graph edge`);
          assert.equal(canReachCore(layout, start, layout.coreRouteGates.filter((candidate) => candidate !== gateId)), false, `${team} ${start} ${gateId} graph`);
        }
        const openExceptThis = layout.coreRouteGates.filter((candidate) => candidate !== gateId);
        assert.equal(canReachCoreOnFloor(layout, start, openExceptThis), false, `${team} ${start} ${gateId} floor`);
      }
    }
  }
});

test("core contact validates hostility, room, complete route, and protection rather than hit boolean", () => {
  let world = createWorld({ seed: 5, matchId: "core" });
  world = openAllGates(world, "enemy");
  world = placeActorInCore(world, "P1", "enemy");
  const generation = world.actors.P1.generation;
  world = stepWorld(world, { kind: "core_attack", matchId: "core", actorId: "P1", targetTeam: "enemy", generation, attackType: "dash", collision: "core", hit: false });
  assert.equal(world.outcome, "player_win");

  let invalid = createWorld({ seed: 6 });
  invalid = openAllGates(invalid, "enemy");
  invalid = placeActorInCore(invalid, "P1", "enemy");
  invalid.actors.P1.protectedUntilTick = 10;
  invalid = stepWorld(invalid, { kind: "core_attack", matchId: invalid.matchId, actorId: "P1", targetTeam: "enemy", generation: 0, attackType: "dash", collision: "core", hit: true });
  assert.equal(invalid.outcome, "ongoing");
  assert.equal(invalid.lastStep.rejected[0]?.reason, "invalid_core_attack");

  let noEnvelope = createWorld({ seed: 61 });
  noEnvelope = openAllGates(noEnvelope, "enemy");
  noEnvelope = placeActorInCore(noEnvelope, "P1", "enemy");
  noEnvelope = stepWorld(noEnvelope, { kind: "core_attack", matchId: noEnvelope.matchId, actorId: "P1", targetTeam: "enemy", generation: 0, attackType: "dash", hit: true });
  assert.equal(noEnvelope.outcome, "ongoing");
});

test("last gate opening does not authorize a same-tick core contact", () => {
  let world = createWorld({ seed: 7 });
  world = openAllGates(world, "enemy");
  world = cloneWorld(world);
  world.castles.enemy.exterior.P7.health = 1;
  world.castles.enemy.exterior.P7.destroyed = false;
  world.castles.enemy.destroyedPartIds = ["P1", "P2", "P3", "P4", "P5", "P6"];
  world.castles.enemy.openGateIds = ["G1", "G2", "G3", "G4", "G5", "G6"];
  world.castles.enemy.gates.G7.open = false;
  world = placeActorInCore(world, "P1", "enemy");
  world = stepWorld(world, [
    { kind: "damage_part", matchId: world.matchId, team: "enemy", partId: "P7", amount: 1, source: "projectile" },
    { kind: "core_attack", matchId: world.matchId, actorId: "P1", targetTeam: "enemy", generation: 0, attackType: "dash", collision: "core", hit: true },
  ]);
  assert.equal(world.castles.enemy.openGateIds.length, 7);
  assert.equal(world.outcome, "ongoing");
});

test("same-tick opposing core contacts draw, and attacker death cannot erase a valid contact", () => {
  let draw = createWorld({ seed: 8 });
  draw = openAllGates(openAllGates(draw, "enemy"), "player");
  draw = placeActorInCore(draw, "P1", "enemy");
  draw = placeActorInCore(draw, "E30", "player");
  draw = stepWorld(draw, [
    { kind: "core_attack", matchId: draw.matchId, actorId: "P1", targetTeam: "enemy", generation: 0, attackType: "dash", collision: "core" },
    { kind: "core_attack", matchId: draw.matchId, actorId: "E30", targetTeam: "player", generation: 0, attackType: "dash", collision: "core" },
  ]);
  assert.equal(draw.outcome, "draw");

  let win = createWorld({ seed: 9 });
  win = openAllGates(win, "enemy");
  win = placeActorInCore(win, "P1", "enemy");
  win = stepWorld(win, [
    { kind: "core_attack", matchId: win.matchId, actorId: "P1", targetTeam: "enemy", generation: 0, attackType: "dash", collision: "core" },
    { kind: "damage_actor", matchId: win.matchId, actorId: "P1", generation: 0, amount: 99 },
  ]);
  assert.equal(win.outcome, "player_win");
  assert.equal(win.actors.P1.alive, false);
});

test("core hit has priority over time limit", () => {
  let world = createWorld({ seed: 10, rules: { matchLimitTicks: 1 } });
  world = openAllGates(world, "enemy");
  world = placeActorInCore(world, "P1", "enemy");
  world = stepWorld(world, { kind: "core_attack", matchId: world.matchId, actorId: "P1", targetTeam: "enemy", generation: 0, attackType: "dash", collision: "core" });
  assert.equal(world.outcome, "player_win");

  let timeout = createWorld({ seed: 11, rules: { matchLimitTicks: 1 } });
  timeout = stepWorld(timeout);
  assert.equal(timeout.outcome, "draw");
});
