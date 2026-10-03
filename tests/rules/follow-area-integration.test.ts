import assert from 'node:assert/strict';
import test from 'node:test';
import { createBattle, stepBattle, pauseBattle, resumeBattle, type BattleState, type BattleDirection } from '../../src/simulation/physical-battle.ts';

function intent(state: BattleState, direction: BattleDirection = { x: 0, y: 0 }) {
  return { matchId: state.matchId, actorId: 'P1', generation: state.actors.P1.generation, direction };
}
function fixture() {
  const state = createBattle({ matchId: 'follow-cross-area', seed: 713 });
  // Movement-only fixture: preserve the 30-person roster but keep distant
  // enemies protected and prevent patrol deployments from obscuring follow.
  for (const actor of Object.values(state.actors)) if (actor.team === 'enemy') {
    actor.protectedUntilTick = 100_000; actor.canGuardPlaza = false;
  }
  for (const [index, id] of ['P1', 'P2', 'P3'].entries()) {
    const actor = state.actors[id];
    const position = { x: 123_500 - index * 1_000, y: 35_500 };
    actor.location = { area: 'castle', castleTeam: 'player', roomId: 'central_corridor', pathRooms: ['central_corridor'], pathGates: [] };
    actor.currentRoomId = 'central_corridor';
    actor.position = { x: Math.floor(position.x / 1000), y: 35 };
    state.fixedActors[id] = { position, remainder: { x: 0, y: 0 } };
  }
  return state;
}
function ordered(state: BattleState) {
  for (const allyId of ['P2', 'P3'] as const) state = stepBattle(state, { ...intent(state), allyCommand: { allyId, kind: 'follow' } });
  return state;
}
function until(state: BattleState, goal: (s: BattleState) => boolean, direction: BattleDirection, maxTicks = 2000) {
  for (let tick = 0; tick < maxTicks && !goal(state); tick++) state = stepBattle(state, intent(state, direction));
  assert.ok(goal(state), `follow route reached goal; ${JSON.stringify(['P1', 'P2', 'P3'].map(id => ({ id, area: state.actors[id].location, position: state.fixedActors[id].position })))}`);
  return state;
}
const inCastle = (state: BattleState, id: string, team: 'player' | 'enemy') => state.actors[id].location.area === 'castle' && state.actors[id].location.castleTeam === team;

test('short NPC path-alignment steps update facing along every actual movement axis', () => {
  for (const [from, target, direction] of [
    [{ x: 60_500, y: 34_450 }, { x: 63_500, y: 34_500 }, { x: 0, y: 1 }],
    [{ x: 60_500, y: 34_550 }, { x: 63_500, y: 34_500 }, { x: 0, y: -1 }],
    [{ x: 60_450, y: 34_500 }, { x: 60_500, y: 37_500 }, { x: 1, y: 0 }],
    [{ x: 60_550, y: 34_500 }, { x: 60_500, y: 37_500 }, { x: -1, y: 0 }],
  ] as const) {
    let state = fixture();
    for (const [id, position] of [['P1', target], ['P2', from]] as const) {
      state.fixedActors[id] = { position: { ...position }, remainder: { x: 0, y: 0 } };
      state.actors[id].position = { x: Math.floor(position.x / 1000), y: Math.floor(position.y / 1000) };
    }
    state.actorFacing.P2 = direction.x ? { x: 0, y: -1 } : { x: -1, y: 0 };
    state = stepBattle(state, { ...intent(state), allyCommand: { allyId: 'P2', kind: 'follow' } });
    assert.deepEqual(state.fixedActors.P2.position, { x: from.x + direction.x * 50, y: from.y + direction.y * 50 });
    assert.deepEqual(state.actorFacing.P2, direction);
  }
});

test('both followers cross actual home/plaza/enemy entrances and return without teleporting', { timeout: 60_000 }, () => {
  let state = ordered(fixture());
  state = until(state, s => s.actors.P1.location.area === 'plaza', { x: 1, y: 0 });
  state = until(state, s => ['P2', 'P3'].every(id => s.actors[id].location.area === 'plaza'), { x: 0, y: 0 });
  state = until(state, s => inCastle(s, 'P1', 'enemy'), { x: 1, y: 0 });
  state = until(state, s => ['P2', 'P3'].every(id => inCastle(s, id, 'enemy')), { x: 0, y: 0 });
  for (const id of ['P1', 'P2', 'P3']) {
    assert.equal(state.actors[id].currentRoomId, 'central_corridor');
    assert.deepEqual(state.actors[id].location.pathGates, [], 'following does not grant passage through closed gates');
  }
  state = until(state, s => s.actors.P1.location.area === 'plaza', { x: -1, y: 0 });
  state = until(state, s => inCastle(s, 'P1', 'player'), { x: -1, y: 0 });
  state = until(state, s => ['P2', 'P3'].every(id => inCastle(s, id, 'player')), { x: 0, y: 0 });
  assert.equal(Object.values(state.actors).filter(actor => actor.team === 'enemy').length, 30);
});

test('follow pauses with the world and drops generation-bound orders when player dies', () => {
  let state = ordered(fixture());
  const paused = pauseBattle(state);
  const frozen = stepBattle(paused);
  assert.equal(frozen.tick, paused.tick);
  assert.deepEqual(frozen.fixedActors, paused.fixedActors);
  assert.deepEqual(frozen.allyOrders, paused.allyOrders);
  assert.deepEqual(frozen.actors, paused.actors);
  state = resumeBattle(paused);
  state.actors.P1.health = 0;
  state = stepBattle(state);
  assert.equal(state.actors.P1.alive, false);
  for (const id of ['P2', 'P3'] as const) assert.equal(state.allyOrders[id], null);
  const respawn = state.actors.P1.respawnAtTick!;
  while (state.tick <= respawn) state = stepBattle(state);
  assert.equal(state.actors.P1.alive, true);
  assert.equal(state.actors.P1.generation, 1);
  for (const id of ['P2', 'P3'] as const) assert.equal(state.allyOrders[id], null);
});

test('a follow target beyond a closed gate never gives either ally a shortcut', () => {
  let state = fixture();
  for (const [id, roomId] of [['P1', 'corridor_1'], ['P2', 'corridor_0'], ['P3', 'corridor_0']] as const) {
    const room = state.layout.enemy.rooms.find(room => room.id === roomId)!;
    const point = { x: Math.round((room.rect.x0 + room.rect.x1) * 500), y: Math.round((room.rect.y0 + room.rect.y1) * 500) };
    state.actors[id].location = { area: 'castle', castleTeam: 'enemy', roomId, pathRooms: [roomId], pathGates: [] };
    state.actors[id].currentRoomId = roomId;
    state.actors[id].position = { x: Math.floor(point.x / 1000), y: Math.floor(point.y / 1000) };
    state.fixedActors[id] = { position: point, remainder: { x: 0, y: 0 } };
  }
  // The target position is a trusted unreachable-goal fixture; no actor gets
  // a route permission or an open gate from the follow command.
  state = ordered(state);
  for (let tick = 0; tick < 120; tick++) state = stepBattle(state, intent(state));
  for (const id of ['P2', 'P3'] as const) {
    assert.equal(state.actors[id].currentRoomId, 'corridor_0');
    assert.deepEqual(state.actors[id].location.pathGates, []);
  }
  assert.equal(state.castles.enemy.gates.G1.open, false);
  assert.equal(state.outcome, 'ongoing');
});

test('following combatants cover a visible threat with movement-directed shots then regroup when the leader changes rooms', () => {
  let state = ordered(fixture());
  const place = (id: string, x: number, y: number, roomId = 'central_corridor') => {
    const actor = state.actors[id];
    actor.location = { area: 'castle', castleTeam: 'player', roomId, pathRooms: [roomId], pathGates: [] };
    actor.currentRoomId = roomId; actor.position = { x: Math.floor(x / 1000), y: Math.floor(y / 1000) };
    state.fixedActors[id] = { position: { x, y }, remainder: { x: 0, y: 0 } };
  };
  place('P1', 90_500, 35_500);
  place('P2', 89_500, 34_500);
  place('P3', 89_500, 36_500);
  place('E29', 94_500, 35_500);
  state.actors.E29.protectedUntilTick = null;
  state.actors.E29.health = 100; state.actors.E29.maxHealth = 100;
  // Isolate cover behavior from return fire; this is a targeting fixture.
  state.shootCooldownUntilTick.E29 = 100_000;
  state.enemyDecisions.E29 = { generation: state.actors.E29.generation, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'follow cover fixture' } };
  const fired = new Set<string>();
  for (let tick = 0; tick < 80; tick++) {
    const before = structuredClone(state.fixedActors);
    state = stepBattle(state, intent(state));
    for (const id of ['P2', 'P3'] as const) {
      const from = before[id].position, to = state.fixedActors[id].position;
      assert.ok(Math.hypot(to.x - from.x, to.y - from.y) <= 101, 'cover gets only one movement update');
      for (const shot of state.shots) if (shot.actorId === id) fired.add(id);
    }
  }
  assert.deepEqual([...fired].sort(), ['P2', 'P3']);
  assert.ok(state.actors.E29.health < 100, 'at least one movement-directed shot actually hits');
  for (const id of ['P2', 'P3'] as const) assert.equal(state.allyOrders[id]?.kind, 'follow');
  place('P1', 104_500, 13_500, 'battery_a');
  state = stepBattle(state, intent(state));
  for (const id of ['P2', 'P3'] as const) {
    assert.equal(state.crew.assignments[id].task, 'patrol', 'leader leaving the room ends cover immediately');
    assert.equal(state.crew.assignments[id].targetActorId, 'P1');
    assert.equal(state.allyOrders[id]?.kind, 'follow');
  }
});

test('explicit collection and artillery recall both allies instead of chasing an enemy away from home', () => {
  for (const kind of ['collect', 'artillery'] as const) for (const allyId of ['P2', 'P3'] as const) {
    let state = fixture();
    for (const [id, x] of [['P1', 30_500], [allyId, 31_500], ['E29', 33_500]] as const) {
      const actor = state.actors[id];
      actor.protectedUntilTick = null;
      actor.location = { area: 'castle', castleTeam: 'enemy', roomId: 'central_corridor', pathRooms: ['central_corridor'], pathGates: [] };
      actor.currentRoomId = 'central_corridor'; actor.position = { x: Math.floor(x / 1000), y: 35 };
      state.fixedActors[id] = { position: { x, y: 35_500 }, remainder: { x: 0, y: 0 } };
    }
    state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'explicit recall fixture' } };
    state.shootCooldownUntilTick.E29 = 100_000;
    state = stepBattle(state, { ...intent(state), allyCommand: { allyId, kind } });
    assert.equal(state.allyOrders[allyId]?.kind, kind);
    assert.equal(state.crew.assignments[allyId].task, 'return');
    assert.equal(state.crew.assignments[allyId].targetActorId, undefined);
    assert.ok(state.fixedActors[allyId].position.x < 31_500, 'walk toward the real enemy-left exit, not the enemy to the right');
    assert.ok(31_500 - state.fixedActors[allyId].position.x <= 100, 'recall has one movement step');
  }
});
