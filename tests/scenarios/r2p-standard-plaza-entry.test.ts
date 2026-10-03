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
const P1_AMMO_PICKUP_Y = 12_500;
const P1_TURRET_TRAVEL_Y = 12_000;
const P1_TURRET_APPROACH_X = 105_850;
const P1_EXIT_ROUTE_Y = 25_500;
const P1_EXIT_X = 123_500;

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

function p1ToAmmoDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  // Cases now spawn on walkable cells around the port. Approach the actual
  // floor case from above the equipment instead of walking into its body.
  const candidate = Object.values(state.battleCases)
    .filter(item => item.currentTeam === "player" && item.location === "floor" && item.roomId === "ammo_a")
    .sort((a, b) => a.createdTick - b.createdTick || a.id.localeCompare(b.id))[0];
  const target = candidate?.position ?? { x: P1_AMMO_APPROACH_X, y: P1_AMMO_PICKUP_Y };
  const sign = (value: number): -1 | 0 | 1 => value > 0 ? 1 : value < 0 ? -1 : 0;
  if (position.y > 25_500 && Math.abs(position.x - P1_AMMO_APPROACH_X) > 50)
    return { x: sign(P1_AMMO_APPROACH_X - position.x), y: 0 };
  if (Math.abs(position.x - target.x) > 50) {
    if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
    return { x: sign(target.x - position.x), y: 0 };
  }
  return { x: 0, y: sign(target.y - position.y) };
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

function p1ToPlazaDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  // A delayed siege impact can finish while P1 is collecting the next case.
  // Leave the ammo equipment via its clear upper edge before heading south.
  if (position.y < 20_000 && position.x < P1_AMMO_APPROACH_X - 50) {
    if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
    return { x: 1, y: 0 };
  }
  if (Math.abs(position.x - P1_EXIT_X) > 50) {
    if (Math.abs(position.y - P1_EXIT_ROUTE_Y) > 50) return { x: 0, y: sign(P1_EXIT_ROUTE_Y - position.y) };
    return { x: sign(P1_EXIT_X - position.x), y: 0 };
  }
  if (Math.abs(position.y - 35_500) > 50) return { x: 0, y: sign(35_500 - position.y) };
  return { x: 1, y: 0 };
}

test("標準配分の主人公P1は敵味方稼働下で広場へ到達する", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2p-standard-plaza-entry", seed: 20260913 });
  assert.deepEqual(state.logistics.playerAllocation, [
    "standard_slug", "standard_slug", "standard_slug",
    "dense_payload", "dense_payload", "screen_panel", "screen_panel", "fast_dart",
  ]);
  for (const actorId of ["P1", "P2", "P3", "E25", "E26", "E27"] as const) {
    assert.equal(state.actors[actorId].protectedUntilTick, null, `${actorId} starts without test protection`);
  }

  let phase: "pickup" | "turret" | "plaza" = "pickup";
  let deliveries = 0;
  let floorPickups = 0;
  let reachedPlazaAt: number | undefined;

  for (let tick = 0; tick < 2_200 && state.phase === "running"; tick += 1) {
    if (!state.actors.P1.alive) {
      state = stepBattle(state);
      continue;
    }

    let intent = publicP1Intent(state, { direction: NEUTRAL });
    if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      if (interaction.handles.includes("pickup")) {

        intent = publicP1Intent(state, { handle: "pickup", slot: Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)), contextToken: interaction.contextToken });
      } else {
        intent = publicP1Intent(state, { direction: p1ToAmmoDirection(state) });
      }
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      intent = interaction.handles.includes("deliver")
        ? publicP1Intent(state, { handle: "deliver", slot: Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)), route: "direct", part: "P1", contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToTurretDirection(state) });
    } else {
      intent = publicP1Intent(state, { direction: p1ToPlazaDirection(state) });
    }

    const beforePickup = state;
    state = stepBattle(state, intent);
    floorPickups += state.actors.P1.cargoIds.filter(id => !beforePickup.actors.P1.cargoIds.includes(id) && beforePickup.battleCases[id]?.location === "floor").length;
    if (phase === "pickup" && state.actors.P1.cargoIds.length > 0) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = "plaza";
    }
    if (state.actors.P1.location.area === "plaza") {
      reachedPlazaAt = state.tick;
      break;
    }
  }

  assert.ok(floorPickups >= 1, "P1 automatically acquires real floor cases from the standard initial layout");
  assert.equal(deliveries, 1, "P1 uses one ordinary delivery before leaving the home castle");
  assert.ok(reachedPlazaAt !== undefined, `P1 reaches the plaza through public movement (tick=${state.tick}, phase=${phase}, area=${state.actors.P1.location.area}, outcome=${state.outcome})`);
  assert.equal(state.actors.P1.alive, true, "P1 is alive on the first plaza arrival");
  assert.equal(state.actors.P1.location.area, "plaza");
  assert.equal(state.lastStep.acceptedInputKinds.includes("bridge:plaza_entry"), false);
  assert.equal(state.plaza.enemyCrossings["P1:0"]?.allowed, undefined);
  assert.deepEqual(state.plaza.guardDeployments.enemy?.guardGenerations, { E25: 0, E26: 0, E27: 0 });
});
