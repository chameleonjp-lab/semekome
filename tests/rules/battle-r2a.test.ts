import assert from "node:assert/strict";
import test from "node:test";
import {
  createBattle,
  getInteraction,
  pauseBattle,
  resumeBattle,
  setBattleVisibility,
  stepBattle,
} from "../../src/simulation/battle.ts";
import type { WorldEvent } from "../../src/domain/types.ts";

test("R2a exposes all 33 actors on fixed cell-centre coordinates and rejects public actor/id generations", () => {
  const state = createBattle({ matchId: "r2a-actors", seed: 7 });
  assert.equal(Object.keys(state.actors).length, 33);
  assert.deepEqual(state.fixedActors.P1.position, { x: 92_500, y: 33_500 });
  const wrongMatch = stepBattle(state, { matchId: "old", actorId: "P1", generation: 0, direction: { x: 1, y: 0 } });
  assert.equal(wrongMatch.lastStep.rejected[0]?.reason, "wrong_match");
  const stale = stepBattle(state, { matchId: "r2a-actors", actorId: "P1", generation: 1, direction: { x: 1, y: 0 } });
  assert.equal(stale.lastStep.rejected[0]?.reason, "stale_generation");
  const enemyInput = stepBattle(state, { matchId: "r2a-actors", actorId: "E01", generation: 0, direction: { x: 1, y: 0 } });
  assert.equal(enemyInput.lastStep.rejected[0]?.reason, "unknown_actor");
  const neutral = stepBattle(state, { matchId: "r2a-actors", actorId: "P1", generation: 0, direction: { x: 0, y: 0 } });
  assert.equal(neutral.lastStep.rejected.length, 0);
  assert.deepEqual(neutral.fixedActors.P1.position, state.fixedActors.P1.position);
});

test("hidden/paused battle stays stopped until explicit resume, and ended state cannot be resumed", () => {
  let state = createBattle({ matchId: "r2a-pause", seed: 8 });
  state = pauseBattle(state);
  const pausedTick = state.tick;
  state = stepBattle(state);
  assert.equal(state.tick, pausedTick);
  state = resumeBattle(state);
  assert.equal(state.tick, pausedTick);
  state = stepBattle(state);
  assert.equal(state.tick, pausedTick + 1);
  state = setBattleVisibility(state, false);
  state = stepBattle(state);
  assert.equal(state.tick, pausedTick + 1);
  state = setBattleVisibility(state, true);
  assert.equal(state.phase, "paused");
  state = resumeBattle(state);
  state = stepBattle(state);
  assert.equal(state.tick, pausedTick + 2);
  state.matchLimitTicks = state.tick + 1;
  state = stepBattle(state);
  assert.equal(state.phase, "ended");
  assert.equal(resumeBattle(state).phase, "ended");
  assert.equal(pauseBattle(state).phase, "ended");
});

test("enemy AI walks cases through handoff and shooter pickup into a queue before automatic launch", () => {
  let state = createBattle({ matchId: "r2a-ai", seed: 11 });
  const movementEvents: Array<{ tick: number; id: string; kind: string; actorId?: string }> = [];
  let launchTick: number | undefined;
  for (let index = 0; index < 850; index += 1) {
    state = stepBattle(state);
    for (const event of state.lastStep.events) {
      if (event.type === "object_moved" && event.objectId.startsWith("case-enemy")) {
        movementEvents.push({ tick: state.tick, id: event.objectId, kind: event.location.kind, actorId: "actorId" in event.location ? String(event.location.actorId) : undefined });
      }
      if (event.type === "projectile_launched" && event.team === "enemy") launchTick = state.tick;
    }
    if (launchTick !== undefined) break;
  }
  assert.ok(launchTick !== undefined, "an AI-owned case must reach an automatic launch");
  const firstCase = movementEvents.find((entry) => entry.kind === "carried");
  assert.ok(firstCase);
  assert.ok(movementEvents.some((entry) => entry.id === firstCase!.id && entry.kind === "queue"));
  assert.ok(state.eventLog.length <= state.eventLogLimit);
  const activeFlights = Object.values(state.artillery.flights);
  assert.ok(activeFlights.some((flight) => flight.team === "enemy" && flight.progress === 0), "new flight does not move during launch tick");
});

test("candidate token rejects an old handling press instead of selecting a replacement case", () => {
  let state = createBattle({ matchId: "r2a-token", seed: 13 });
  for (let index = 0; index < 31; index += 1) state = stepBattle(state);
  const source = Object.values(state.battleCases).find((item) => item.currentTeam === "player" && item.location === "floor");
  assert.ok(source?.position);
  state.fixedActors.P1.position = { ...source!.position! };
  state.actors.P1.position = { x: Math.floor(source!.position!.x / 1000), y: Math.floor(source!.position!.y / 1000) };
  const interaction = getInteraction(state);
  assert.ok(interaction.cases.length > 0);
  state = stepBattle(state);
  const rejected = stepBattle(state, {
    matchId: "r2a-token",
    actorId: "P1",
    generation: state.actors.P1.generation,
    handle: "pickup",
    slot: 0,
    contextToken: interaction.contextToken,
  });
  assert.equal(rejected.lastStep.rejected[0]?.reason, "invalid_object_transition");
  assert.equal(Object.values(rejected.actors.P1.cargoIds).length, 0);
});

test("same seeded battle produces equal supply and artillery state", () => {
  let left = createBattle({ matchId: "r2a-determinism", seed: 99 });
  let right = createBattle({ matchId: "r2a-determinism", seed: 99 });
  for (let index = 0; index < 480; index += 1) {
    left = stepBattle(left);
    right = stepBattle(right);
  }
  assert.deepEqual(left.logistics, right.logistics);
  assert.deepEqual(left.battleCases, right.battleCases);
  assert.deepEqual(left.artillery, right.artillery);
});

test("each source vehicle consumes one shared seeded bag in port order and keeps floor positions unique", () => {
  const state = createBattle({ matchId: "r2a-shared-bag", seed: 41 });
  const initialBag = [...state.logistics.bags.enemy];
  for (const port of Object.values(state.logistics.ports)) port.nextSpawnTick = 0;
  const next = stepBattle(state);
  const spawned = next.lastStep.events.filter((entry): entry is Extract<WorldEvent, { type: "case_spawned" }> => entry.type === "case_spawned" && entry.team === "enemy");
  assert.deepEqual(spawned.map((entry) => entry.portId), ["supply_1", "supply_2", "supply_3", "supply_4"]);
  assert.deepEqual(spawned.map((entry) => entry.caseType), initialBag.slice(0, 4));
  assert.equal(next.logistics.bagIndices.enemy, 4);
  const positions = Object.values(next.battleCases)
    .filter((entry) => entry.currentTeam === "enemy" && entry.location === "floor")
    .map((entry) => `${entry.roomId}:${entry.position?.x},${entry.position?.y}`);
  assert.equal(new Set(positions).size, positions.length);
});

test("handling is latched from the tick-start snapshot and rejects unknown runtime semantics", () => {
  let state = createBattle({ matchId: "r2a-boundary", seed: 43 });
  for (const port of Object.values(state.logistics.ports)) if (port.team === "player") port.nextSpawnTick = 0;
  state = stepBattle(state);
  const source = Object.values(state.battleCases).find((item) => item.currentTeam === "player" && item.location === "floor");
  assert.ok(source?.position);
  state.fixedActors.P1.position = { ...source!.position! };
  state.actors.P1.position = { x: Math.floor(source!.position!.x / 1000), y: Math.floor(source!.position!.y / 1000) };
  const interaction = getInteraction(state, "P1", 0);
  const movedAndPicked = stepBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    direction: { x: 1, y: 0 },
    handle: "pickup",
    slot: 0,
    contextToken: interaction.contextToken,
  });
  assert.deepEqual(movedAndPicked.cargoSlots.P1[0], source!.id);

  const malformed = (handle: string, route?: string, part?: string) => stepBattle(movedAndPicked, {
    matchId: state.matchId,
    actorId: "P1",
    generation: movedAndPicked.actors.P1.generation,
    handle,
    route,
    part,
    slot: 0,
    contextToken: getInteraction(movedAndPicked, "P1", 0).contextToken,
  } as unknown as Parameters<typeof stepBattle>[1]);
  assert.equal(malformed("not-a-handle").lastStep.rejected[0]?.reason, "invalid_transition");
  assert.equal(malformed("pickup", "not-a-route").lastStep.rejected[0]?.reason, "invalid_transition");
  assert.equal(malformed("pickup", undefined, "P9").lastStep.rejected[0]?.reason, "invalid_transition");
});

test("empty cargo slots do not expose drop or deliver and never compact a later slot", () => {
  let state = createBattle({ matchId: "r2a-slots", seed: 47 });
  for (const port of Object.values(state.logistics.ports)) if (port.team === "player") port.nextSpawnTick = 0;
  state = stepBattle(state);
  const source = Object.values(state.battleCases).find((item) => item.currentTeam === "player" && item.location === "floor");
  assert.ok(source?.position);
  state.fixedActors.P1.position = { ...source!.position! };
  const interaction = getInteraction(state, "P1", 0);
  state = stepBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    handle: "pickup",
    slot: 0,
    contextToken: interaction.contextToken,
  });
  assert.deepEqual(state.cargoSlots.P1, [source!.id, null]);
  assert.equal(getInteraction(state, "P1", 1).handles.includes("drop"), false);
  assert.equal(getInteraction(state, "P1", 1).handles.includes("deliver"), false);
  assert.equal(getInteraction(state, "P1", 0).handles.includes("drop"), true);
});

test("automatic loading skips a full first operator and hands off to P2 without spinning", () => {
  let state = createBattle({ matchId: "r2a-loader-capacity", seed: 49 });
  for (const port of Object.values(state.logistics.ports)) if (port.team === "player") port.nextSpawnTick = 0;
  state = stepBattle(state);
  const playerCases = Object.values(state.battleCases).filter((item) => item.currentTeam === "player");
  assert.ok(playerCases.length >= 3);
  const [first, second, handoff] = playerCases;
  const turret = state.artillery.turrets["player:T1"];
  assert.ok(turret);

  const placeAtTurret = (actorId: "P1" | "P2"): void => {
    state.fixedActors[actorId].position = { ...turret!.position };
    state.actors[actorId].position = { x: Math.floor(turret!.position.x / 1000), y: Math.floor(turret!.position.y / 1000) };
  };
  placeAtTurret("P1");
  placeAtTurret("P2");

  state.actors.P1.cargoIds = [first.id, second.id];
  state.cargoSlots.P1 = [first.id, second.id];
  for (const carried of [first, second]) {
    carried.location = "carried";
    carried.currentTeam = "player";
    carried.position = undefined;
    carried.currentPosition = { ...turret!.position };
    carried.ownerActorId = "P1";
    carried.ownerGeneration = state.actors.P1.generation;
    carried.turretId = undefined;
    carried.queueIndex = undefined;
    carried.flightId = undefined;
  }
  handoff.location = "handoff";
  handoff.currentTeam = "player";
  handoff.position = { ...turret!.position };
  handoff.currentPosition = { ...turret!.position };
  handoff.ownerActorId = undefined;
  handoff.ownerGeneration = undefined;
  handoff.turretId = turret!.id;
  handoff.queueIndex = undefined;
  handoff.flightId = undefined;
  turret!.handoffIds = [handoff.id];
  turret!.queueIds = [];
  state.artillery.nextLaunchTick.player = state.tick + 1000;
  state.nextLaunchTick.player = state.artillery.nextLaunchTick.player;

  const next = stepBattle(state);
  const nextTurret = next.artillery.turrets["player:T1"];
  assert.deepEqual(nextTurret.queueIds, [handoff.id]);
  assert.deepEqual(next.cargoSlots.P1, [first.id, second.id]);
  assert.deepEqual(next.cargoSlots.P2, [null, null]);
  assert.deepEqual(next.actors.P2.cargoIds, []);
});

test("gate event numbering follows newly destroyed prefix count, not part id order", () => {
  let state = createBattle({ matchId: "r2a-gates", seed: 53 });
  state.castles.enemy.exterior.P5.destroyed = true;
  state.castles.enemy.exterior.P5.health = 0;
  state = stepBattle(state);
  assert.equal(state.lastStep.events.find((entry) => entry.type === "part_destroyed")?.gateId, "G1");
  state.castles.enemy.exterior.P2.destroyed = true;
  state.castles.enemy.exterior.P2.health = 0;
  state = stepBattle(state);
  assert.equal(state.lastStep.events.find((entry) => entry.type === "part_destroyed")?.gateId, "G2");
});

test("opposing projectiles are intercepted when their swept paths cross between samples", () => {
  let state = createBattle({ matchId: "r2a-sweep", seed: 59 });
  const addFlight = (flightId: string, objectId: string, team: "player" | "enemy"): void => {
    const targetTeam = team === "player" ? "enemy" : "player";
    state.battleCases[objectId] = {
      id: objectId,
      type: "standard_slug",
      sourceTeam: team,
      currentTeam: team,
      weight: 1,
      location: "flying",
      currentPosition: undefined,
      originGroupId: `group-${objectId}`,
      sourcePortId: "supply_1",
      createdTick: -1,
      roomId: "battery_a",
      interceptRemaining: 1,
      flightId,
    };
    state.objects[objectId] = {
      id: objectId,
      sourceTeam: team,
      weight: 1,
      originGroupId: `group-${objectId}`,
      location: { kind: "flying", projectileId: flightId },
    };
    state.artillery.flights[flightId] = {
      id: flightId,
      objectId,
      team,
      sourceActorId: team === "player" ? "P1" : "E01",
      sourceGeneration: 0,
      targetTeam,
      route: "direct",
      progress: 0.45,
      previousProgress: 0.45,
      interceptRemaining: 1,
      createdTick: -1,
      distanceUnits: 100,
      speedUnitsPerSecond: 600,
    };
    state.projectiles[flightId] = {
      id: flightId,
      objectId,
      team,
      sourceActorId: team === "player" ? "P1" : "E01",
      sourceGeneration: 0,
      targetTeam,
    };
  };
  addFlight("flight-player", "case-player", "player");
  addFlight("flight-enemy", "case-enemy", "enemy");
  state = stepBattle(state);
  assert.equal(state.lastStep.events.some((entry) => entry.type === "projectile_intercepted"), true);
  assert.equal(Object.keys(state.artillery.flights).length, 0);
  assert.equal(Object.keys(state.artillery.contactPairs).length, 0);
});
