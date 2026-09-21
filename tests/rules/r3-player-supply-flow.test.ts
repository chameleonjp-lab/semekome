import assert from "node:assert/strict";
import test from "node:test";
import { floorCell } from "../../src/actors/movement.ts";
import { supplyBagForCycle } from "../../src/logistics/supply-schedule.ts";
import {
  createBattle,
  getInteraction,
  stepBattle,
  type BattleIntent,
  type BattleState,
} from "../../src/simulation/physical-battle.ts";
import type { CaseType } from "../../src/content/cases.ts";

const PLAYER_ALLOCATION = [
  "split_payload", "split_payload",
  "disruption_pack", "disruption_pack", "disruption_pack",
  "breach_lance",
  "adhesive_pod", "adhesive_pod",
] as const satisfies readonly CaseType[];

function playerHandle(state: BattleState, handle: "pickup" | "deliver", slot = 0): BattleIntent {
  const interaction = getInteraction(state, "P1", slot);
  assert.equal(interaction.handles.includes(handle), true, `${handle} should be available`);
  return {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    handle,
    slot,
    route: "direct",
    part: "P4",
    contextToken: interaction.contextToken,
  };
}

function placePlayer(state: BattleState, position: { x: number; y: number }, roomId: string): void {
  const actor = state.actors.P1;
  actor.currentRoomId = roomId;
  actor.location = {
    area: "castle",
    castleTeam: "player",
    roomId,
    pathRooms: [roomId],
    pathGates: [],
  };
  actor.position = { x: floorCell(position.x), y: floorCell(position.y) };
  state.fixedActors.P1.position = { ...position };
  state.fixedActors.P1.remainder = { x: 0, y: 0 };
}

test("R3 selected player supply reaches physical launch and its authored effect", () => {
  const seed = 915;
  let state = createBattle({
    matchId: "r3-player-supply-flow",
    seed,
    playerSupplyAllocation: PLAYER_ALLOCATION,
  });

  for (const port of Object.values(state.logistics.ports)) {
    port.nextSpawnTick = port.team === "player" ? 0 : 100_000;
  }
  state = stepBattle(state);

  const expectedOrder = supplyBagForCycle(seed, "player", 0, PLAYER_ALLOCATION);
  const spawned = state.lastStep.events.filter((event): event is Extract<BattleState["lastStep"]["events"][number], { type: "case_spawned" }> =>
    event.type === "case_spawned" && event.team === "player",
  );
  assert.deepEqual(spawned.map((event) => event.caseType), expectedOrder.slice(0, 4));
  assert.equal(spawned[0]?.caseType, "split_payload");

  const caseId = spawned[0]!.objectId;
  const supplyCase = state.battleCases[caseId];
  assert.ok(supplyCase?.position);
  placePlayer(state, supplyCase.position, supplyCase.roomId);
  state = stepBattle(state, playerHandle(state, "pickup"));
  assert.equal(state.lastStep.rejected.length, 0);
  assert.equal(state.battleCases[caseId]?.location, "carried");

  const turret = state.artillery.turrets["player:T1"];
  assert.ok(turret);
  placePlayer(state, turret.operatorPosition, turret.roomId);
  state = stepBattle(state, playerHandle(state, "deliver"));

  assert.equal(state.lastStep.rejected.length, 0);
  assert.equal(state.battleCases[caseId]?.location, "flying");
  assert.equal(state.battleCases[caseId]?.route, "direct");
  assert.equal(state.battleCases[caseId]?.targetPart, "P4");
  assert.equal(state.lastStep.events.some((event) =>
    event.type === "projectile_launched" && event.objectId === caseId && event.sourceActorId === "P1",
  ), true);

  for (let index = 0; index < 300 && !state.lastStep.events.some((event) => event.type === "projectile_split"); index += 1) {
    state = stepBattle(state);
  }
  assert.equal(state.lastStep.events.some((event) => event.type === "projectile_split" && event.parentProjectileId.startsWith("flight-")), true);
  assert.equal(state.battleCases[caseId]?.location, "consumed");
  assert.equal(Object.values(state.battleCases).filter((item) => item.originGroupId === state.battleCases[caseId]?.originGroupId).length, 4);
});
