import assert from "node:assert/strict";
import test from "node:test";
import { createBattle, stepBattle } from "../../src/simulation/physical-battle.ts";

test("temporary R2r seed probe", { timeout: 300_000 }, () => {
  const seeds = [1, 2, 3, 12_345, 20_260_901, 20_260_913, 42, 99_999_999];
  const results = [];
  for (const seed of seeds) {
    let state = createBattle({ matchId: "temporary-r2r-seed-probe", seed });
    while (state.phase === "running" && state.tick < 9_000) state = stepBattle(state);
    results.push({ seed, tick: state.tick, phase: state.phase, outcome: state.outcome });
  }
  console.log(JSON.stringify({ temporarySeedProbe: results }));
  assert.fail("temporary diagnostic only");
});
