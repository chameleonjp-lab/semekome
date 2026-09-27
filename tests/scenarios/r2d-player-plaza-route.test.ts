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
const ENEMY_PART_IDS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7"] as const;
const PLAYER_SIEGE_ALLOCATION = [
  "dense_payload", "dense_payload", "dense_payload",
  "breach_lance", "breach_lance", "breach_lance",
  "standard_slug", "fast_dart",
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
  if (Math.abs(position.x - P1_EXIT_X) > 50) {
    if (Math.abs(position.y - P1_EXIT_ROUTE_Y) > 50) return { x: 0, y: sign(P1_EXIT_ROUTE_Y - position.y) };
    return { x: sign(P1_EXIT_X - position.x), y: 0 };
  }
  if (Math.abs(position.y - PLAZA_Y) > 50) return { x: 0, y: sign(PLAZA_Y - position.y) };
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

function nextEnemyPart(state: BattleState): (typeof ENEMY_PART_IDS)[number] | undefined {
  return ENEMY_PART_IDS.find((partId) => !state.castles.enemy.exterior[partId].destroyed);
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

test("主人公の公開砲撃でG1を開けても次のG2で止まる", { timeout: 60_000 }, () => {
  let state = createBattle({ matchId: "r2g-player-gate-opening", seed: 20260913 });
  registerPlazaGuardDispatch(state, "enemy", "E25");
  // Keep the opening test focused on the player-authored supply and gate
  // boundary. Enemy actors cannot launch or interrupt the route fixture.
  for (const actor of Object.values(state.actors)) {
    if (actor.team === "enemy") actor.protectedUntilTick = 99_999;
  }

  let phase: "pickup" | "turret" | "await-gate" | "plaza-route" = "pickup";
  let deliveries = 0;
  let reachedPlaza = false;
  let gateOpened = false;
  const playerLaunchTargets: string[] = [];

  for (let tick = 0; tick < 12_000 && state.phase === "running"; tick += 1) {
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
    }

    state = stepBattle(state, intent);
    for (const event of state.lastStep.events) {
      if (event.type === "projectile_launched" && event.team === "player") playerLaunchTargets.push(event.targetPart ?? "none");
    }
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = deliveries < 4 ? "pickup" : "await-gate";
    }
    if (phase === "await-gate" && state.castles.enemy.openGateIds.includes("G1")) {
      gateOpened = true;
      phase = "plaza-route";
    }
    if (state.actors.P1.location.area === "plaza") {
      reachedPlaza = true;
      break;
    }
  }

  assert.equal(deliveries, 4, "P1 uses four ordinary public deliveries to feed the gate-opening artillery");
  assert.equal(gateOpened, true, "player artillery destroys the first enemy exterior part and opens G1");
  assert.ok(playerLaunchTargets.includes("P1"), "a player-launched case keeps the selected enemy part");
  assert.deepEqual(state.castles.enemy.destroyedPartIds, ["P1"]);
  assert.deepEqual(state.castles.enemy.openGateIds, ["G1"]);
  assert.equal(reachedPlaza, true, `P1 reaches the plaza after the public artillery boundary is open (tick=${state.tick}, phase=${phase}, area=${state.actors.P1.location.area}, room=${state.actors.P1.currentRoomId}, position=${JSON.stringify(state.fixedActors.P1.position)}, outcome=${state.outcome})`);

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
    assert.equal(state.actors[actorId].alive, false, `${actorId} is defeated before the opened-gate crossing`);
  }

  let enteredEnemyCastle = false;
  for (let tick = 0; tick < 600 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
    if (state.actors.P1.location.area === "castle") {
      enteredEnemyCastle = true;
      break;
    }
  }

  assert.equal(enteredEnemyCastle, true, "held public direction crosses after the plaza guards are defeated");
  assert.equal(state.actors.P1.location.castleTeam, "enemy");
  assert.deepEqual(state.castles.enemy.openGateIds, ["G1"], "only the first gate is open at the crossing");

  for (let tick = 0; tick < 3_000 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
  }

  const stoppedPosition = state.fixedActors.P1.position;
  assert.equal(state.actors.P1.currentRoomId, "corridor_1", "P1 crosses G1 and reaches the second closed-gate approach");
  assert.deepEqual(state.actors.P1.location.pathRooms, ["central_corridor", "respawn", "corridor_0", "corridor_1"]);
  assert.deepEqual(state.actors.P1.location.pathGates, ["G1"], "the physical route records only the opened G1");
  assert.deepEqual(state.castles.enemy.openGateIds, ["G1"]);
  assert.deepEqual(state.castles.enemy.destroyedPartIds, ["P1"]);

  for (let tick = 0; tick < 120 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
  }
  assert.deepEqual(state.fixedActors.P1.position, stoppedPosition, "held public direction stays blocked by closed G2");
  assert.equal(state.actors.P1.currentRoomId, "corridor_1");
  assert.equal(state.lastStep.acceptedInputKinds.includes("direction"), true, "the blocked movement still comes from public direction input");
});

test("主人公の公開操作で7部位・7門を通り核へ有効な突進を当てる", { timeout: 180_000 }, () => {
  let state = createBattle({
    matchId: "r2j-player-seven-gates-core",
    seed: 20260913,
    playerSupplyAllocation: PLAYER_SIEGE_ALLOCATION,
  });
  registerPlazaGuardDispatch(state, "enemy", "E25");
  // This is a player-route fixture. Keep every non-player combatant from
  // changing the route while still using real supply, artillery, guard
  // contact, gate collision, and core contact validators.
  for (const actor of Object.values(state.actors)) {
    if (actor.id !== "P1") actor.protectedUntilTick = 99_999;
  }

  let phase: "pickup" | "turret" | "plaza-route" = "pickup";
  let deliveries = 0;
  let reachedPlaza = false;
  let enteredEnemyCastle = false;

  for (let tick = 0; tick < 24_000 && state.phase === "running"; tick += 1) {
    let intent = publicP1Intent(state, { direction: NEUTRAL });
    if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", 0);
      intent = interaction.handles.includes("pickup")
        ? publicP1Intent(state, { handle: "pickup", slot: 0, contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToAmmoDirection(state, deliveries === 0) });
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", 0);
      const targetPart = nextEnemyPart(state);
      intent = interaction.handles.includes("deliver") && targetPart
        ? publicP1Intent(state, { handle: "deliver", slot: 0, route: "direct", part: targetPart, contextToken: interaction.contextToken })
        : publicP1Intent(state, { direction: p1ToTurretDirection(state) });
    } else {
      intent = publicP1Intent(state, { direction: p1ToPlazaDirection(state) });
    }

    state = stepBattle(state, intent);
    if (state.lastStep.acceptedInputKinds.includes("handle:pickup")) phase = "turret";
    if (state.lastStep.acceptedInputKinds.includes("handle:deliver")) {
      deliveries += 1;
      phase = "pickup";
    }
    if (state.castles.enemy.destroyedPartIds.length === ENEMY_PART_IDS.length) {
      phase = "plaza-route";
      break;
    }
  }

  assert.ok(deliveries >= 12, `P1 made repeated public deliveries before the siege route (got ${deliveries})`);
  assert.deepEqual(state.castles.enemy.destroyedPartIds, [...ENEMY_PART_IDS], "all seven exterior parts are destroyed independently");
  assert.deepEqual(state.castles.enemy.openGateIds, [...ENEMY_PART_IDS.map((_, index) => `G${index + 1}`)], "all seven prefix gates open");
  assert.equal(state.outcome, "ongoing", "destroying all exterior parts does not end the battle");

  for (let tick = 0; tick < 4_000 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, publicP1Intent(state, { direction: p1ToPlazaDirection(state) }));
    if (state.actors.P1.location.area === "plaza") {
      reachedPlaza = true;
      break;
    }
  }
  assert.equal(reachedPlaza, true, "P1 leaves the home castle through the public movement input");

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
    while (state.dashes.P1 && state.phase === "running") {
      holdPlazaGuardsInPlace(state);
      state = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
    }
    assert.equal(state.actors[actorId].alive, false, `${actorId} is defeated by a public dash contact`);
  }

  for (let tick = 0; tick < 1_000 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
    if (state.actors.P1.location.area === "castle") {
      enteredEnemyCastle = true;
      break;
    }
  }
  assert.equal(enteredEnemyCastle, true, "P1 crosses the plaza after the three dispatched guards are defeated");
  assert.equal(state.actors.P1.location.castleTeam, "enemy");

  for (let tick = 0; tick < 3_000 && state.phase === "running"; tick += 1) {
    state = stepBattle(state, publicP1Intent(state, { direction: { x: 1, y: 0 } }));
    if (state.actors.P1.currentRoomId === "core") break;
  }
  assert.equal(state.actors.P1.currentRoomId, "core", "P1 reaches the enemy core room through public movement");
  assert.deepEqual(state.actors.P1.location.pathGates, [...state.layout.enemy.coreRouteGates], "all seven physical gates are recorded in order");
  assert.deepEqual(state.castles.enemy.openGateIds, [...state.layout.enemy.coreRouteGates]);

  const corePoint = state.layout.enemy.rooms.find((room) => room.id === "core");
  assert.ok(corePoint, "enemy core room is authored");
  for (let tick = 0; tick < 500 && state.phase === "running"; tick += 1) {
    const coreCenter = {
      x: Math.round((corePoint!.rect.x0 + corePoint!.rect.x1) * 500),
      y: Math.round((corePoint!.rect.y0 + corePoint!.rect.y1) * 500),
    };
    const position = state.fixedActors.P1.position;
    const direction: BattleDirection = {
      x: sign(coreCenter.x - position.x),
      y: sign(coreCenter.y - position.y),
    };
    if (state.dashes.P1) {
      state = stepBattle(state, publicP1Intent(state, { direction: NEUTRAL }));
    } else if (Math.abs(coreCenter.x - position.x) <= state.rules.dashDistanceSubunits) {
      state = stepBattle(state, publicP1Intent(state, { dash: { x: 1, y: 0 } }));
    } else {
      state = stepBattle(state, publicP1Intent(state, { direction }));
    }
  }

  assert.equal(state.castles.enemy.core.hit, true, "the core changes only after a real public dash contact");
  assert.equal(state.outcome, "player_win");
  assert.equal(state.phase, "ended");
  assert.equal(state.lastStep.events.filter((event) => event.type === "outcome").length, 1, "the terminal outcome is emitted once");

  const afterEnd = stepBattle(state, publicP1Intent(state, { direction: { x: -1, y: 0 } }));
  assert.equal(afterEnd.tick, state.tick, "ended battles do not advance from later public input");
  assert.deepEqual(afterEnd.castles, state.castles);
});
