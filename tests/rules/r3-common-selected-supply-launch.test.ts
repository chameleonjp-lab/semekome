import assert from "node:assert/strict";
import test from "node:test";
import type { BattleState } from "../../src/domain/battle.ts";
import type { WorldEvent } from "../../src/domain/types.ts";
import { supplyBagForCycle } from "../../src/logistics/supply-schedule.ts";
import { assertBattleConsistent, createBattle, stepBattle } from "../../src/simulation/battle.ts";
import { atTurret, command } from "./battle-helpers.ts";

function playerCaseEvents(state: BattleState): Array<Extract<WorldEvent, { type: "case_spawned" }>> {
  return state.world.lastStep.events.filter((event): event is Extract<WorldEvent, { type: "case_spawned" }> =>
    event.type === "case_spawned" && event.team === "player",
  );
}

test("R3 selected player allocation reaches a common turret launch", () => {
  const seed = 915;
  const allocation = [
    "split_payload", "split_payload",
    "disruption_pack", "disruption_pack", "disruption_pack",
    "breach_lance",
    "adhesive_pod", "adhesive_pod",
  ] as const;
  let state = createBattle({
    matchId: "r3-common-selected-supply-launch",
    seed,
    playerSupplyAllocation: allocation,
  });
  for (const port of Object.values(state.supply.ports)) {
    port.nextSpawnTick = port.team === "player" ? 0 : 100_000;
  }

  state = stepBattle(state);

  const spawned = playerCaseEvents(state);
  const expected = supplyBagForCycle(seed, "player", 0, allocation);
  assert.deepEqual(spawned.map((event) => event.portId), ["supply_1", "supply_2", "supply_3", "supply_4"]);
  assert.deepEqual(spawned.map((event) => event.caseType), expected.slice(0, 4));
  const selected = spawned.find((event) => event.caseType === "split_payload");
  assert.ok(selected);

  // Trusted fixture placement: this bypasses movement while exercising only
  // the public pickup/load/operate command boundary below.
  atTurret(state, "P1", "T1");
  const object = state.world.objects[selected.objectId];
  assert.ok(object);
  assert.equal(object.location.kind, "floor");
  object.location = {
    kind: "floor",
    team: "player",
    roomId: state.world.actors.P1.currentRoomId,
    position: { ...state.world.actors.P1.position },
  };

  let next = stepBattle(state, [
    command(state, "pickup", { objectId: selected.objectId }),
    command(state, "aim", { turretId: "T1", route: "direct", partId: "P4" }),
    command(state, "load", { objectId: selected.objectId, turretId: "T1" }),
    command(state, "operate", { turretId: "T1" }),
  ]);
  assert.deepEqual(next.lastCombatStep.rejected, []);
  let launch = next.lastCombatStep.events.find((event) => event.kind === "launch");
  for (let guard = 0; guard < 60 && !launch; guard += 1) {
    next = stepBattle(next);
    launch = next.lastCombatStep.events.find((event) => event.kind === "launch");
  }
  assert.ok(launch && launch.team === "player" && launch.turretId === "T1");

  const flight = next.flights[launch.projectileId];
  assert.ok(flight);
  assert.equal(flight.route, "direct");
  assert.equal(flight.partId, "P4");
  assert.ok(flight.effects.some((effect) => effect.kind === "split"));
  assert.deepEqual(next.world.objects[selected.objectId].location, {
    kind: "flying",
    projectileId: launch.projectileId,
  });
  assert.equal(next.queued[selected.objectId], undefined);
  assert.deepEqual(next.world.actors.P1.cargoIds, []);
  assert.equal(Object.values(next.world.objects).filter((item) => item.sourceTeam === "player").length, 4);
  assert.equal(next.world.lastStep.events.some((event) => event.type === "case_spawned"), false);
  assertBattleConsistent(next);
});
