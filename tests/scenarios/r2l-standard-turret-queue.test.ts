import assert from "node:assert/strict";
import test from "node:test";
import {
  createBattle,
  getInteraction,
  stepBattle,
  type BattleState,
} from "../../src/simulation/physical-battle.ts";

const STANDARD_ALLOCATION = [
  "standard_slug", "standard_slug", "standard_slug",
  "dense_payload", "dense_payload", "screen_panel", "screen_panel", "fast_dart",
] as const;

function placeP1AtTurret(state: BattleState): void {
  const turret = state.artillery.turrets["player:T1"];
  assert.ok(turret);
  const actor = state.actors.P1;
  actor.currentRoomId = turret.roomId;
  actor.location = {
    area: "castle",
    castleTeam: "player",
    roomId: turret.roomId,
    pathRooms: [turret.roomId],
    pathGates: [],
  };
  actor.position = {
    x: Math.floor(turret.operatorPosition.x / 1_000),
    y: Math.floor(turret.operatorPosition.y / 1_000),
  };
  state.fixedActors.P1.position = { ...turret.operatorPosition };
  state.fixedActors.P1.remainder = { x: 0, y: 0 };
}

function giveCaseToP1(state: BattleState, caseId: string): void {
  const caseState = state.battleCases[caseId];
  assert.ok(caseState);
  for (const actor of Object.values(state.actors)) {
    actor.cargoIds = actor.cargoIds.filter((id) => id !== caseId);
    state.cargoSlots[actor.id] = state.cargoSlots[actor.id].map((id) => id === caseId ? null : id) as [string | null, string | null];
  }
  const turret = state.artillery.turrets["player:T1"];
  assert.ok(turret);
  state.actors.P1.cargoIds = [caseId];
  state.cargoSlots.P1 = [caseId, null];
  caseState.location = "carried";
  caseState.floorLocation = undefined;
  caseState.currentTeam = "player";
  caseState.position = undefined;
  caseState.currentPosition = { ...turret.operatorPosition };
  caseState.ownerActorId = "P1";
  caseState.ownerGeneration = state.actors.P1.generation;
  caseState.turretId = undefined;
  caseState.queueIndex = undefined;
  caseState.flightId = undefined;
  caseState.stagingSlot = undefined;
  caseState.roomId = turret.roomId;
}

function deliverSelectedCase(state: BattleState, caseId: string): BattleState {
  const interaction = getInteraction(state, "P1", 0);
  const turret = state.artillery.turrets["player:T1"];
  const selected = state.battleCases[caseId];
  assert.equal(interaction.handles.includes("deliver"), true,
    `${caseId} can be delivered; handles=${interaction.handles.join(",")}; ` +
    `cargo=${JSON.stringify(state.cargoSlots.P1)} actorCargo=${JSON.stringify(state.actors.P1.cargoIds)} ` +
    `owner=${selected?.ownerActorId}:${selected?.ownerGeneration} location=${selected?.location} ` +
    `turret=${turret?.id} queue=${JSON.stringify(turret?.queueIds)} handoff=${JSON.stringify(turret?.stagingSlots)}`);
  return stepBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    handle: "deliver",
    slot: 0,
    route: "direct",
    part: "P1",
    contextToken: interaction.contextToken,
  });
}

function assertNoDuplicateLineage(state: BattleState, caseIds: readonly string[]): void {
  const seen = new Set<string>();
  const remember = (id: string): void => {
    assert.equal(seen.has(id), false, `${id} appears in more than one physical location`);
    seen.add(id);
  };
  for (const turret of Object.values(state.artillery.turrets)) {
    for (const id of turret.queueIds) remember(id);
    for (const id of turret.stagingSlots) if (id) remember(id);
  }
  for (const flight of Object.values(state.artillery.flights)) remember(flight.objectId);
  for (const actor of Object.values(state.actors)) for (const id of actor.cargoIds) remember(id);
  assert.deepEqual(new Set(caseIds), new Set(caseIds.filter((id) => state.battleCases[id]?.location !== "consumed")), "all queued cases remain live in the bounded check");
  for (const id of caseIds) {
    const caseState = state.battleCases[id];
    assert.ok(caseState);
    assert.equal(seen.has(id), true, `${id} has exactly one queue, handoff, flight, or cargo location`);
  }
}

test("標準配分の砲台待ち列は満杯でも受渡しを失わず発射後に一度だけ続行する", () => {
  let state = createBattle({ matchId: "r2l-standard-turret-queue", seed: 20260914 });
  assert.deepEqual(state.logistics.playerAllocation, STANDARD_ALLOCATION);
  for (const port of Object.values(state.logistics.ports)) {
    port.nextSpawnTick = port.team === "player" ? 0 : 100_000;
  }
  state = stepBattle(state);
  const playerCases = Object.values(state.battleCases)
    .filter((item) => item.sourceTeam === "player" && item.location === "floor")
    .slice(0, 4);
  assert.equal(playerCases.length, 4, "the standard first supply wave provides four cases for the queue check");

  placeP1AtTurret(state);
  state.actors.P1.protectedUntilTick = null;
  state.artillery.nextLaunchTick.player = state.tick + 10_000;
  state.nextLaunchTick.player = state.artillery.nextLaunchTick.player;

  for (const caseState of playerCases) {
    giveCaseToP1(state, caseState.id);
    state = deliverSelectedCase(state, caseState.id);
    assert.equal(state.lastStep.rejected.length, 0);
  }

  const turret = state.artillery.turrets["player:T1"];
  assert.deepEqual(turret.queueIds, [playerCases[0].id, playerCases[1].id], "the first two cases occupy the authored queue capacity");
  assert.deepEqual(turret.stagingSlots, [playerCases[2].id, playerCases[3].id], "the next two cases remain in stable handoff slots");
  assert.equal(getInteraction(state, "P1", 0).handles.includes("load"), false, "a full queue does not offer load");
  assert.equal(getInteraction(state, "P1", 0).pickupCaseId, undefined, "an allied handoff is not exposed as pickup");
  assertNoDuplicateLineage(state, playerCases.map((item) => item.id));

  state.artillery.nextLaunchTick.player = state.tick;
  state.nextLaunchTick.player = state.tick;
  state = stepBattle(state);
  const firstLaunch = state.lastStep.events.find((event): event is Extract<BattleState["lastStep"]["events"][number], { type: "projectile_launched" }> =>
    event.type === "projectile_launched" && event.team === "player");
  assert.equal(firstLaunch?.objectId, playerCases[0].id, "the oldest queued case launches first");
  assert.deepEqual(state.artillery.turrets["player:T1"].queueIds, [playerCases[1].id]);
  assert.deepEqual(state.artillery.turrets["player:T1"].stagingSlots, [playerCases[2].id, playerCases[3].id]);
  assertNoDuplicateLineage(state, playerCases.map((item) => item.id));

  state = stepBattle(state);
  assert.deepEqual(state.artillery.turrets["player:T1"].queueIds, [playerCases[1].id, playerCases[2].id], "the first staged case is loaded once after a queue slot opens");
  assert.deepEqual(state.artillery.turrets["player:T1"].stagingSlots, [null, playerCases[3].id]);
  assert.equal(state.battleCases[playerCases[2].id].queueIndex, 1);
  assertNoDuplicateLineage(state, playerCases.map((item) => item.id));

  state.artillery.nextLaunchTick.player = state.tick;
  state.nextLaunchTick.player = state.tick;
  state = stepBattle(state);
  const secondLaunch = state.lastStep.events.find((event): event is Extract<BattleState["lastStep"]["events"][number], { type: "projectile_launched" }> =>
    event.type === "projectile_launched" && event.team === "player");
  assert.equal(secondLaunch?.objectId, playerCases[1].id, "the remaining queued case keeps FIFO order");
  state = stepBattle(state);
  assert.deepEqual(state.artillery.turrets["player:T1"].queueIds, [playerCases[2].id, playerCases[3].id], "the second staged case is loaded after the next release");
  assert.deepEqual(state.artillery.turrets["player:T1"].stagingSlots, [null, null]);
  assertNoDuplicateLineage(state, playerCases.map((item) => item.id));
});
