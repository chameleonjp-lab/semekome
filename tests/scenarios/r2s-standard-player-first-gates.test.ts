import assert from "node:assert/strict";
import test from "node:test";
import {
  createBattle,
  getInteraction,
  stepBattle,
  type BattleDirection,
  type BattleIntent,
  type BattleState,
} from "../../src/simulation/physical-battle.ts";

const NEUTRAL: BattleDirection = { x: 0, y: 0 };
const P1_AMMO_APPROACH_X = 94_500;
const P1_AMMO_PICKUP_Y = 13_500;
const P1_TURRET_TRAVEL_Y = 12_000;
const P1_TURRET_APPROACH_X = 105_850;
const STANDARD_ALLOCATION = [
  "standard_slug", "standard_slug", "standard_slug",
  "dense_payload", "dense_payload", "screen_panel", "screen_panel", "fast_dart",
] as const;

function publicP1Intent(state: BattleState, partial: Partial<BattleIntent> = {}): BattleIntent {
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
    if (Math.abs(position.x - P1_AMMO_APPROACH_X) > 50) {
      return { x: sign(P1_AMMO_APPROACH_X - position.x), y: 0 };
    }
    if (Math.abs(position.y - P1_AMMO_PICKUP_Y) > 50) {
      return { x: 0, y: sign(P1_AMMO_PICKUP_Y - position.y) };
    }
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

test("標準配分の公開砲撃は敵砲撃干渉下でもP1対象を保持する", { timeout: 120_000 }, () => {
  let state = createBattle({ matchId: "r2s-standard-player-siege-target", seed: 20260913 });
  assert.deepEqual(
    state.logistics.playerAllocation,
    STANDARD_ALLOCATION,
    "the route uses the production standard player allocation",
  );
  for (const actorId of ["P1", "P2", "P3"] as const) {
    assert.equal(state.actors[actorId].protectedUntilTick, null, actorId + " starts without test protection");
  }

  let phase: "pickup" | "turret" = "pickup";
  let deliveries = 0;
  let p1FloorPickups = 0;
  let alliedCarriedCases = 0;
  let selfHandoffPickups = 0;
  let deliveryWasMade = false;
  let leftTurretAfterDelivery = false;
  let playerLaunches = 0;
  let playerDetourP1Launches = 0;
  let playerImpacts = 0;
  let enemyInterferenceDamage = 0;

  for (let tick = 0; tick < 4_200 && state.phase === "running"; tick += 1) {
    if (!state.actors.P1.alive) {
      state = stepBattle(state);
      continue;
    }

    const interaction = getInteraction(state, "P1", 0);
    let intent: BattleIntent;
    if (phase === "pickup") {
      // The public HUD prioritizes load over pickup when a handoff is available.
      if (interaction.handles.includes("load")) {
        intent = publicP1Intent(state, { handle: "load", slot: 0, contextToken: interaction.contextToken });
      } else if (interaction.handles.includes("pickup")) {
        const candidate = interaction.pickupCaseId ? state.battleCases[interaction.pickupCaseId] : undefined;
        if (candidate?.location === "handoff" && candidate.currentTeam === "player") selfHandoffPickups += 1;
        if (candidate?.location === "floor") p1FloorPickups += 1;
        intent = publicP1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken });
      } else {
        intent = publicP1Intent(state, { direction: p1ToAmmoDirection(state, deliveries === 0) });
      }
    } else {
      intent = interaction.handles.includes("deliver")
        ? publicP1Intent(state, {
          handle: "deliver",
          slot: 0,
          route: "detour",
          part: "P1",
          contextToken: interaction.contextToken,
        })
        : publicP1Intent(state, { direction: p1ToTurretDirection(state) });
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
      if (event.type === "projectile_launched" && event.team === "player") {
        playerLaunches += 1;
        if (event.route === "detour" && event.targetPart === "P1") playerDetourP1Launches += 1;
      }
      if (event.type === "projectile_impacted" && event.targetTeam === "enemy") playerImpacts += 1;
      if (event.type === "part_damaged" && event.team === "player") enemyInterferenceDamage += event.amount;
      if (event.type === "object_moved" && event.location.kind === "carried" &&
          (event.location.actorId === "P2" || event.location.actorId === "P3")) {
        alliedCarriedCases += 1;
      }
    }
  }

  assert.equal(
    state.phase,
    "running",
    "the bounded target-selection run stays active (tick=" + state.tick +
      ", outcome=" + state.outcome + ", deliveries=" + deliveries +
      ", playerLaunches=" + playerLaunches + ", playerImpacts=" + playerImpacts +
      ", enemyInterferenceDamage=" + enemyInterferenceDamage + ")",
  );
  assert.ok(p1FloorPickups > 0, "P1 picks up a real floor case under the standard allocation");
  assert.ok(deliveries >= 4, "P1 completes repeated public deliveries during the bounded run");
  assert.equal(selfHandoffPickups, 0, "an allied staged handoff is not exposed as an ordinary pickup");
  assert.equal(leftTurretAfterDelivery, true, "P1 can leave the turret after a public delivery");
  assert.ok(alliedCarriedCases > 0, "P2/P3 carry cases during the same standard run");
  assert.ok(playerLaunches > 0, "the player side launches projectiles during the bounded run");
  assert.ok(playerDetourP1Launches > 0, "a public delivery captures the detour route and P1 target");
  assert.ok(playerImpacts > 0, "at least one player projectile reaches the enemy-side impact boundary");
  assert.ok(enemyInterferenceDamage > 0, "enemy artillery damages the unprotected player side");
  assert.equal(
    state.castles.enemy.openGateIds.length,
    state.castles.enemy.destroyedPartIds.length,
    "no gate opens without the corresponding destroyed exterior prefix",
  );
});
