import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSupplySchedule,
  createSupplySchedule,
  currentSupplyType,
} from "../../src/logistics/supply-schedule.ts";
import { createBattle, stepBattle, type BattleState } from "../../src/simulation/physical-battle.ts";

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
