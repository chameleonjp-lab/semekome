import assert from "node:assert/strict";
import test from "node:test";
import { floorCell } from "../../src/actors/movement.ts";
import type { WorldState } from "../../src/domain/types.ts";
import { createWorld, stepWorld } from "../../src/simulation/world.ts";
import { createBattle, stepBattle, type BattleState } from "../../src/simulation/physical-battle.ts";
import { plazaGuardGenerations, preparePlazaEntry } from "../../src/simulation/r2b-bridge.ts";

function place(world: WorldState, id: string) {
  world.actors[id].location = { area: "plaza", pathRooms: [], pathGates: [] };
  world.actors[id].currentRoomId = "plaza";
}

function physicalPlace(state: BattleState, id: string, x: number) {
  place(state, id);
  state.fixedActors[id] = { position: { x, y: 35_500 }, remainder: { x: 0, y: 0 } };
  state.actors[id].position = { x: floorCell(x), y: 35 };
}

function evidence(world: WorldState, actorId: string, targetTeam: "player" | "enemy") {
  return { matchId: world.matchId, tick: world.tick, actorId, generation: world.actors[actorId].generation,
    targetTeam, guardGenerations: plazaGuardGenerations(world, targetTeam, actorId) };
}

function rejection(result: ReturnType<typeof preparePlazaEntry>): string {
  assert.equal(result.ok, false);
  return result.ok ? "unexpected_success" : result.reason;
}

test("every player-side plaza occupant blocks enemy entry without a guard role flag", () => {
  for (const defenderId of ["P1", "P2", "P3"]) {
    const world = createWorld({ matchId: `plaza-${defenderId}`, seed: 977 });
    place(world, "E29"); place(world, defenderId);
    assert.notEqual(world.actors[defenderId].canGuardPlaza, true);
    const snapshot = evidence(world, "E29", "player");
    assert.deepEqual(snapshot.guardGenerations, { [defenderId]: 0 });
    assert.equal(rejection(preparePlazaEntry(world, snapshot)), "guards_remaining");
    const omitted = preparePlazaEntry(world, { ...snapshot, guardGenerations: {} });
    assert.equal(rejection(omitted), "stale_generation");
    // Trusted death fixture isolates permission validation, not a combat win.
    world.actors[defenderId].alive = false;
    world.actors[defenderId].health = 0;
    const cleared = preparePlazaEntry(world, snapshot);
    assert.equal(cleared.ok, true);
    world.actors[defenderId].generation++;
    assert.equal(rejection(preparePlazaEntry(world, snapshot)), "stale_generation");
  }
});

test("ordinary invading enemies in the plaza also block the player's opposite crossing", () => {
  const world = createWorld({ matchId: "plaza-enemy-invader", seed: 979 });
  place(world, "P1"); place(world, "E29");
  assert.notEqual(world.actors.E29.canGuardPlaza, true);
  assert.equal(rejection(preparePlazaEntry(world, evidence(world, "P1", "enemy"))), "guards_remaining");
});

test("returning to either home castle is allowed even with living allies in the plaza", () => {
  for (const [id, ally, team] of [["P1", "P2", "player"], ["E29", "E25", "enemy"]] as const) {
    const world = createWorld({ matchId: `plaza-retreat-${team}`, seed: 983 });
    place(world, id); place(world, ally);
    const snapshot = evidence(world, id, team);
    assert.deepEqual(snapshot.guardGenerations, {});
    const prepared = preparePlazaEntry(world, snapshot);
    assert.equal(prepared.ok, true);
    if (!prepared.ok) continue;
    const next = stepWorld(prepared.value.state, prepared.value.input);
    assert.equal(next.actors[id].location.castleTeam, team);
    assert.equal(next.actors[id].location.area, "castle");
  }
});

test("a newly arrived player defender invalidates a stale common-world entry envelope", () => {
  const world = createWorld({ matchId: "plaza-new-defender", seed: 991 });
  place(world, "E29");
  const prepared = preparePlazaEntry(world, evidence(world, "E29", "player"));
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  place(prepared.value.state, "P2");
  const next = stepWorld(prepared.value.state, prepared.value.input);
  assert.equal(next.actors.E29.location.area, "plaza");
  assert.equal(next.lastStep.rejected.some(item => item.reason === "invalid_transition"), true);
});

test("the physical assault path waits for a player defender and resumes after the defender dies", () => {
  let state = createBattle({ matchId: "physical-plaza-defender", seed: 997 });
  physicalPlace(state, "E29", 750);
  physicalPlace(state, "P1", 40_000);
  state = stepBattle(state);
  assert.equal(state.actors.E29.location.area, "plaza");
  state.actors.P1.alive = false; state.actors.P1.health = 0; state.actors.P1.respawnAtTick = 9999;
  // A cached local-defense intention is re-evaluated on the existing AI
  // decision cadence. Do not force a fresh intention or a same-tick crossing.
  for (let tick = 0; tick < 60 && state.actors.E29.location.area === "plaza"; tick++) state = stepBattle(state);
  assert.equal(state.actors.E29.location.area, "castle");
  assert.equal(state.actors.E29.location.castleTeam, "player");
  assert.deepEqual(state.plaza.playerCrossings["E29:0"].guardGenerations, { P1: 0 });
});

test("a player defender staying inside a castle does not block an enemy plaza crossing", () => {
  let state = createBattle({ matchId: "physical-plaza-no-defender", seed: 1009 });
  physicalPlace(state, "E29", 750);
  state = stepBattle(state);
  assert.equal(state.actors.E29.location.castleTeam, "player");
  assert.equal(state.actors.E29.currentRoomId, "central_corridor");
});

test("physical P1 movement can return home while a living ally remains in the plaza", () => {
  let state = createBattle({ matchId: "physical-plaza-retreat", seed: 1013 });
  physicalPlace(state, "P1", 750);
  physicalPlace(state, "P2", 40_000);
  state = stepBattle(state, { matchId: state.matchId, actorId: "P1", generation: 0, direction: { x: -1, y: 0 } });
  assert.equal(state.actors.P1.location.area, "castle");
  assert.equal(state.actors.P1.location.castleTeam, "player");
  assert.deepEqual(state.plaza.playerCrossings["P1:0"].guardGenerations, {});
  assert.equal(state.actors.P2.alive, true);
});
