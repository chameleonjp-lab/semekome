import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSupplySchedule,
  createSupplySchedule,
  currentSupplyType,
  previewSupplyTypes,
  supplyBagForCycle,
} from "../../src/logistics/supply-schedule.ts";
import { SUPPLY_BAG } from "../../src/content/cases.ts";
import { createBattle as createCommonBattle } from "../../src/simulation/battle.ts";
import { getPlayerSupplyPreview as getCommonPlayerSupplyPreview } from "../../src/simulation/common-supply.ts";
import { createBattle, getPlayerSupplyPreview as getPhysicalPlayerSupplyPreview, stepBattle, type BattleState } from "../../src/simulation/physical-battle.ts";

function counts(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function playerSupplyEvents(state: BattleState): Array<{ portId: string; caseType: string }> {
  return state.lastStep.events
    .filter((event): event is Extract<BattleState["lastStep"]["events"][number], { type: "case_spawned" }> =>
      event.type === "case_spawned" && event.team === "player")
    .map((event) => ({ portId: event.portId, caseType: event.caseType }));
}

test("R3 common supply schedule is deterministic and preserves its eight-case allocation", () => {
  const first = createSupplySchedule({ seed: 811, team: "player" });
  const second = createSupplySchedule({ seed: 811, team: "player" });
  assert.deepEqual(first.order, second.order);

  let schedule = first;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    assert.equal(schedule.cycle, cycle);
    const generated: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      generated.push(currentSupplyType(schedule));
      schedule = advanceSupplySchedule(schedule);
    }
    assert.deepEqual(counts(generated), {
      standard_slug: 3,
      dense_payload: 2,
      screen_panel: 2,
      fast_dart: 1,
    });
  }
  assert.equal(schedule.cycle, 3);
  assert.equal(schedule.index, 0);
});

test("R3 common supply schedule rejects malformed allocations before a case can be consumed", () => {
  assert.throws(
    () => createSupplySchedule({ seed: 821, team: "enemy", allocation: ["standard_slug"] }),
    /exactly eight cases/,
  );
  assert.throws(
    () => createSupplySchedule({ seed: 823, team: "enemy", allocation: [
      "standard_slug", "standard_slug", "standard_slug", "dense_payload",
      "dense_payload", "screen_panel", "screen_panel", "unknown" as "standard_slug",
    ] }),
    /unknown case type/,
  );
  assert.throws(
    () => createSupplySchedule({ seed: 824, team: "player", allocation: [
      "standard_slug", "standard_slug", "dense_payload", "screen_panel",
      "fast_dart", "split_payload", "breach_lance", "adhesive_pod",
    ] }),
    /exactly four case types/,
  );
  assert.throws(
    () => createSupplySchedule({ seed: 825, team: "player", allocation: [
      "standard_slug", "standard_slug", "standard_slug", "standard_slug",
      "dense_payload", "dense_payload", "screen_panel", "fast_dart",
    ] }),
    /between one and three/,
  );
});

test("R3 player loadout validation and preview keep the enemy schedule private", () => {
  const allocation = [
    "split_payload", "split_payload",
    "disruption_pack", "disruption_pack", "disruption_pack",
    "breach_lance",
    "adhesive_pod", "adhesive_pod",
  ] as const;
  const state = createCommonBattle({
    matchId: "r3-player-supply-preview",
    seed: 826,
    playerSupplyAllocation: allocation,
  });

  assert.deepEqual(state.supply.allocation, allocation);
  assert.deepEqual(state.supply.schedules.player.allocation, allocation);
  assert.deepEqual(state.supply.schedules.enemy.allocation, SUPPLY_BAG);
  assert.deepEqual(getCommonPlayerSupplyPreview(state), state.supply.schedules.player.order.slice(0, 2));
  assert.equal(getCommonPlayerSupplyPreview(state).length, 2);
  assert.equal("enemySupplyPreview" in state, false);
});

test("R3 two-case preview crosses the end of an eight-case cycle without mutating it", () => {
  const allocation = [
    "standard_slug", "standard_slug", "standard_slug",
    "dense_payload", "dense_payload",
    "screen_panel", "fast_dart", "fast_dart",
  ] as const;
  const initial = createSupplySchedule({ seed: 828, team: "player", allocation });
  let tail = initial;
  for (let index = 0; index < 7; index += 1) tail = advanceSupplySchedule(tail);
  const preview = previewSupplyTypes(tail);
  const nextCycle = createSupplySchedule({ seed: 828, team: "player", cycle: 1, allocation });
  assert.deepEqual(preview, [tail.order[7], nextCycle.order[0]]);
  assert.equal(tail.index, 7);
  assert.throws(() => previewSupplyTypes(tail, 3), /between zero and two/);
});

test("R3 physical battle applies the player allocation and keeps its two-case preview private", () => {
  const allocation = [
    "split_payload", "split_payload",
    "disruption_pack", "disruption_pack", "disruption_pack",
    "breach_lance",
    "adhesive_pod", "adhesive_pod",
  ] as const;
  let state = createBattle({
    matchId: "r3-physical-player-supply-preview",
    seed: 829,
    playerSupplyAllocation: allocation,
  });
  const initialOrder = supplyBagForCycle(829, "player", 0, allocation);
  assert.deepEqual(state.logistics.playerAllocation, allocation);
  assert.deepEqual(state.logistics.bags.player, initialOrder);
  assert.deepEqual(state.logistics.bags.enemy, supplyBagForCycle(829, "enemy"));
  assert.deepEqual(getPhysicalPlayerSupplyPreview(state), initialOrder.slice(0, 2));

  for (const port of Object.values(state.logistics.ports)) {
    if (port.team === "player") port.nextSpawnTick = 0;
  }
  state.logistics.bagIndices.player = 7;
  const nextOrder = supplyBagForCycle(829, "player", 1, allocation);
  const beforePreview = [...state.logistics.bags.player];
  assert.deepEqual(getPhysicalPlayerSupplyPreview(state), [initialOrder[7], nextOrder[0]]);
  assert.deepEqual(state.logistics.bags.player, beforePreview);
  assert.equal(state.logistics.bagIndices.player, 7);

  state = stepBattle(state);
  assert.deepEqual(playerSupplyEvents(state).map((event) => event.caseType), [initialOrder[7], ...nextOrder.slice(0, 3)]);
  assert.equal(state.logistics.bagCycles.player, 1);
  assert.equal(state.logistics.bagIndices.player, 3);
  assert.deepEqual(state.logistics.playerAllocation, allocation);
  assert.throws(() => getPhysicalPlayerSupplyPreview(state, 3), /between zero and two/);
  assert.throws(
    () => createBattle({ matchId: "r3-physical-invalid-allocation", seed: 830, playerSupplyAllocation: ["standard_slug"] }),
    /exactly eight cases/,
  );
});

test("R3 blocked physical supply leaves the shared schedule in place and resumes one case per port", () => {
  let state = createBattle({ matchId: "r3-common-supply-schedule-blocked", seed: 827 });
  const initialOrder = [...state.logistics.bags.player];
  for (const port of Object.values(state.logistics.ports)) {
    if (port.team === "player") port.nextSpawnTick = 0;
  }
  state.logistics.supplyStops.player.disruptedUntilTick = 3;

  state = stepBattle(state);
  state = stepBattle(state);
  state = stepBattle(state);
  assert.deepEqual(state.logistics.bags.player, initialOrder);
  assert.equal(state.logistics.bagIndices.player, 0);
  assert.equal(playerSupplyEvents(state).length, 0);

  state = stepBattle(state);
  const spawned = playerSupplyEvents(state);
  assert.deepEqual(spawned.map((event) => event.portId), ["supply_1", "supply_2", "supply_3", "supply_4"]);
  assert.deepEqual(spawned.map((event) => event.caseType), initialOrder.slice(0, 4));
  assert.equal(state.logistics.bagIndices.player, 4);
});
