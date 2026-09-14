import assert from "node:assert/strict";
import test from "node:test";
import { caseDefinition, type CaseType } from "../../src/content/cases.ts";
import { floorCell } from "../../src/actors/movement.ts";
import { createBattle, stepBattle, type BattleIntent, type BattleState } from "../../src/simulation/physical-battle.ts";
import type { PartId, TeamId } from "../../src/domain/types.ts";

function neutral(state: BattleState): BattleIntent {
  return {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    direction: { x: 0, y: 0 },
  };
}

function addFlight(
  state: BattleState,
  type: CaseType,
  team: TeamId,
  progress: number,
  part: PartId = "P1",
): string {
  const definition = caseDefinition(type)!;
  const suffix = `${type}-${Object.keys(state.artillery.flights).length + 1}`;
  const caseId = `effect-case-${suffix}`;
  const flightId = `effect-flight-${suffix}`;
  const groupId = `effect-group-${suffix}`;
  const targetTeam: TeamId = team === "player" ? "enemy" : "player";
  state.logistics.groups[groupId] = { id: groupId, team, portId: "supply_1", caseIds: [caseId], retired: false };
  state.battleCases[caseId] = {
    id: caseId,
    type,
    sourceTeam: team,
    currentTeam: team,
    weight: definition.weight,
    location: "flying",
    originGroupId: groupId,
    sourcePortId: "supply_1",
    createdTick: -1,
    roomId: "ammo_a",
    flightId,
    route: "direct",
    targetPart: part,
    interceptRemaining: definition.interceptHits,
  };
  state.objects[caseId] = {
    id: caseId,
    weaponId: type,
    sourceTeam: team,
    weight: definition.weight,
    originGroupId: groupId,
    location: { kind: "flying", projectileId: flightId },
  };
  state.projectiles[flightId] = {
    id: flightId,
    objectId: caseId,
    team,
    sourceActorId: team === "player" ? "P1" : "E01",
    sourceGeneration: 0,
    targetTeam,
    targetPartId: part,
  };
  state.artillery.flights[flightId] = {
    id: flightId,
    objectId: caseId,
    team,
    sourceActorId: team === "player" ? "P1" : "E01",
    sourceGeneration: 0,
    targetTeam,
    route: "direct",
    progress,
    targetPart: part,
    interceptRemaining: definition.interceptHits,
    createdTick: -1,
    distanceUnits: 120,
    speedUnitsPerSecond: definition.flightSpeedUnitsPerSecond,
    previousProgress: progress,
  };
  return flightId;
}

test("R3 split payload creates three non-recursive child flights at the midpoint", () => {
  const state = createBattle({ matchId: "r3-split-effect", seed: 701 });
  const parentId = addFlight(state, "split_payload", "player", 0.5, "P4");
  const next = stepBattle(state, neutral(state));
  const split = next.lastStep.events.find((event) => event.type === "projectile_split");
  assert.ok(split && split.type === "projectile_split");
  assert.equal(split.parentProjectileId, parentId);
  assert.equal(split.childProjectileIds.length, 3);
  assert.equal(next.artillery.flights[parentId], undefined);
  assert.deepEqual(
    split.childProjectileIds.map((id) => next.artillery.flights[id]?.damageOverride),
    [4, 4, 4],
  );
  assert.ok(split.childProjectileIds.every((id) => next.artillery.flights[id]?.splitAttempted === true));
  const parentCase = Object.values(next.battleCases).find((item) => item.id === "effect-case-split_payload-1");
  assert.equal(parentCase?.location, "consumed");
  assert.equal(new Set(Object.values(next.battleCases).map((item) => item.originGroupId)).size, 1);
});

test("R3 disruption stops target supply without stopping artillery and respects the immunity window", () => {
  let state = createBattle({ matchId: "r3-disruption-effect", seed: 703 });
  for (const port of Object.values(state.logistics.ports)) if (port.team === "enemy") port.nextSpawnTick = 0;
  addFlight(state, "disruption_pack", "player", 0.999);
  state = stepBattle(state, neutral(state));
  const stop = state.logistics.supplyStops.enemy;
  assert.equal(stop.disruptedUntilTick, 360);
  assert.equal(stop.immuneUntilTick, 600);
  assert.equal(state.lastStep.events.some((event) => event.type === "supply_disrupted"), true);
  assert.equal(state.lastStep.events.some((event) => event.type === "case_spawned" && event.team === "enemy"), false);

  addFlight(state, "disruption_pack", "player", 0.999);
  state = stepBattle(state, neutral(state));
  assert.equal(state.logistics.supplyStops.enemy.disruptedUntilTick, 360, "immune period must not extend the stop");
  assert.equal(state.lastStep.events.some((event) => event.type === "supply_disrupted"), false);
});

test("R3 adhesive pod replaces one enemy-entry slow zone and affects walking speed", () => {
  let state = createBattle({ matchId: "r3-slow-effect", seed: 707 });
  addFlight(state, "adhesive_pod", "player", 0.999);
  state = stepBattle(state, neutral(state));
  const zone = state.logistics.slowZones.enemy;
  assert.ok(zone);
  assert.equal(zone.multiplier, 0.65);
  assert.equal(zone.radiusSubunits, 1000);
  assert.equal(state.lastStep.events.some((event) => event.type === "slow_zone_created"), true);

  const actor = state.actors.P1;
  actor.location = { area: "castle", castleTeam: "enemy", roomId: "central_corridor", pathRooms: ["central_corridor"], pathGates: [] };
  actor.currentRoomId = "central_corridor";
  state.fixedActors.P1.position = { ...zone.center };
  state.fixedActors.P1.remainder = { x: 0, y: 0 };
  actor.position = { x: floorCell(zone.center.x), y: floorCell(zone.center.y) };
  const before = state.fixedActors.P1.position.x;
  state = stepBattle(state, { ...neutral(state), direction: { x: 1, y: 0 } });
  assert.equal(state.fixedActors.P1.position.x - before, 32, "50-unit walking speed × 0.65 truncates to 32");

  addFlight(state, "adhesive_pod", "player", 0.999);
  state = stepBattle(state, neutral(state));
  assert.equal(state.logistics.slowZones.enemy?.expiresAtTick, state.tick - 1 + 240);
});
