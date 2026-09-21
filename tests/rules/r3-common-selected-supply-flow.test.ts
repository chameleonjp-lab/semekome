import assert from "node:assert/strict";
import test from "node:test";
import { SUPPLY_BAG } from "../../src/content/cases.ts";
import type { BattleState } from "../../src/domain/battle.ts";
import type { WorldEvent } from "../../src/domain/types.ts";
import { supplyBagForCycle } from "../../src/logistics/supply-schedule.ts";
import { assertBattleConsistent, createBattle, stepBattle } from "../../src/simulation/battle.ts";

function playerCaseEvents(state: BattleState): Array<Extract<WorldEvent, { type: "case_spawned" }>> {
  return state.world.lastStep.events.filter((event): event is Extract<WorldEvent, { type: "case_spawned" }> =>
    event.type === "case_spawned" && event.team === "player",
  );
}

test("R3 selected player allocation reaches common floor cases in port order", () => {
  const allocation = [
    "split_payload", "split_payload",
    "disruption_pack", "disruption_pack", "disruption_pack",
    "breach_lance",
    "adhesive_pod", "adhesive_pod",
  ] as const;
  let state = createBattle({
    matchId: "r3-common-selected-supply-flow",
    seed: 915,
    playerSupplyAllocation: allocation,
  });
  for (const port of Object.values(state.supply.ports)) {
    if (port.team === "player") port.nextSpawnTick = 0;
  }

  state = stepBattle(state);

  const events = playerCaseEvents(state);
  const expected = supplyBagForCycle(915, "player", 0, allocation);
  assert.deepEqual(events.map((event) => event.portId), ["supply_1", "supply_2", "supply_3", "supply_4"]);
  assert.deepEqual(events.map((event) => event.caseType), expected.slice(0, 4));
  assert.equal(state.supply.schedules.player.index, 4);
  assert.equal(state.supply.schedules.enemy.index, 0);
  assert.deepEqual(state.supply.schedules.enemy.allocation, SUPPLY_BAG);

  for (const event of events) {
    const object = state.world.objects[event.objectId];
    assert.ok(object);
    assert.equal(object.weaponId, event.caseType);
    assert.equal(object.sourceTeam, "player");
    assert.equal(object.originGroupId, `common-group-player-${event.portId}-g01`);
    assert.equal(object.location.kind, "floor");
    assert.equal(object.location.kind === "floor" && object.location.team, "player");
  }
  assert.equal(new Set(events.map((event) => event.objectId)).size, 4);
  assert.equal(Object.values(state.world.objects).filter((object) => object.sourceTeam === "player").length, 4);
  assertBattleConsistent(state);
});
