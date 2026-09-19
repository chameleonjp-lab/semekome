import assert from "node:assert/strict";
import test from "node:test";
import { createSupplySchedule } from "../../src/logistics/supply-schedule.ts";
import type { BattleState } from "../../src/domain/battle.ts";
import type { WorldEvent } from "../../src/domain/types.ts";
import { assertBattleConsistent, createBattle, stepBattle } from "../../src/simulation/battle.ts";
import { assertObjectLocationsUnique } from "../../src/domain/objects.ts";

function caseEvents(state: BattleState, team: "player" | "enemy"): Array<Extract<WorldEvent, { type: "case_spawned" }>> {
  return state.world.lastStep.events.filter((event): event is Extract<WorldEvent, { type: "case_spawned" }> =>
    event.type === "case_spawned" && event.team === team,
  );
}

test("common battle automatically creates one shared schedule entry at each ready port", () => {
  let state = createBattle({ matchId: "r3-common-world-auto", seed: 907 });
  const playerEvents: Array<{ portId: string; caseType: string }> = [];
  while (state.world.tick <= 187) {
    state = stepBattle(state);
    playerEvents.push(...caseEvents(state, "player").map((event) => ({ portId: event.portId, caseType: event.caseType })));
  }

  const expected = createSupplySchedule({ seed: 907, team: "player" }).order.slice(0, 4);
  assert.deepEqual(playerEvents.map((event) => event.portId), ["supply_1", "supply_2", "supply_3", "supply_4"]);
  assert.deepEqual(playerEvents.map((event) => event.caseType), expected);
  assert.equal(state.supply.schedules.player.index, 4);
  assert.equal(Object.values(state.world.objects).filter((object) => object.sourceTeam === "player").length, 4);
  assertObjectLocationsUnique(state.world);
  assertBattleConsistent(state);
});

test("common supply keeps its cursor during disruption and does not catch up missed ticks", () => {
  let state = createBattle({ matchId: "r3-common-world-stop", seed: 911 });
  for (const port of Object.values(state.supply.ports)) {
    if (port.team === "player") port.nextSpawnTick = 0;
  }
  state.supplyStops.player.disruptedUntil = 4;

  for (let index = 0; index < 4; index += 1) state = stepBattle(state);
  assert.equal(state.supply.schedules.player.index, 0);
  assert.equal(Object.values(state.world.objects).filter((object) => object.sourceTeam === "player").length, 0);

  state = stepBattle(state);
  const spawned = caseEvents(state, "player");
  assert.equal(spawned.length, 4);
  assert.equal(state.supply.schedules.player.index, 4);
  assertObjectLocationsUnique(state.world);
});

test("common supply waits when a room has sixteen floor cases and resumes without consuming the cursor", () => {
  let state = createBattle({ matchId: "r3-common-world-floor-limit", seed: 919 });
  const port = state.world.layout.home.supplyPorts[0];
  const room = state.world.layout.home.rooms.find((candidate) => candidate.id === port.roomId);
  assert.ok(room);
  const cells = state.world.layout.home.floorCells.filter((cell) => roomContains(room!, cell)).slice(0, 16);
  for (const [index, position] of cells.entries()) {
    state.world.objects[`floor-blocker-${index}`] = {
      id: `floor-blocker-${index}`,
      weaponId: "standard_slug",
      sourceTeam: "player",
      weight: 1,
      originGroupId: `blocker-group-${index}`,
      location: { kind: "floor", team: "player", roomId: port.roomId, position: { ...position } },
    };
  }
  state.supply.ports[`player:${port.id}`].nextSpawnTick = 0;

  state = stepBattle(state);
  assert.equal(caseEvents(state, "player").length, 0);
  assert.equal(state.supply.schedules.player.index, 0);
  const retryTick = state.supply.ports[`player:${port.id}`].nextSpawnTick;
  assert.equal(retryTick, 30);

  for (const id of Object.keys(state.world.objects)) if (id.startsWith("floor-blocker-")) delete state.world.objects[id];
  while (state.world.tick <= retryTick) state = stepBattle(state);
  assert.ok(Object.values(state.world.objects).some((object) => object.id.startsWith("common-case-player-")));
  assert.ok(state.supply.schedules.player.index > 0);
  assertObjectLocationsUnique(state.world);
});

function roomContains(room: { rect: { x0: number; y0: number; x1: number; y1: number } }, point: { x: number; y: number }): boolean {
  return point.x >= room.rect.x0 && point.x < room.rect.x1 && point.y >= room.rect.y0 && point.y < room.rect.y1;
}
