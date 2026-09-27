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
import { floorCell } from "../../src/actors/movement.ts";
import { registerPlazaGuardDispatch } from "../../src/simulation/plaza-guards.ts";

const NEUTRAL: BattleDirection = { x: 0, y: 0 };
const PLAZA_Y = 35_500;
const P1_AMMO_APPROACH_X = 94_500;
const P1_AMMO_PICKUP_Y = 13_500;
const P1_TURRET_TRAVEL_Y = 12_000;
const P1_TURRET_APPROACH_X = 105_850;
const P1_EXIT_ROUTE_Y = 25_500;
const P1_EXIT_X = 123_500;
const PLAZA_GUARD_IDS = ["E25", "E26", "E27"] as const;

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

function p1ToAmmoDirection(state: BattleState, firstDelivery: boolean): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (firstDelivery) {
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

/** Leave turret A through the authored lower passage, then approach the exit. */
function p1ToPlazaDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (position.x !== P1_EXIT_X) {
    if (position.y !== P1_EXIT_ROUTE_Y) return { x: 0, y: sign(P1_EXIT_ROUTE_Y - position.y) };
    return { x: sign(P1_EXIT_X - position.x), y: 0 };
  }
  if (position.y !== PLAZA_Y) return { x: 0, y: sign(PLAZA_Y - position.y) };
  return { x: 1, y: 0 };
}

function placePlazaGuard(state: BattleState, actorId: (typeof PLAZA_GUARD_IDS)[number], position: { x: number; y: number }): void {
  const actor = state.actors[actorId];
  actor.location = { area: "plaza", pathRooms: [], pathGates: [] };
  actor.currentRoomId = "plaza";
  actor.position = { x: floorCell(position.x), y: floorCell(position.y) };
  // This unit checks public dash/contact and the crossing contract; damage
  // balance and repeated contacts remain outside this fixed battle fixture.
  actor.health = state.rules.dashActorDamage;
  actor.alive = true;
  actor.protectedUntilTick = null;
  actor.damageImmuneUntilTick = null;
  actor.respawnAtTick = null;
  state.fixedActors[actorId] = { position: { ...position }, remainder: { x: 0, y: 0 } };
}

function holdPlazaGuardsInPlace(state: BattleState): void {
  for (const actorId of PLAZA_GUARD_IDS) {
    if (state.actors[actorId].alive) state.actors[actorId].protectedUntilTick = state.tick + 1;
  }
}

test("主人公の公開入力は補給・砲台から広場へ進み、警備を無視した敵城侵入を止める", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2d-player-plaza-route", seed: 20260913 });
  // Keep the route assertion deterministic: the real guard roster is
  // dispatched and remains live, while spawn protection holds enemy combat
  // movement so the test can reach the opposing edge with public input.
  registerPlazaGuardDispatch(state, "enemy", "E25");
  for (const actor of Object.values(state.actors)) {
    if (actor.team === "enemy") actor.protectedUntilTick = 99_999;
  }
  let phase: "pickup" | "turret" | "plaza-route" | "plaza-cross" = "pickup";
  let deliveries = 0;
  let reachedPlaza = false;
  let attemptedOpposingEntry = false;

  for (let tick = 0; tick < 6_000 && state.phase === "running"; tick += 1) {
    let intent = publicP1Intent(state, { direction: NEUTRAL });
    if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", 0);
      intent = interaction.handles.includes("pickup")
        ? publicP1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToAmmoDirection(state, deliveries === 0) });
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", 0);
      intent = interaction.handles.includes("deliver")
        ? publicP1Intent(state, { handle: "deliver", slot: 0, route: "direct", part: "P1", contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToTurretDirection(state) });
    } else if (phase === "plaza-route") {
      intent = publicP1Intent(state, { direction: p1ToPlazaDirection(state) });
    } else {
      // The edge attempt is still an ordinary held direction. There is no
      // bridge, placement, or direct crossing input in this scenario.
      intent = publicP1Intent(state, { direction: { x: 1, y: 0 } });
    }

    state = stepBattle(state, intent);
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = "plaza-route";
    }
    if (state.actors.P1.location.area === "plaza") {
      reachedPlaza = true;
      phase = "plaza-cross";
    }
    if (reachedPlaza && state.fixedActors.P1.position.x >= 125_500) {
      attemptedOpposingEntry = true;
      break;
    }
  }

  assert.equal(deliveries, 1, "the route uses one normal P1 delivery before leaving the home castle");
  assert.equal(reachedPlaza, true, `P1 reaches the plaza through fixed-point movement (tick=${state.tick}, phase=${phase}, outcome=${state.outcome}, area=${state.actors.P1.location.area}, room=${state.actors.P1.currentRoomId}, position=${JSON.stringify(state.fixedActors.P1.position)})`);
  assert.equal(attemptedOpposingEntry, true, "P1 reaches the opposing-side plaza boundary with a held direction");
  assert.equal(state.actors.P1.location.area, "plaza", "live plaza guards block the opposing castle entry");
  assert.deepEqual(state.plaza.guardDeployments.enemy?.guardGenerations, { E25: 0, E26: 0, E27: 0 });
  assert.equal(state.plaza.enemyCrossings["P1:0"]?.allowed, undefined);
  assert.equal(state.lastStep.acceptedInputKinds.includes("bridge:plaza_entry"), false);
  assert.ok(Object.entries(state.plaza.guardDeployments.enemy?.guardGenerations ?? {}).some(([id, generation]) => {
    const guard = state.actors[id];
    return guard?.alive === true && guard.generation === generation;
  }), "at least one live dispatched guard generation remains as the physical crossing blocker");
});

test("主人公の公開突進で広場警備を全員撃破すると敵城側へ進める", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2d-player-plaza-breakthrough", seed: 20260913 });
  registerPlazaGuardDispatch(state, "enemy", "E25");
  // The fixture isolates the player-authored plaza battle and crossing. Enemy
  // actors outside the three dispatched guards cannot move into the route.
  for (const actor of Object.values(state.actors)) {
    if (actor.team === "enemy") actor.protectedUntilTick = 99_999;
  }

  let phase: "pickup" | "turret" | "plaza-route" = "pickup";
  let deliveries = 0;
  let reachedPlaza = false;
  for (let tick = 0; tick < 6_000 && state.phase === "running"; tick += 1) {
    let intent = publicP1Intent(state, { direction: NEUTRAL });
    if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", 0);
      intent = interaction.handles.includes("pickup")
        ? publicP1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToAmmoDirection(state, deliveries === 0) });
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", 0);
      intent = interaction.handles.includes("deliver")
        ? publicP1Intent(state, { handle: "deliver", slot: 0, route: "direct", part: "P1", contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToTurretDirection(state) });
    } else {
      intent = publicP1Intent(state, { direction: p1ToPlazaDirection(state) });
    }

    state = stepBattle(state, intent);
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = "plaza-route";
    }
    if (state.actors.P1.location.area === "plaza") {
      reachedPlaza = true;
      break;
    }
  }

  assert.equal(deliveries, 1);
  assert.equal(reachedPlaza, true, "P1 reaches the plaza through the same public route as the boundary test");

  const entry = state.fixedActors.P1.position;
  const guardPositions = [
    { x: entry.x + 75_000, y: entry.y },
    { x: entry.x + 95_000, y: entry.y },
    { x: entry.x + 110_000, y: entry.y },
  ];
  PLAZA_GUARD_IDS.forEach((actorId, index) => placePlazaGuard(state, actorId, guardPositions[index]));

  for (const actorId of PLAZA_GUARD_IDS) {
    while (state.actors[actorId].alive && state.fixedActors.P1.position.x < state.fixedActors[actorId].position.x - 650) {
      holdPlazaGuardsInPlace(state);
      state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
    }

    // Only the target is actionable on the dash tick; the other guards remain
    // in a deterministic fixture position until their own public dash.
    holdPlazaGuardsInPlace(state);
    state.actors[actorId].protectedUntilTick = null;
    state = stepBattle(state, publicP1Intent(state, { dash: { x: 1, y: 0 } }));
    while (state.dashes.P1) {
      holdPlazaGuardsInPlace(state);
      state = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
    }

    assert.equal(state.actors[actorId].alive, false, `${actorId} is defeated by a public dash contact`);
    assert.equal(state.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), true);
  }

  assert.deepEqual(
    PLAZA_GUARD_IDS.map((actorId) => state.actors[actorId].alive),
    [false, false, false],
    "all dispatched plaza guards are defeated before the crossing attempt",
  );

  let enteredEnemyCastle = false;
  for (let tick = 0; tick < 600 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
    if (state.actors.P1.location.area === "castle") {
      enteredEnemyCastle = true;
      break;
    }
  }

  assert.equal(enteredEnemyCastle, true, "held public direction crosses after every dispatched guard is defeated");
  assert.equal(state.actors.P1.location.castleTeam, "enemy");
  assert.equal(state.plaza.enemyCrossings["P1:0"]?.allowed, true);
  assert.equal(state.lastStep.acceptedInputKinds.includes("direction"), true, "the crossing uses the held public direction");
});

test("主人公は敵城へ越境後も閉門前で止まり核側へ抜けない", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2f-player-gate-boundary", seed: 20260913 });
  registerPlazaGuardDispatch(state, "enemy", "E25");
  // This fixture isolates the post-crossing gate boundary. Enemy actors other
  // than the three dispatched guards cannot interrupt the public route.
  for (const actor of Object.values(state.actors)) {
    if (actor.team === "enemy") actor.protectedUntilTick = 99_999;
  }

  let phase: "pickup" | "turret" | "plaza-route" = "pickup";
  let deliveries = 0;
  let reachedPlaza = false;
  for (let tick = 0; tick < 6_000 && state.phase === "running"; tick += 1) {
    let intent = publicP1Intent(state, { direction: NEUTRAL });
    if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", 0);
      intent = interaction.handles.includes("pickup")
        ? publicP1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToAmmoDirection(state, deliveries === 0) });
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", 0);
      intent = interaction.handles.includes("deliver")
        ? publicP1Intent(state, { handle: "deliver", slot: 0, route: "direct", part: "P1", contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToTurretDirection(state) });
    } else {
      intent = publicP1Intent(state, { direction: p1ToPlazaDirection(state) });
    }

    state = stepBattle(state, intent);
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = "plaza-route";
    }
    if (state.actors.P1.location.area === "plaza") {
      reachedPlaza = true;
      break;
    }
  }

  assert.equal(deliveries, 1);
  assert.equal(reachedPlaza, true, "P1 reaches the plaza through the public route");

  const entry = state.fixedActors.P1.position;
  const guardPositions = [
    { x: entry.x + 75_000, y: entry.y },
    { x: entry.x + 95_000, y: entry.y },
    { x: entry.x + 110_000, y: entry.y },
  ];
  PLAZA_GUARD_IDS.forEach((actorId, index) => placePlazaGuard(state, actorId, guardPositions[index]));

  for (const actorId of PLAZA_GUARD_IDS) {
    while (state.actors[actorId].alive && state.fixedActors.P1.position.x < state.fixedActors[actorId].position.x - 650) {
      holdPlazaGuardsInPlace(state);
      state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
    }
    holdPlazaGuardsInPlace(state);
    state.actors[actorId].protectedUntilTick = null;
    state = stepBattle(state, publicP1Intent(state, { dash: { x: 1, y: 0 } }));
    while (state.dashes.P1) {
      holdPlazaGuardsInPlace(state);
      state = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
    }
    assert.equal(state.actors[actorId].alive, false, `${actorId} is defeated before the gate check`);
  }

  let crossedIntoEnemyCastle = false;
  for (let tick = 0; tick < 600 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
    if (state.actors.P1.location.area === "castle") {
      crossedIntoEnemyCastle = true;
      break;
    }
  }

  assert.equal(crossedIntoEnemyCastle, true);
  assert.equal(state.actors.P1.location.castleTeam, "enemy");
  assert.deepEqual(state.castles.enemy.openGateIds, [], "the enemy castle starts with every gate closed");
  assert.deepEqual(state.actors.P1.location.pathGates, [], "crossing the plaza does not grant a gate passage");

  for (let tick = 0; tick < 3_000 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
  }

  const stoppedPosition = state.fixedActors.P1.position;
  assert.equal(state.actors.P1.currentRoomId, "corridor_0", "P1 reaches the first closed-gate approach");
  assert.deepEqual(state.actors.P1.location.pathRooms, ["central_corridor", "respawn", "corridor_0"]);
  assert.deepEqual(state.actors.P1.location.pathGates, [], "G1 remains uncrossed");
  assert.deepEqual(state.castles.enemy.openGateIds, [], "no gate opens from movement alone");
  assert.equal(state.castles.enemy.destroyedPartIds.length, 0, "no exterior part is destroyed by this boundary test");

  for (let tick = 0; tick < 120 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
  }
  assert.deepEqual(state.fixedActors.P1.position, stoppedPosition, "held public direction stays blocked by closed G1");
  assert.equal(state.actors.P1.currentRoomId, "corridor_0");
  assert.equal(state.lastStep.acceptedInputKinds.includes("direction"), true, "the blocked movement still comes from public direction input");
});
