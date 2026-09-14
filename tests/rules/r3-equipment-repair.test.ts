import assert from "node:assert/strict";
import test from "node:test";
import { cellCenter, floorCell } from "../../src/actors/movement.ts";
import { assertObjectLocationsUnique } from "../../src/domain/objects.ts";
import {
  createBattle,
  getInteraction,
  stepBattle,
  type BattleCaseState,
  type BattleEquipmentKind,
  type BattleState,
} from "../../src/simulation/physical-battle.ts";

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

function givePlayerCase(state: BattleState, id: string): void {
  const actor = state.actors.P1;
  const port = state.logistics.ports["player:supply_1"];
  const caseState: BattleCaseState = {
    id,
    type: "standard_slug",
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
}

function equipmentRepairIntent(state: BattleState, kind: BattleEquipmentKind, id: string) {
  const interaction = getInteraction(state, "P1", 0);
  return {
    matchId: state.matchId,
    actorId: "P1" as const,
    generation: state.actors.P1.generation,
    handle: "repair" as const,
    equipmentKind: kind,
    equipmentId: id,
    slot: 0,
    contextToken: interaction.contextToken,
  };
}

test("R3 equipment repair restores a turret after 120 ticks without exterior budget", () => {
  let state = createBattle({ matchId: "r3-equipment-repair", seed: 631 });
  placePlayerInRepairRoom(state);
  givePlayerCase(state, "equipment-repair-case");
  const turret = state.artillery.turrets["player:T1"];
  turret.health = 0;
  turret.disabledUntilTick = 480;

  const interaction = getInteraction(state, "P1", 0);
  assert.deepEqual(interaction.equipmentRepairTargets.map((target) => `${target.kind}:${target.id}`), ["turret:T1"]);
  state = stepBattle(state, equipmentRepairIntent(state, "turret", "T1"));
  const task = state.repairs.equipmentTasks.P1;
  assert.ok(task);
  assert.equal(task.completesAtTick, state.rules.equipmentRepairWorkTicks);
  assert.equal(state.repairs.budgetUsed.player, 0);
  assert.equal(state.objects["equipment-repair-case"].location.kind, "reserved-carried");

  while (state.tick <= task.completesAtTick) state = stepBattle(state);

  assert.equal(state.artillery.turrets["player:T1"].health, state.rules.equipmentRepairHealth);
  assert.equal(state.artillery.turrets["player:T1"].disabledUntilTick, null);
  assert.equal(state.repairs.equipmentTasks.P1, undefined);
  assert.deepEqual(state.actors.P1.cargoIds, []);
  assert.equal(state.objects["equipment-repair-case"], undefined, "the consumed group is pruned");
  assert.equal(state.lastStep.events.some((event) => event.type === "equipment_repair_completed"), true);
  assertObjectLocationsUnique(state);
});

test("R3 equipment repair cancels on movement and returns the case", () => {
  let state = createBattle({ matchId: "r3-equipment-repair-cancel", seed: 641 });
  placePlayerInRepairRoom(state);
  givePlayerCase(state, "equipment-repair-cancel-case");
  const port = state.logistics.ports["player:supply_1"];
  port.health = 0;
  port.disabledUntilTick = 480;

  state = stepBattle(state, equipmentRepairIntent(state, "supply_port", "supply_1"));
  assert.ok(state.repairs.equipmentTasks.P1);
  state = stepBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    direction: { x: 1, y: 0 },
  });

  assert.equal(state.repairs.equipmentTasks.P1, undefined);
  assert.deepEqual(state.actors.P1.cargoIds, ["equipment-repair-cancel-case"]);
  assert.equal(state.objects["equipment-repair-cancel-case"].location.kind, "carried");
  assert.equal(state.logistics.ports["player:supply_1"].health, 0);
  assert.equal(state.lastStep.events.some((event) => event.type === "equipment_repair_cancelled" && event.reason === "interrupted"), true);
  assertObjectLocationsUnique(state);
});

test("R3 manual repair wins at an automatic restore deadline without double recovery", () => {
  let state = createBattle({ matchId: "r3-equipment-repair-race", seed: 647 });
  placePlayerInRepairRoom(state);
  givePlayerCase(state, "equipment-repair-race-case");
  const turret = state.artillery.turrets["player:T1"];
  turret.health = 0;
  // Automatic restore is eligible when tick > disabledUntilTick. The manual
  // task completes at tick 120, so 119 makes both boundaries coincide.
  turret.disabledUntilTick = state.rules.equipmentRepairWorkTicks - 1;
  state = stepBattle(state, equipmentRepairIntent(state, "turret", "T1"));
  const task = state.repairs.equipmentTasks.P1;
  assert.ok(task);
  while (state.tick <= task.completesAtTick) state = stepBattle(state);

  const events = state.lastStep.events;
  assert.equal(events.filter((event) => event.type === "equipment_repair_completed").length, 1);
  assert.equal(events.filter((event) => event.type === "equipment_restored").length, 0);
  assert.equal(state.artillery.turrets["player:T1"].health, state.rules.equipmentRepairHealth);
  assert.equal(state.artillery.turrets["player:T1"].disabledUntilTick, null);
  assert.deepEqual(state.reservations, {});
  assertObjectLocationsUnique(state);
});
