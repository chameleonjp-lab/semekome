import assert from 'node:assert/strict';
import test from 'node:test';
import { CORE_CONTACT_RADIUS_SUBUNITS, coreWorldPoint } from '../../src/actors/geometry.ts';
import { floorCell } from '../../src/actors/movement.ts';
import { PART_IDS, type TeamId } from '../../src/domain/types.ts';
import { createBattle, stepBattle, type BattleDirection, type BattleState, type FixedPoint } from '../../src/simulation/physical-battle.ts';

// Trusted scene setup, not a claim of walking from the standard initial state.
function openCastle(state: BattleState, team: TeamId) {
  const layout = team === 'player' ? state.layout.home : state.layout.enemy;
  const castle = state.castles[team];
  for (const part of Object.values(castle.exterior)) { part.health = 0; part.destroyed = true; }
  castle.destroyedPartIds = [...PART_IDS];
  for (const gate of Object.values(castle.gates)) gate.open = true;
  castle.openGateIds = [...layout.coreRouteGates];
}

function place(state: BattleState, actorId: string, team: TeamId, offset: FixedPoint) {
  const layout = team === 'player' ? state.layout.home : state.layout.enemy;
  const core = coreWorldPoint(layout)!;
  const point = { x: core.x * 1000 + offset.x, y: core.y * 1000 + offset.y };
  const actor = state.actors[actorId];
  actor.currentRoomId = 'core';
  actor.location = { area: 'castle', castleTeam: team, roomId: 'core', pathRooms: [...layout.coreRouteRooms], pathGates: [...layout.coreRouteGates] };
  actor.position = { x: floorCell(point.x), y: floorCell(point.y) };
  state.fixedActors[actorId].position = point;
  state.fixedActors[actorId].remainder = { x: 0, y: 0 };
  return point;
}

function scene() {
  const state = createBattle({ matchId: 'physical-core-boundary', seed: 917 });
  openCastle(state, 'enemy');
  place(state, 'P1', 'enemy', { x: -1700, y: 0 });
  return state;
}

function dash(state: BattleState, direction: BattleDirection = { x: 1, y: 0 }) {
  return stepBattle(state, { matchId: state.matchId, actorId: 'P1', generation: state.actors.P1.generation, dash: direction });
}

test('a physical dash enters the core contact radius and ends once, not upon entering the room', () => {
  let state = scene();
  state = stepBattle(state);
  assert.equal(state.outcome, 'ongoing');
  state = dash(state);
  assert.equal(state.outcome, 'ongoing', 'the first 100 subunits have not reached the core');
  while (state.dashes.P1) state = stepBattle(state);
  assert.equal(state.outcome, 'player_win');
  assert.equal(state.castles.enemy.core.hit, true);
  assert.equal(state.eventLog.filter(event => event.type === 'outcome').length, 1);
  const center = coreWorldPoint(state.layout.enemy)!;
  const point = state.fixedActors.P1.position;
  assert.ok(Math.abs(Math.hypot(point.x - center.x * 1000, point.y - center.y * 1000) - CORE_CONTACT_RADIUS_SUBUNITS) <= 2);
  const ended = stepBattle(state);
  assert.equal(ended.tick, state.tick);
  assert.equal(ended.outcome, state.outcome);
});

test('an empty-room dash, walking over the core and friendly core contact cannot win', () => {
  let empty = scene();
  place(empty, 'P1', 'enemy', { x: -2500, y: -2000 });
  empty = dash(empty);
  for (let i = 0; i < 12; i++) empty = stepBattle(empty);
  assert.equal(empty.outcome, 'ongoing');
  assert.equal(empty.castles.enemy.core.hit, false);

  let walking = scene();
  place(walking, 'P1', 'enemy', { x: -200, y: 0 });
  for (let i = 0; i < 8; i++) walking = stepBattle(walking, { matchId: walking.matchId, actorId: 'P1', generation: 0, direction: { x: 1, y: 0 } });
  assert.equal(walking.outcome, 'ongoing');
  assert.equal(walking.castles.enemy.core.hit, false);

  let friendly = scene();
  openCastle(friendly, 'player');
  place(friendly, 'P1', 'player', { x: -1200, y: 0 });
  friendly = dash(friendly);
  for (let i = 0; i < 12; i++) friendly = stepBattle(friendly);
  assert.equal(friendly.outcome, 'ongoing');
  assert.equal(friendly.castles.player.core.hit, false);
});

test('a defender is the first contact and stops a dash before the core', () => {
  const state = scene();
  place(state, 'P1', 'enemy', { x: -1800, y: 0 });
  place(state, 'E29', 'enemy', { x: -1230, y: 0 });
  const next = dash(state);
  assert.equal(next.actors.E29.health, 3);
  assert.equal(next.dashes.P1, undefined);
  assert.equal(next.castles.enemy.core.hit, false);
  assert.equal(next.outcome, 'ongoing');
});

test('public core evidence cannot replace a defender as the first physical contact', () => {
  for (const alreadyDashing of [false, true]) {
    const state = scene();
    const from = place(state, 'P1', 'enemy', { x: -1100, y: 0 });
    place(state, 'E29', 'enemy', { x: -550, y: 0 });
    const core = coreWorldPoint(state.layout.enemy)!;
    if (alreadyDashing) state.dashes.P1 = { direction: { x: 1, y: 0 }, start: from, remainingTicks: 12 };
    const next = stepBattle(state, {
      matchId: state.matchId, actorId: 'P1', generation: state.actors.P1.generation,
      ...(alreadyDashing ? {} : { dash: { x: 1 as const, y: 0 as const } }),
      bridge: { kind: 'core_contact', evidence: {
        matchId: state.matchId, tick: state.tick, actorId: 'P1', generation: state.actors.P1.generation,
        targetTeam: 'enemy', attackType: 'dash', firstContact: 'core', from,
        to: { x: core.x * 1000, y: core.y * 1000 },
      } },
    });
    assert.equal(next.outcome, 'ongoing');
    assert.equal(next.castles.enemy.core.hit, false);
    assert.equal(next.actors.E29.health, 3);
    assert.equal(next.lastStep.acceptedInputKinds.includes('bridge:actor_contact'), true);
    assert.equal(next.lastStep.rejected.some(item => item.detail?.includes('physically simulated dash')), true);
    assert.equal(next.tick, state.tick + 1);
  }
});

test('invalid public evidence cannot cancel a real physical core hit', () => {
  for (const alreadyDashing of [false, true]) {
    const state = scene();
    const from = place(state, 'P1', 'enemy', { x: -CORE_CONTACT_RADIUS_SUBUNITS - 50, y: 0 });
    const core = coreWorldPoint(state.layout.enemy)!;
    if (alreadyDashing) state.dashes.P1 = { direction: { x: 1, y: 0 }, start: from, remainingTicks: 12 };
    const next = stepBattle(state, {
      matchId: state.matchId, actorId: 'P1', generation: state.actors.P1.generation,
      ...(alreadyDashing ? {} : { dash: { x: 1 as const, y: 0 as const } }),
      bridge: { kind: 'core_contact', evidence: {
        matchId: state.matchId, tick: state.tick, actorId: 'P1', generation: state.actors.P1.generation,
        targetTeam: 'enemy', attackType: 'dash', firstContact: 'core', from,
        to: { x: core.x * 1000, y: core.y * 1000 },
      } },
    });
    assert.equal(next.outcome, 'player_win');
    assert.equal(next.castles.enemy.core.hit, true);
    assert.equal(next.lastStep.acceptedInputKinds.includes('bridge:core_contact'), true);
    assert.equal(next.lastStep.events.filter(event => event.type === 'outcome').length, 1);
    assert.equal(next.tick, state.tick + 1);
  }
});

test('a core hit cannot use a closed seventh gate or spawn protection', () => {
  const closed = scene();
  const gate = closed.castles.enemy.gates.G7;
  gate.open = false;
  closed.castles.enemy.openGateIds = closed.castles.enemy.openGateIds.filter(id => id !== 'G7');
  closed.castles.enemy.exterior.P7.destroyed = false;
  closed.castles.enemy.exterior.P7.health = 1;
  closed.castles.enemy.destroyedPartIds = PART_IDS.filter(id => id !== 'P7');
  const actor = closed.actors.P1;
  const point = { x: 114500, y: 35000 };
  actor.currentRoomId = 'corridor_6';
  actor.location.roomId = 'corridor_6';
  actor.location.pathRooms = closed.layout.enemy.coreRouteRooms.slice(0, -1);
  actor.location.pathGates = closed.layout.enemy.coreRouteGates.slice(0, -1);
  actor.position = { x: floorCell(point.x), y: floorCell(point.y) };
  closed.fixedActors.P1.position = point;
  let blocked = dash(closed);
  for (let i = 0; i < 12; i++) blocked = stepBattle(blocked);
  assert.ok(blocked.fixedActors.P1.position.x < 115000);
  assert.notEqual(blocked.actors.P1.currentRoomId, 'core');
  assert.equal(blocked.outcome, 'ongoing');

  const protectedState = scene();
  protectedState.actors.P1.protectedUntilTick = 60;
  const protectedNext = dash(protectedState);
  assert.equal(protectedNext.dashes.P1, undefined);
  assert.equal(protectedNext.outcome, 'ongoing');
});

test('opposing physical core hits in one tick draw regardless of actor insertion order', () => {
  for (const reverse of [false, true]) {
    const state = scene();
    openCastle(state, 'player');
    place(state, 'P1', 'enemy', { x: -CORE_CONTACT_RADIUS_SUBUNITS - 50, y: 0 });
    const enemyStart = place(state, 'E29', 'player', { x: -CORE_CONTACT_RADIUS_SUBUNITS - 50, y: 0 });
    state.dashes.E29 = { direction: { x: 1, y: 0 }, start: enemyStart, remainingTicks: 12 };
    if (reverse) state.actors = Object.fromEntries(Object.entries(state.actors).reverse());
    const next = dash(state);
    assert.equal(next.outcome, 'draw');
    assert.equal(next.tick, state.tick + 1);
    assert.equal(next.castles.player.core.hit, true);
    assert.equal(next.castles.enemy.core.hit, true);
    assert.equal(next.lastStep.events.filter(event => event.type === 'outcome').length, 1);
  }
});

test('a real core hit takes precedence over timeout and a due spectator respawn', () => {
  const state = scene();
  state.tick = state.matchLimitTicks - 1;
  const start = place(state, 'E29', 'player', { x: -CORE_CONTACT_RADIUS_SUBUNITS - 50, y: 0 });
  openCastle(state, 'player');
  state.dashes.E29 = { direction: { x: 1, y: 0 }, start, remainingTicks: 12 };
  state.actors.P1.alive = false;
  state.actors.P1.health = 0;
  state.actors.P1.respawnAtTick = state.tick;
  const next = stepBattle(state);
  assert.equal(next.outcome, 'enemy_win');
  assert.equal(next.actors.P1.alive, false);
  assert.equal(next.actors.P1.respawnAtTick, null);
  assert.equal(next.lastStep.events.some(event => event.type === 'actor_respawned' && event.actorId === 'P1'), false);
  assert.equal(next.lastStep.events.filter(event => event.type === 'outcome').length, 1);
});
