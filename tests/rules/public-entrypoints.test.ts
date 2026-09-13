import assert from "node:assert/strict";
import test from "node:test";
import { createBattle, physicalBattle, stepBattle } from "../../src/index.ts";

test("root entrypoints keep the PR4 battle and physical preview namespaces independent", () => {
  const common = createBattle({ matchId: "public-common", seed: 17 });
  assert.equal(Object.keys(common.catalog).length, 8);
  assert.equal(common.world.tick, 0);
  const commonAfter = stepBattle(common);
  assert.equal(commonAfter.world.tick, 1);
  assert.equal(Object.keys(commonAfter.world.projectiles).length, 0);
  assert.equal("fixedActors" in commonAfter, false);

  const physical = physicalBattle.createBattle({ matchId: "public-physical", seed: 17 });
  assert.equal(physical.tick, 0);
  assert.ok(physical.fixedActors.P1);
  assert.ok(physical.battleCases);
  const physicalAfter = physicalBattle.stepBattle(physical);
  assert.equal(physicalAfter.tick, 1);
  assert.ok(physicalAfter.fixedActors.P1);
  assert.equal("world" in physicalAfter, false);
});

test("showing a hidden battle does not implicitly resume either public entrypoint", () => {
  const commonHidden = createBattle({ matchId: "public-common-hidden", seed: 18, nowVisible: false });
  const commonShown = stepBattle(commonHidden, [{
    kind: "visibility",
    matchId: commonHidden.world.matchId,
    visible: true,
  }]);
  assert.equal(commonShown.world.phase, "paused");
  assert.equal(commonShown.world.tick, 0);

  const physical = physicalBattle.createBattle({ matchId: "public-physical-hidden", seed: 18 });
  const physicalHidden = physicalBattle.setBattleVisibility(physical, false);
  const physicalShown = physicalBattle.setBattleVisibility(physicalHidden, true);
  assert.equal(physicalShown.phase, "paused");
  assert.equal(physicalShown.tick, 0);
  const physicalAfter = physicalBattle.stepBattle(physicalShown);
  assert.equal(physicalAfter.phase, "paused");
  assert.equal(physicalAfter.tick, 0);
});
