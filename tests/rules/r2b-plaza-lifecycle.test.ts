import assert from "node:assert/strict";
import test from "node:test";
import type { WorldState } from "../../src/domain/types.ts";
import { createWorld, stepWorld } from "../../src/simulation/world.ts";
import {
  plazaGuardGenerations,
  preparePlazaEntry,
} from "../../src/simulation/r2b-bridge.ts";
import { registerPlazaGuardDispatch } from "../../src/simulation/plaza-guards.ts";
import { createBattle, stepBattle } from "../../src/simulation/physical-battle.ts";

function placeInPlaza(world: WorldState, actorId: string): void {
  world.actors[actorId].location = { area: "plaza", pathRooms: [], pathGates: [] };
  world.actors[actorId].currentRoomId = "plaza";
}

function enemyEntryEvidence(world: WorldState, actorId = "P1") {
  return {
    matchId: world.matchId,
    tick: world.tick,
    actorId,
    generation: world.actors[actorId].generation,
    targetTeam: "enemy" as const,
    guardGenerations: plazaGuardGenerations(world, "enemy", actorId),
  };
}

function defeatEnemyPlazaGuards(world: WorldState): void {
  for (const guardId of ["E25", "E26", "E27"] as const) {
    world.actors[guardId].alive = false;
    world.actors[guardId].health = 0;
    world.actors[guardId].respawnAtTick = 9_999;
  }
}

test("a plaza deployment captures all live guard generations before they arrive", () => {
  const world = createWorld({ matchId: "plaza-dispatch-snapshot", seed: 1101 });
  placeInPlaza(world, "P1");

  registerPlazaGuardDispatch(world, "enemy", "E25");

  assert.deepEqual(world.plaza.guardDeployments.enemy, {
    dispatchedAtTick: 0,
    guardGenerations: { E25: 0, E26: 0, E27: 0 },
  });
  assert.deepEqual(plazaGuardGenerations(world, "enemy", "P1"), {
    E25: 0,
    E26: 0,
    E27: 0,
  });

  const prepared = preparePlazaEntry(world, enemyEntryEvidence(world));
  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.reason, "guards_remaining");
});

test("the physical crossing cannot win a same-tick race before guard dispatch is recorded", () => {
  let state = createBattle({ matchId: "physical-plaza-dispatch-race", seed: 1103 });
  const actor = state.actors.P1;
  actor.location = { area: "plaza", pathRooms: [], pathGates: [] };
  actor.currentRoomId = "plaza";
  state.fixedActors.P1 = { position: { x: 125_500, y: 35_500 }, remainder: { x: 0, y: 0 } };
  actor.position = { x: 125, y: 35 };

  state = stepBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    direction: { x: 1, y: 0 },
  });

  assert.equal(state.actors.P1.location.area, "plaza");
  assert.deepEqual(state.plaza.guardDeployments.enemy?.guardGenerations, {
    E25: 0,
    E26: 0,
    E27: 0,
  });
});

test("a defeated same-generation crossing right survives leaving and re-entering the plaza", () => {
  let world = createWorld({ matchId: "plaza-reentry-right", seed: 1105 });
  placeInPlaza(world, "P1");
  registerPlazaGuardDispatch(world, "enemy", "E25");
  defeatEnemyPlazaGuards(world);

  const first = preparePlazaEntry(world, enemyEntryEvidence(world));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  let entered = stepWorld(first.value.state, first.value.input);
  assert.equal(entered.actors.P1.location.castleTeam, "enemy");

  entered = stepWorld(entered, {
    kind: "move_actor",
    matchId: entered.matchId,
    actorId: "P1",
    generation: entered.actors.P1.generation,
    toRoomId: "plaza",
  });
  assert.equal(entered.actors.P1.location.area, "plaza");

  const second = preparePlazaEntry(entered, enemyEntryEvidence(entered));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const reentered = stepWorld(second.value.state, second.value.input);
  assert.equal(reentered.actors.P1.location.castleTeam, "enemy");
  assert.equal(reentered.plaza.enemyCrossings["P1:0"]?.allowed, true);
});

test("a respawned guard generation invalidates the older crossing right", () => {
  let world = createWorld({ matchId: "plaza-respawn-invalidates", seed: 1107 });
  placeInPlaza(world, "P1");
  registerPlazaGuardDispatch(world, "enemy", "E25");
  defeatEnemyPlazaGuards(world);

  const first = preparePlazaEntry(world, enemyEntryEvidence(world));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  let entered = stepWorld(first.value.state, first.value.input);
  entered = stepWorld(entered, {
    kind: "move_actor",
    matchId: entered.matchId,
    actorId: "P1",
    generation: entered.actors.P1.generation,
    toRoomId: "plaza",
  });

  const guard = entered.actors.E25;
  guard.alive = true;
  guard.health = guard.maxHealth;
  guard.generation = 1;
  guard.respawnAtTick = null;
  registerPlazaGuardDispatch(entered, "enemy", "E25");

  const stale = stepWorld(entered, first.value.input);
  assert.equal(stale.actors.P1.location.area, "plaza");
  assert.equal(stale.lastStep.rejected[0]?.reason, "invalid_transition");

  const current = preparePlazaEntry(entered, enemyEntryEvidence(entered));
  assert.equal(current.ok, false);
  if (!current.ok) assert.equal(current.reason, "guards_remaining");
});

test("a common-world guard respawn registers only its new generation", () => {
  let world = createWorld({ matchId: "plaza-respawn-registration", seed: 1108 });
  placeInPlaza(world, "P1");
  registerPlazaGuardDispatch(world, "enemy", "E25");

  const guard = world.actors.E25;
  guard.alive = false;
  guard.health = 0;
  guard.respawnAtTick = world.tick;

  world = stepWorld(world);

  assert.equal(world.actors.E25.alive, true);
  assert.equal(world.actors.E25.generation, 1);
  assert.equal(world.plaza.guardDeployments.enemy?.guardGenerations.E25, 1);
  assert.deepEqual(plazaGuardGenerations(world, "enemy", "P1"), {
    E25: 1,
    E26: 0,
    E27: 0,
  });
  const current = preparePlazaEntry(world, enemyEntryEvidence(world));
  assert.equal(current.ok, false);
  if (!current.ok) assert.equal(current.reason, "guards_remaining");
});

test("a new plaza defender invalidates a prepared entry in the same update boundary", () => {
  let world = createWorld({ matchId: "plaza-entry-competition", seed: 1109 });
  placeInPlaza(world, "P1");
  registerPlazaGuardDispatch(world, "enemy", "E25");
  defeatEnemyPlazaGuards(world);

  const prepared = preparePlazaEntry(world, enemyEntryEvidence(world));
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  placeInPlaza(prepared.value.state, "E29");
  const next = stepWorld(prepared.value.state, prepared.value.input);

  assert.equal(next.actors.P1.location.area, "plaza");
  assert.equal(next.lastStep.rejected[0]?.reason, "invalid_transition");
});
