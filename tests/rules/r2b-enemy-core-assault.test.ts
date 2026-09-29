import assert from "node:assert/strict";
import test from "node:test";
import { coreWorldPoint } from "../../src/actors/geometry.ts";
import { cellCenter, floorCell } from "../../src/actors/movement.ts";
import type { ActorId, TeamId } from "../../src/domain/types.ts";
import { chooseEnemyIntent, type EnemyObservation } from "../../src/simulation/enemy-rules.ts";
import { createBattle, stepBattle, type BattleState, type FixedPoint } from "../../src/simulation/physical-battle.ts";

type AssaulterId = "E29" | "E30";

function roomCenter(state: BattleState, team: TeamId, roomId: string): FixedPoint {
  const layout = team === "player" ? state.layout.home : state.layout.enemy;
  const room = layout.rooms.find((candidate) => candidate.id === roomId);
  assert.ok(room, `missing ${team} room ${roomId}`);
  return {
    x: cellCenter(Math.floor((room.rect.x0 + room.rect.x1 - 1) / 2)),
    y: cellCenter(Math.floor((room.rect.y0 + room.rect.y1 - 1) / 2)),
  };
}

function placeInRoom(state: BattleState, actorId: ActorId, team: TeamId, roomId: string): void {
  const point = roomCenter(state, team, roomId);
  const actor = state.actors[actorId];
  actor.location = { area: "castle", castleTeam: team, roomId, pathRooms: [roomId], pathGates: [] };
  actor.currentRoomId = roomId;
  actor.position = { x: floorCell(point.x), y: floorCell(point.y) };
  state.fixedActors[actorId] = { position: point, remainder: { x: 0, y: 0 } };
  state.crew.assignments[actorId] = { actorId, task: "idle", path: [], pathIndex: 0 };
  delete state.enemyDecisions[actorId];
}

function setPlayerCastleGateCount(state: BattleState, openCount: number): void {
  const castle = state.castles.player;
  for (const [index, part] of Object.values(castle.exterior).entries()) {
    part.destroyed = index < openCount;
    part.health = part.destroyed ? 0 : part.maxHealth;
  }
  castle.destroyedPartIds = Object.values(castle.exterior).filter((part) => part.destroyed).map((part) => part.id);
  castle.openGateIds = state.layout.home.coreRouteGates.slice(0, openCount);
  for (const gateId of state.layout.home.coreRouteGates) {
    castle.gates[gateId].open = castle.openGateIds.includes(gateId);
  }
}

function placeInvaderFixture(state: BattleState, actorId: AssaulterId): void {
  placeInRoom(state, actorId, "player", "central_corridor");
  // Keep local defence knowledge out of the route test; separate cases below
  // verify that the normal same-room threat and retreat priorities still win.
  placeInRoom(state, "P1", "player", "ammo_a");
  placeInRoom(state, "P2", "player", "battery_a");
  placeInRoom(state, "P3", "player", "battery_b");
  setPlayerCastleGateCount(state, 0);
}

function stepUntilRoom(state: BattleState, actorId: AssaulterId, roomId: string, maxTicks = 2_000): BattleState {
  let next = state;
  for (let index = 0; index < maxTicks && next.actors[actorId].currentRoomId !== roomId; index += 1) {
    const before = next.fixedActors[actorId].position;
    next = stepBattle(next);
    const after = next.fixedActors[actorId].position;
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y) <= 51,
      `${actorId} must walk in fixed steps, not warp`);
  }
  assert.equal(next.actors[actorId].currentRoomId, roomId, `${actorId} did not reach ${roomId}`);
  return next;
}

test("assault room observation preserves common role priority and has a legacy fallback", () => {
  const observation: EnemyObservation = {
    role: "internal_soldier",
    health: 4,
    homeRoomId: "command",
    currentRoomId: "core",
    inHomeCastle: false,
    threats: [],
    cargo: [],
    nearbyCases: [],
    canAssault: true,
    canGuardPlaza: false,
    assaultGoalRoomId: "core",
  };

  assert.deepEqual(chooseEnemyIntent(observation), { kind: "move_goal", roomId: "core", purpose: "assault" });
  const { assaultGoalRoomId: _goal, ...legacyObservation } = observation;
  assert.deepEqual(chooseEnemyIntent(legacyObservation), {
    kind: "move_goal", roomId: "central_corridor", purpose: "assault",
  });
  assert.deepEqual(chooseEnemyIntent({ ...observation, threats: ["P1"] }), {
    kind: "defend", targetId: "P1",
  });
  assert.deepEqual(chooseEnemyIntent({ ...observation, health: 2, threats: ["P1"] }), {
    kind: "retreat", awayFromId: "P1",
  });
});

test("主人公が敵陣にいるだけでは、侵入兵の進軍を停止しない", () => {
  let state = createBattle({ matchId: "enemy-assault-continues", seed: 1321 });
  placeInRoom(state, "E29", "player", "central_corridor");
  placeInRoom(state, "P1", "enemy", "central_corridor");
  placeInRoom(state, "P2", "player", "battery_a");
  placeInRoom(state, "P3", "player", "battery_b");
  const start = { ...state.fixedActors.E29.position };

  state = stepBattle(state);

  assert.deepEqual(state.enemyDecisions.E29.intent, {
    kind: "move_goal", roomId: "corridor_0", purpose: "assault",
  });
  assert.equal(state.crew.assignments.E29.task, "idle");
  assert.notDeepEqual(state.fixedActors.E29.position, start, "the assault uses fixed-step movement");
});

test("E29 and E30 wait at closed gates, re-plan by gate state, walk all rooms, then dash-hit the core", () => {
  for (const actorId of ["E29", "E30"] as const) {
    let state = createBattle({ matchId: `enemy-core-assault-${actorId}`, seed: actorId === "E29" ? 1301 : 1303 });
    placeInvaderFixture(state, actorId);

    state = stepUntilRoom(state, actorId, "corridor_0");
    assert.deepEqual(state.enemyDecisions[actorId].intent, {
      kind: "move_goal", roomId: "corridor_0", purpose: "assault",
    });
    assert.deepEqual(state.actors[actorId].location.pathGates, [], "a closed G1 must not be crossed");
    assert.equal(state.actors[actorId].location.pathRooms.includes("corridor_1"), false);
    assert.equal(state.outcome, "ongoing");
    assert.equal(state.dashes[actorId], undefined);

    const expectedRooms = ["corridor_1", "corridor_2", "corridor_3", "corridor_4", "corridor_5", "corridor_6", "core"];
    for (let opened = 1; opened <= 7; opened += 1) {
      setPlayerCastleGateCount(state, opened);
      const currentRoom = expectedRooms[opened - 1];
      state = stepBattle(state);
      assert.deepEqual(state.enemyDecisions[actorId].intent, {
        kind: "move_goal", roomId: currentRoom, purpose: "assault",
      }, `opening G${opened} should advance the normal assault goal`);
      state = stepUntilRoom(state, actorId, currentRoom);
      assert.deepEqual(state.actors[actorId].location.pathGates, state.layout.home.coreRouteGates.slice(0, opened));
      assert.equal(state.outcome, "ongoing", "room entry and all gates alone must not decide the match");
    }

    const route = state.layout.home.coreRouteRooms;
    assert.deepEqual(state.actors[actorId].location.pathRooms.slice(-route.length), route);
    assert.deepEqual(state.actors[actorId].location.pathGates, state.layout.home.coreRouteGates);

    let sawEnemyDash = false;
    let sawCommonCoreContact = false;
    // Room entry leaves about four floors to its centre: at 50 subunits per
    // tick, 120 ticks cover the walk and twelve-tick dash without a warp.
    for (let tick = 0; tick < 120 && state.outcome === "ongoing"; tick += 1) {
      state = stepBattle(state);
      sawEnemyDash ||= state.dashes[actorId] !== undefined ||
        state.lastStep.events.some((event) => event.type === "core_hit_candidate" && event.attackerId === actorId);
      sawCommonCoreContact ||= state.lastStep.acceptedInputKinds.includes("bridge:core_contact");
    }
    assert.equal(sawEnemyDash, true, "the enemy must use the shared physical dash executor");
    assert.equal(sawCommonCoreContact, true, "the actual first-contact event must enter the common terminal path");
    assert.equal(state.castles.player.core.hit, true);
    assert.equal(state.outcome, "enemy_win");
    assert.equal(state.phase, "ended");
  }
});

test("enemy assault still respects life, generation, spawn protection, and pause", () => {
  let state = createBattle({ matchId: "enemy-assault-lifecycle", seed: 1307 });
  placeInvaderFixture(state, "E29");
  const actor = state.actors.E29;
  actor.protectedUntilTick = state.tick + 10;
  const protectedStart = { ...state.fixedActors.E29.position };
  state.enemyDecisions.E29 = {
    generation: actor.generation,
    nextDecisionTick: state.tick + 100,
    intent: { kind: "move_goal", roomId: "core", purpose: "assault" },
  };
  state = stepBattle(state);
  assert.deepEqual(state.fixedActors.E29.position, protectedStart);
  assert.equal(state.enemyDecisions.E29, undefined);

  const renewed = state.actors.E29;
  renewed.protectedUntilTick = null;
  renewed.generation += 1;
  state.enemyDecisions.E29 = {
    generation: renewed.generation - 1,
    nextDecisionTick: state.tick + 100,
    intent: { kind: "wait", reason: "stale_generation" },
  };
  state = stepBattle(state);
  assert.equal(state.enemyDecisions.E29.generation, renewed.generation);
  assert.deepEqual(state.enemyDecisions.E29.intent, {
    kind: "move_goal", roomId: "corridor_0", purpose: "assault",
  });

  const dead = state.actors.E29;
  dead.alive = false;
  dead.health = 0;
  const deadPosition = { ...state.fixedActors.E29.position };
  state = stepBattle(state);
  assert.deepEqual(state.fixedActors.E29.position, deadPosition);
  assert.equal(state.enemyDecisions.E29, undefined);

  let paused = createBattle({ matchId: "enemy-assault-paused", seed: 1309 });
  placeInvaderFixture(paused, "E29");
  paused.phase = "paused";
  paused.pauseReasons = ["explicit"];
  const pausedTick = paused.tick;
  const pausedPosition = { ...paused.fixedActors.E29.position };
  paused = stepBattle(paused);
  assert.equal(paused.tick, pausedTick);
  assert.deepEqual(paused.fixedActors.E29.position, pausedPosition);
});

test("a diagonal dash predicted to miss is deferred until walking enables a real core hit", () => {
  let state = createBattle({ matchId: "enemy-assault-diagonal-retry", seed: 1319 });
  placeInRoom(state, "P1", "player", "ammo_a");
  placeInRoom(state, "P2", "player", "battery_a");
  placeInRoom(state, "P3", "player", "battery_b");
  setPlayerCastleGateCount(state, 7);

  const route = state.layout.home.coreRouteRooms;
  const gates = state.layout.home.coreRouteGates;
  const core = coreWorldPoint(state.layout.home);
  assert.ok(core);
  const corePoint = { x: Math.round(core.x * 1_000), y: Math.round(core.y * 1_000) };
  // The target delta is (2180, 850): within radial range, but the 8-way dash
  // quantizes to a 45-degree sweep that stops 1332 units from the core.
  const start = { x: corePoint.x + 2_180, y: corePoint.y + 850 };
  const actor = state.actors.E29;
  actor.location = { area: "castle", castleTeam: "player", roomId: "core", pathRooms: [...route], pathGates: [...gates] };
  actor.currentRoomId = "core";
  actor.position = { x: floorCell(start.x), y: floorCell(start.y) };
  state.fixedActors.E29 = { position: start, remainder: { x: 0, y: 0 } };
  state.crew.assignments.E29 = { actorId: "E29", task: "idle", path: [], pathIndex: 0 };
  delete state.enemyDecisions.E29;

  const initialDistance = Math.hypot(start.x - corePoint.x, start.y - corePoint.y);
  state = stepBattle(state);
  assert.equal(state.dashes.E29, undefined, "do not launch a diagonal sweep predicted to miss");
  assert.equal(state.outcome, "ongoing");
  assert.ok(Math.hypot(state.fixedActors.E29.position.x - corePoint.x, state.fixedActors.E29.position.y - corePoint.y) < initialDistance,
    "the ordinary path follower should close the gap before retrying");

  let sawCommonCoreContact = false;
  for (let tick = 0; tick < 180 && state.outcome === "ongoing"; tick += 1) {
    state = stepBattle(state);
    sawCommonCoreContact ||= state.lastStep.acceptedInputKinds.includes("bridge:core_contact");
  }
  assert.equal(sawCommonCoreContact, true, "the later physical first contact must use the shared bridge");
  assert.equal(state.castles.player.core.hit, true);
  assert.equal(state.outcome, "enemy_win");
});

test("E30 leaves its authored command-room spawn using ordinary fixed-step movement", () => {
  let state = createBattle({ matchId: "enemy-core-assault-e30-home-exit", seed: 20260913 });
  assert.equal(state.actors.E30.currentRoomId, "command");
  const start = { ...state.fixedActors.E30.position };
  const homeFrame = { area: state.actors.E30.location.area, castleTeam: state.actors.E30.location.castleTeam };
  let maxHomeFrameProgress = 0;
  let reachedPlaza = false;
  for (let tick = 0; tick < 4_000 && state.outcome === "ongoing"; tick += 1) {
    const beforeActor = state.actors.E30;
    const before = state.fixedActors.E30.position;
    state = stepBattle(state);
    const afterActor = state.actors.E30;
    const after = state.fixedActors.E30.position;
    if (beforeActor.location.area === afterActor.location.area &&
        beforeActor.location.castleTeam === afterActor.location.castleTeam) {
      assert.ok(Math.hypot(after.x - before.x, after.y - before.y) <= 51,
        "E30 must follow collision-checked movement within one coordinate frame");
      if (afterActor.location.area === homeFrame.area && afterActor.location.castleTeam === homeFrame.castleTeam) {
        maxHomeFrameProgress = Math.max(maxHomeFrameProgress, Math.hypot(after.x - start.x, after.y - start.y));
      }
    }
    if (state.actors.E30.location.area === "plaza") {
      assert.equal(beforeActor.location.castleTeam, "enemy");
      assert.equal(beforeActor.location.roomId, "central_corridor");
      assert.deepEqual(after, { x: 125_500, y: before.y }, "front exit projects x and preserves the walkable plaza y");
      reachedPlaza = true;
      break;
    }
  }
  assert.ok(maxHomeFrameProgress > 1_000, "E30 should make sustained progress within its authored home-castle coordinates");
  assert.equal(reachedPlaza, true, "E30 should reach the plaza from command within the bounded probe window");
});
