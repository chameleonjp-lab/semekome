import assert from "node:assert/strict";
import test from "node:test";
import { cellCenter, floorCell } from "../../src/actors/movement.ts";
import { assertObjectLocationsUnique } from "../../src/domain/objects.ts";
import { createBattle, getInteraction, stepBattle, type BattleCaseState, type BattleState } from "../../src/simulation/physical-battle.ts";

function placePlayerInRepairRoom(state: BattleState): void {
  const room = state.layout.home.rooms.find((candidate) => candidate.id === "repair");
  assert.ok(room, "the adopted layout has a repair room");
  const point = {
    x: cellCenter(Math.floor((room.rect.x0 + room.rect.x1 - 1) / 2)),
    y: cellCenter(Math.floor((room.rect.y0 + room.rect.y1 - 1) / 2)),
  };
  const actor = state.actors.P1;
  actor.location = { area: "castle", castleTeam: "player", roomId: "repair", pathRooms: ["repair"], pathGates: [] };
  actor.currentRoomId = "repair";
  actor.position = { x: floorCell(point.x), y: floorCell(point.y) };
  state.fixedActors.P1 = { position: point, remainder: { x: 0, y: 0 } };
}

function givePlayerCase(state: BattleState, id = "repair-case"): string {
  const actor = state.actors.P1;
  const port = state.logistics.ports["player:supply_1"];
  const type = "standard_slug" as const;
  const caseState: BattleCaseState = {
    id,
    type,
    sourceTeam: "player",
    currentTeam: "player",
    weight: 1,
    location: "carried",
    currentPosition: { ...state.fixedActors.P1.position },
    ownerActorId: actor.id,
    ownerGeneration: actor.generation,
    originGroupId: id,
    sourcePortId: port.id,
    createdTick: state.tick,
    roomId: "repair",
  };
  state.battleCases[id] = caseState;
  state.logistics.groups[id] = { id, team: "player", portId: port.id, caseIds: [id], retired: false };
  actor.cargoIds = [id];
  state.cargoSlots.P1 = [id, null];
  state.objects[id] = {
    id,
    sourceTeam: "player",
    weight: 1,
    originGroupId: id,
    location: { kind: "carried", actorId: "P1", slot: 0 },
  };
  assertObjectLocationsUnique(state);
  return id;
}

function repairIntent(state: BattleState, part?: "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7") {
  const interaction = getInteraction(state, "P1", 0);
  return {
    matchId: state.matchId,
    actorId: "P1" as const,
    generation: state.actors.P1.generation,
    handle: "repair" as const,
    ...(part ? { part } : {}),
    slot: 0,
    contextToken: interaction.contextToken,
  };
}

test("R3 repair reserves one carried case, completes after 90 ticks, and consumes only the used budget", () => {
  let state = createBattle({ matchId: "r3-repair-complete", seed: 601 });
  placePlayerInRepairRoom(state);
  const caseId = givePlayerCase(state);
  state.castles.player.exterior.P1.health = 30;

  assert.equal(getInteraction(state, "P1", 0).handles.includes("repair"), true);
  state = stepBattle(state, repairIntent(state));
  const task = state.repairs.tasks.P1;
  assert.ok(task, "repair task is visible after the start tick");
  assert.equal(task.partId, "P1");
  assert.equal(task.completesAtTick, state.rules.repairWorkTicks);
  assert.equal(state.objects[caseId].location.kind, "reserved-carried");
  assert.equal(state.repairs.budgetUsed.player, 0);
  assert.equal(state.lastStep.events.some((event) => event.type === "repair_started"), true);

  while (state.tick <= task.completesAtTick) state = stepBattle(state);

  assert.equal(state.castles.player.exterior.P1.health, 42);
  assert.equal(state.repairs.budgetUsed.player, 12);
  assert.equal(state.repairs.tasks.P1, undefined);
  assert.deepEqual(state.actors.P1.cargoIds, []);
  assert.equal(state.objects[caseId], undefined, "retired consumed groups are pruned from the live snapshot");
  assert.equal(state.lastStep.events.some((event) => event.type === "repair_completed" && event.amount === 12), true);
  assertObjectLocationsUnique(state);
});

test("R3 moving during repair cancels without consuming the case or budget", () => {
  let state = createBattle({ matchId: "r3-repair-interrupt", seed: 607 });
  placePlayerInRepairRoom(state);
  const caseId = givePlayerCase(state);
  state.castles.player.exterior.P2.health = 20;

  state = stepBattle(state, repairIntent(state, "P2"));
  assert.equal(state.repairs.tasks.P1?.partId, "P2");
  state = stepBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    direction: { x: 1, y: 0 },
  });

  assert.equal(state.repairs.tasks.P1, undefined);
  assert.equal(state.repairs.budgetUsed.player, 0);
  assert.deepEqual(state.actors.P1.cargoIds, [caseId]);
  assert.equal(state.objects[caseId].location.kind, "carried");
  assert.equal(state.lastStep.events.some((event) => event.type === "repair_cancelled" && event.reason === "interrupted"), true);
  assertObjectLocationsUnique(state);
});

test("R3 repair target is captured at start and a second task cannot reserve the same damaged part", () => {
  let state = createBattle({ matchId: "r3-repair-target", seed: 613 });
  placePlayerInRepairRoom(state);
  givePlayerCase(state, "repair-case-a");
  state.castles.player.exterior.P3.health = 10;
  state.castles.player.exterior.P4.health = 20;
  state = stepBattle(state, repairIntent(state));

  assert.equal(state.repairs.tasks.P1?.partId, "P3");
  assert.equal(getInteraction(state, "P1", 0).handles.includes("repair"), false);

  // The public actor cannot submit a second repair while the first reservation
  // is active, and a destroyed explicit target is rejected without a mutation.
  state.castles.player.exterior.P4.destroyed = true;
  const rejected = stepBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    handle: "repair",
    part: "P4",
    slot: 0,
    contextToken: getInteraction(state, "P1", 0).contextToken,
  });
  assert.equal(rejected.lastStep.rejected[0]?.reason, "invalid_object_transition");
  assert.equal(rejected.repairs.tasks.P1?.partId, "P3");
  assert.equal(rejected.repairs.budgetUsed.player, 0);
  assertObjectLocationsUnique(rejected);
});

test("R3 death during repair releases the reservation and returns the case to the floor", () => {
  let state = createBattle({ matchId: "r3-repair-death", seed: 619 });
  placePlayerInRepairRoom(state);
  const caseId = givePlayerCase(state);
  state.castles.player.exterior.P1.health = 25;
  state = stepBattle(state, repairIntent(state, "P1"));

  state.actors.P1.health = 0;
  state = stepBattle(state);

  assert.equal(state.repairs.tasks.P1, undefined);
  assert.deepEqual(state.actors.P1.cargoIds, []);
  assert.deepEqual(state.reservations, {});
  assert.equal(state.battleCases[caseId].location, "floor");
  assert.equal(state.objects[caseId].location.kind, "floor");
  assert.equal(state.lastStep.events.some((event) => event.type === "repair_cancelled" && event.reason === "dead"), true);
  assertObjectLocationsUnique(state);
});
