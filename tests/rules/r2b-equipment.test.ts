import assert from "node:assert/strict";
import test from "node:test";
import { floorCell } from "../../src/actors/movement.ts";
import { createBattle, stepBattle, type BattleDirection, type BattleState } from "../../src/simulation/physical-battle.ts";

const NEUTRAL: BattleDirection = { x: 0, y: 0 };

function p1Intent(state: BattleState, extra: Record<string, unknown> = {}) {
  return {
    matchId: state.matchId,
    actorId: "P1" as const,
    generation: state.actors.P1.generation,
    direction: NEUTRAL,
    ...extra,
  };
}

function placeP1AtEnemyTurretApproach(state: BattleState): void {
  const point = { x: 18_850, y: 13_500 };
  const actor = state.actors.P1;
  actor.location = { area: "castle", castleTeam: "enemy", roomId: "battery_a", pathRooms: ["battery_a"], pathGates: [] };
  actor.currentRoomId = "battery_a";
  actor.position = { x: floorCell(point.x), y: floorCell(point.y) };
  state.fixedActors.P1.position = point;
  state.fixedActors.P1.remainder = { x: 0, y: 0 };
}

function placeP1AtEnemySupplyApproach(state: BattleState): void {
  const point = { x: 31_850, y: 13_500 };
  const actor = state.actors.P1;
  actor.location = { area: "castle", castleTeam: "enemy", roomId: "ammo_a", pathRooms: ["ammo_a"], pathGates: [] };
  actor.currentRoomId = "ammo_a";
  actor.position = { x: floorCell(point.x), y: floorCell(point.y) };
  state.fixedActors.P1.position = point;
  state.fixedActors.P1.remainder = { x: 0, y: 0 };
}

test("R2b dash damages the first enemy turret contact and stops before its body", () => {
  const state = createBattle({ matchId: "r2b-equipment-contact", seed: 211 });
  placeP1AtEnemyTurretApproach(state);

  const next = stepBattle(state, p1Intent(state, { dash: { x: 1, y: 0 } }));
  const turret = next.artillery.turrets["enemy:T1"];
  const damage = next.lastStep.events.find((event) => event.type === "equipment_damaged");

  assert.equal(turret.health, next.rules.equipmentHealth - next.rules.dashEquipmentDamage);
  assert.equal(turret.disabledUntilTick, null);
  assert.equal(next.lastStep.acceptedInputKinds.includes("equipment_contact"), true);
  assert.deepEqual(next.fixedActors.P1.position, { x: 18_919, y: 13_500 });
  assert.deepEqual(damage, {
    type: "equipment_damaged",
    team: "enemy",
    equipmentId: "T1",
    equipmentKind: "turret",
    amount: next.rules.dashEquipmentDamage,
    remainingHealth: turret.health,
    disabledUntilTick: null,
  });
});

test("R2b equipment reaches zero health after six dash contacts and stays disabled", () => {
  let state = createBattle({ matchId: "r2b-equipment-disabled", seed: 223 });
  for (let hit = 0; hit < state.rules.equipmentHealth / state.rules.dashEquipmentDamage; hit += 1) {
    placeP1AtEnemyTurretApproach(state);
    // Each contact is an independent physical setup; make the test explicit
    // about bypassing the authored 54-tick dash reuse wait.
    state.dashCooldownUntilTick.P1 = state.tick;
    state = stepBattle(state, p1Intent(state, { dash: { x: 1, y: 0 } }));
  }

  const turret = state.artillery.turrets["enemy:T1"];
  assert.equal(turret.health, 0);
  assert.equal(turret.disabledUntilTick, 485);

  placeP1AtEnemyTurretApproach(state);
  state.dashCooldownUntilTick.P1 = state.tick;
  const blocked = stepBattle(state, p1Intent(state, { dash: { x: 1, y: 0 } }));
  assert.equal(blocked.artillery.turrets["enemy:T1"].health, 0);
  assert.equal(blocked.lastStep.events.some((event) => event.type === "equipment_damaged" && event.equipmentId === "T1"), false);
});

test("R2b dash applies the same equipment damage contract to an enemy supply port", () => {
  const state = createBattle({ matchId: "r2b-supply-contact", seed: 229 });
  placeP1AtEnemySupplyApproach(state);

  const next = stepBattle(state, p1Intent(state, { dash: { x: 1, y: 0 } }));
  const port = next.logistics.ports["enemy:supply_1"];

  assert.equal(port.health, next.rules.equipmentHealth - next.rules.dashEquipmentDamage);
  assert.equal(next.lastStep.events.some((event) => event.type === "equipment_damaged" && event.equipmentKind === "supply_port" && event.equipmentId === "supply_1"), true);
  assert.equal(next.lastStep.acceptedInputKinds.includes("equipment_contact"), true);
});

test("R2b disabled supply ports pause spawning and restore after the authored duration", () => {
  let state = createBattle({ matchId: "r2b-equipment-restore", seed: 227 });
  const port = state.logistics.ports["enemy:supply_1"];
  port.nextSpawnTick = state.tick;
  port.health = 0;
  port.disabledUntilTick = state.tick;

  state = stepBattle(state, p1Intent(state));
  assert.equal(state.lastStep.events.some((event) => event.type === "case_spawned" && event.portId === "supply_1"), false);
  assert.equal(state.logistics.ports["enemy:supply_1"].health, 0);

  state = stepBattle(state, p1Intent(state));
  assert.equal(state.logistics.ports["enemy:supply_1"].health, state.rules.equipmentHealth);
  assert.equal(state.logistics.ports["enemy:supply_1"].disabledUntilTick, null);
  assert.equal(state.lastStep.events.some((event) => event.type === "equipment_restored" && event.equipmentId === "supply_1"), true);
  assert.equal(state.lastStep.events.some((event) => event.type === "case_spawned" && event.portId === "supply_1"), true);
});
