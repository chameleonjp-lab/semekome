import assert from "node:assert/strict";
import test from "node:test";
import {
  createBattle,
  getInteraction,
  stepBattle,
  type AllyActorId,
  type BattleDirection,
  type BattleIntent,
  type BattleState,
} from "../../src/simulation/physical-battle.ts";

const NEUTRAL: BattleDirection = { x: 0, y: 0 };
const P1_AMMO_APPROACH_X = 94_500;
const P1_AMMO_PICKUP_Y = 13_500;
const P1_TURRET_TRAVEL_Y = 12_000;
const P1_TURRET_APPROACH_X = 105_850;

function p1Intent(state: BattleState, partial: Partial<BattleIntent> = {}): BattleIntent {
  return {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    ...partial,
  };
}

function sign(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function p1ToAmmoDirection(state: BattleState, firstPickup: boolean): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (firstPickup) {
    if (Math.abs(position.x - P1_AMMO_APPROACH_X) > 50) return { x: sign(P1_AMMO_APPROACH_X - position.x), y: 0 };
    if (Math.abs(position.y - P1_AMMO_PICKUP_Y) > 50) return { x: 0, y: sign(P1_AMMO_PICKUP_Y - position.y) };
  } else {
    if (position.x > P1_AMMO_APPROACH_X + 50) {
      if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
      return { x: -1, y: 0 };
    }
    if (position.y < P1_AMMO_PICKUP_Y - 50) return { x: 0, y: 1 };
  }
  return { x: -1, y: 0 };
}

function isNearPlayerTurret(state: BattleState): boolean {
  const turret = state.artillery.turrets["player:T1"];
  const position = state.fixedActors.P1.position;
  const dx = position.x - turret.position.x;
  const dy = position.y - turret.position.y;
  return dx * dx + dy * dy <= 800 * 800;
}

function p1ToTurretDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (position.x < P1_TURRET_APPROACH_X - 50) {
    if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
    return { x: 1, y: 0 };
  }
  if (!isNearPlayerTurret(state)) return { x: 0, y: 1 };
  return NEUTRAL;
}

function distanceFromPlayerTurret(state: BattleState): number {
  const turret = state.artillery.turrets["player:T1"];
  const position = state.fixedActors.P1.position;
  return Math.hypot(position.x - turret.position.x, position.y - turret.position.y);
}

function assertAllyHoldAndSupply(state: BattleState, allyId: AllyActorId): BattleState {
  assert.equal(state.actors[allyId].alive, true, `${allyId} is available for the standard-route command check`);
  const heldPosition = { ...state.fixedActors[allyId].position };

  state = stepBattle(state, p1Intent(state, { allyCommand: { allyId, kind: "hold" } }));
  assert.ok(state.lastStep.acceptedInputKinds.includes(`ally:hold:${allyId}`));
  assert.equal(state.allyOrders[allyId]?.kind, "hold");
  for (let tick = 0; tick < 12; tick += 1) state = stepBattle(state, p1Intent(state));
  assert.deepEqual(state.fixedActors[allyId].position, heldPosition, `${allyId} remains stationary while held in the standard run`);
  assert.equal(state.crew.assignments[allyId].task, "idle");

  state = stepBattle(state, p1Intent(state, { allyCommand: { allyId, kind: "supply" } }));
  assert.ok(state.lastStep.acceptedInputKinds.includes(`ally:supply:${allyId}`));
  assert.equal(state.allyOrders[allyId], null, `${allyId} returns to the automatic supply policy after release`);

  let movedAfterRelease = false;
  for (let tick = 0; tick < 60; tick += 1) {
    const previous = { ...state.fixedActors[allyId].position };
    state = stepBattle(state, p1Intent(state));
    if (state.fixedActors[allyId].position.x !== previous.x || state.fixedActors[allyId].position.y !== previous.y) {
      movedAfterRelease = true;
      break;
    }
  }
  assert.equal(movedAfterRelease, true, `${allyId} resumes physical supply movement after release`);
  return state;
}

test("標準配分の通常戦でP2/P3命令とP1公開ルートが同時に成立する", { timeout: 120_000 }, () => {
  let state = createBattle({ matchId: "r2o-standard-ally-command-route", seed: 20260913 });
  assert.deepEqual(state.logistics.playerAllocation, [
    "standard_slug", "standard_slug", "standard_slug",
    "dense_payload", "dense_payload", "screen_panel", "screen_panel", "fast_dart",
  ]);
  assert.equal(state.actors.P2.protectedUntilTick, null);
  assert.equal(state.actors.P3.protectedUntilTick, null);

  state = assertAllyHoldAndSupply(state, "P2");
  state = assertAllyHoldAndSupply(state, "P3");

  let phase: "pickup" | "turret" = "pickup";
  let deliveries = 0;
  let p1FloorPickups = 0;
  let alliedCarriedCases = 0;
  let selfHandoffPickups = 0;
  let leftTurretAfterDelivery = false;
  let deliveryWasMade = false;

  for (let tick = state.tick; tick < 4_200 && state.phase === "running"; tick += 1) {
    if (!state.actors.P1.alive) {
      state = stepBattle(state);
      continue;
    }

    let intent = p1Intent(state, { direction: NEUTRAL });
    const interaction = getInteraction(state, "P1", 0);
    if (phase === "pickup") {
      if (interaction.handles.includes("load")) {
        intent = p1Intent(state, { handle: "load", slot: 0, contextToken: interaction.contextToken });
      } else if (interaction.handles.includes("pickup")) {
        const candidate = interaction.pickupCaseId ? state.battleCases[interaction.pickupCaseId] : undefined;
        if (candidate?.location === "handoff" && candidate.currentTeam === "player") selfHandoffPickups += 1;
        if (candidate?.location === "floor") p1FloorPickups += 1;
        intent = p1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken });
      } else {
        intent = p1Intent(state, { direction: p1ToAmmoDirection(state, deliveries === 0) });
      }
    } else {
      intent = interaction.handles.includes("deliver")
        ? p1Intent(state, { handle: "deliver", slot: 0, route: "direct", part: "P1", contextToken: interaction.contextToken })
        : p1Intent(state, { direction: p1ToTurretDirection(state) });
    }

    state = stepBattle(state, intent);
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:load")) phase = "pickup";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      deliveryWasMade = true;
      phase = "pickup";
    }
    if (deliveryWasMade && distanceFromPlayerTurret(state) > 800) leftTurretAfterDelivery = true;

    for (const event of state.lastStep.events) {
      if (event.type === "object_moved" && event.location.kind === "carried" &&
          (event.location.actorId === "P2" || event.location.actorId === "P3")) alliedCarriedCases += 1;
    }
  }

  assert.ok(p1FloorPickups > 0, "P1 picks up a real floor case under the standard allocation");
  assert.ok(deliveries >= 4, `P1 completes repeated public deliveries after the command checks (got ${deliveries})`);
  assert.equal(selfHandoffPickups, 0, "an allied staged handoff is not exposed as an ordinary pickup");
  assert.equal(leftTurretAfterDelivery, true, "P1 can leave the turret after a public delivery");
  assert.ok(alliedCarriedCases > 0, "P2/P3 carry cases during the same standard run");
  assert.ok(state.castles.player.destroyedPartIds.length > 0, "enemy artillery interferes with the unprotected standard run");
});
