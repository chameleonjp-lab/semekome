import assert from 'node:assert/strict';
import test from 'node:test';
import { floorCell } from '../../src/actors/movement.ts';
import { projectBattleResultMetrics } from '../../src/presentation/battle-result-metrics.ts';
import { createBattle, getInteraction, pauseBattle, resumeBattle, stepBattle } from '../../src/simulation/physical-battle.ts';
import type { BattleState } from '../../src/simulation/physical-battle.ts';

const ZERO_METRICS = { enemyDefeatsTotal: 0, enemyUniqueDefeats: 0, playerDeaths: 0 };

function fixture(matchId = 'result-metrics'): BattleState {
  return createBattle({ matchId, seed: 211 });
}

function p1Intent(state: BattleState, attack = false) {
  return {
    matchId: state.matchId,
    actorId: 'P1' as const,
    generation: state.actors.P1.generation,
    direction: { x: 0, y: 0 } as const,
    ...(attack ? { attack: true } : {}),
  };
}

// A contact fixture limits unrelated AI interference without inventing death
// counters. Damage, death reservation, and respawn still run through stepBattle.
function contactFixture(): BattleState {
  const state = fixture('result-metrics-contact');
  for (const actor of Object.values(state.actors)) actor.protectedUntilTick = 10_000;
  putActorInPlaza(state, 'P1', 63_000);
  putActorInPlaza(state, 'E29', 63_500);
  return state;
}

function putActorInPlaza(state: BattleState, actorId: 'P1' | 'P2' | 'E29' | 'E30', x: number): void {
  const actor = state.actors[actorId];
  actor.location = { area: 'plaza', pathRooms: [], pathGates: [] };
  actor.currentRoomId = 'plaza';
  actor.position = { x: floorCell(x), y: 35 };
  actor.protectedUntilTick = null;
  actor.damageImmuneUntilTick = null;
  state.fixedActors[actorId] = { position: { x, y: 35_000 }, remainder: { x: 0, y: 0 } };
  state.dashes[actorId] = undefined;
}

function defeatByContact(state: BattleState, targetId: 'E29' | 'E30'): BattleState {
  putActorInPlaza(state, 'P1', 63_000);
  putActorInPlaza(state, targetId, 63_500);
  state.actors[targetId].health = 1;
  assert.equal(getInteraction(state, 'P1').attackTargetId, targetId);
  const next = stepBattle(state, p1Intent(state, true));
  assert.equal(next.lastStep.acceptedInputKinds.includes('bridge:actor_contact'), true);
  assert.equal(next.actors[targetId].alive, false);
  assert.equal(next.lastStep.events.filter((event) => event.type === 'actor_died' && event.actorId === targetId).length, 1);
  return next;
}

test('a new physical match starts with no defeats or player deaths', () => {
  const state = fixture();
  assert.equal(Object.values(state.actors).filter((actor) => actor.team === 'enemy').length, 30);
  assert.deepEqual(projectBattleResultMetrics(state), ZERO_METRICS);
});

test('repeat defeats increase the total while different enemy identities increase unique defeats', () => {
  const state = fixture();
  state.actors.E01.deathCount = 1;
  assert.deepEqual(projectBattleResultMetrics(state), { enemyDefeatsTotal: 1, enemyUniqueDefeats: 1, playerDeaths: 0 });
  state.actors.E01.deathCount = 3;
  assert.deepEqual(projectBattleResultMetrics(state), { enemyDefeatsTotal: 3, enemyUniqueDefeats: 1, playerDeaths: 0 });
  state.actors.E30.deathCount = 2;
  assert.deepEqual(projectBattleResultMetrics(state), { enemyDefeatsTotal: 5, enemyUniqueDefeats: 2, playerDeaths: 0 });
});

test('all 30 roster identities count once regardless of role, life generation, current location, or alive status', () => {
  const state = fixture();
  for (let slot = 1; slot <= 30; slot += 1) state.actors[`E${String(slot).padStart(2, '0')}`].deathCount = 1;
  state.actors.E01.deathCount = 10;
  state.actors.E01.generation = 9;
  state.actors.E25.alive = false;
  state.actors.E25.health = 0;
  state.actors.E25.respawnAtTick = 1_200;
  state.actors.E29.currentRoomId = 'command';
  state.actors.E29.location = { area: 'castle', castleTeam: 'player', roomId: 'command', pathRooms: ['command'], pathGates: [] };
  state.actors.E30.currentRoomId = 'plaza';
  state.actors.E30.location = { area: 'plaza', pathRooms: [], pathGates: [] };

  assert.deepEqual(projectBattleResultMetrics(state), { enemyDefeatsTotal: 39, enemyUniqueDefeats: 30, playerDeaths: 0 });
});

test('the fixed enemy roster and team exclude extra actors, aliases, and support deaths', () => {
  const state = fixture();
  state.actors.E01.deathCount = 2;
  state.actors.E02.team = 'player';
  state.actors.E02.deathCount = 7;
  state.actors.E03.id = 'E31';
  state.actors.E03.deathCount = 8;
  state.actors.E31 = { ...structuredClone(state.actors.E01), id: 'E31', deathCount: 9 };
  state.actors['enemy-alias'] = structuredClone(state.actors.E01);
  state.actors.P1.deathCount = 3;
  state.actors.P2.deathCount = 4;
  state.actors.P3.deathCount = 5;

  assert.deepEqual(projectBattleResultMetrics(state), { enemyDefeatsTotal: 2, enemyUniqueDefeats: 1, playerDeaths: 3 });
});

test('a support actor defeat contributes to the team result without requiring a P1 attack', () => {
  let state = contactFixture();
  putActorInPlaza(state, 'P1', 65_000);
  putActorInPlaza(state, 'P2', 63_000);
  state.actors.E29.health = 1;
  state.dashes.P2 = {
    direction: { x: 1, y: 0 },
    remainingTicks: state.rules.dashDurationTicks,
    start: { ...state.fixedActors.P2.position },
  };
  state = stepBattle(state, p1Intent(state));

  assert.equal(state.actors.E29.alive, false);
  assert.equal(state.lastStep.acceptedInputKinds.includes('bridge:actor_contact'), true);
  assert.equal(state.dashes.P1, undefined);
  assert.deepEqual(projectBattleResultMetrics(state), { enemyDefeatsTotal: 1, enemyUniqueDefeats: 1, playerDeaths: 0 });
});

test('real contact deaths survive pause, actual log truncation, and 20-second respawn before repeat and distinct defeats', () => {
  let state = contactFixture();
  state.eventLogLimit = 1;
  state = defeatByContact(state, 'E29');
  const deathTick = state.actors.E29.lastDeathTick!;
  const deadline = state.actors.E29.respawnAtTick!;
  const firstDefeat = { enemyDefeatsTotal: 1, enemyUniqueDefeats: 1, playerDeaths: 0 };
  assert.equal(deadline - deathTick, 1_200);
  assert.deepEqual(projectBattleResultMetrics(state), firstDefeat);

  state = pauseBattle(state);
  const pausedTick = state.tick;
  for (let step = 0; step < 3; step += 1) state = stepBattle(state);
  assert.equal(state.tick, pausedTick);
  assert.deepEqual(projectBattleResultMetrics(state), firstDefeat);
  state = resumeBattle(state);

  while (state.tick < deadline) state = stepBattle(state);
  assert.equal(state.actors.E29.alive, false);
  assert.equal(state.eventLog.length, 1);
  assert.equal(state.eventLog.some((event) => event.type === 'actor_died'), false, 'later events actually evict the death record');
  assert.deepEqual(projectBattleResultMetrics(state), firstDefeat);
  state = stepBattle(state);
  assert.equal(state.actors.E29.alive, true);
  assert.equal(state.actors.E29.generation, 1);
  assert.deepEqual(projectBattleResultMetrics(state), firstDefeat);

  state = defeatByContact(state, 'E29');
  assert.deepEqual(projectBattleResultMetrics(state), { enemyDefeatsTotal: 2, enemyUniqueDefeats: 1, playerDeaths: 0 });
  state = defeatByContact(state, 'E30');
  assert.deepEqual(projectBattleResultMetrics(state), { enemyDefeatsTotal: 3, enemyUniqueDefeats: 2, playerDeaths: 0 });
});

test('a real enemy dash counts P1 death once and retains it after five-second player respawn', () => {
  let state = contactFixture();
  state.actors.P1.health = 1;
  state.dashes.E29 = {
    direction: { x: -1, y: 0 },
    remainingTicks: state.rules.dashDurationTicks,
    start: { ...state.fixedActors.E29.position },
  };
  state = stepBattle(state, p1Intent(state));
  assert.equal(state.actors.P1.alive, false);
  assert.equal(state.lastStep.events.filter((event) => event.type === 'actor_died' && event.actorId === 'P1').length, 1);
  const deadline = state.actors.P1.respawnAtTick!;
  assert.equal(deadline - state.actors.P1.lastDeathTick!, 300);
  const playerDeath = { enemyDefeatsTotal: 0, enemyUniqueDefeats: 0, playerDeaths: 1 };
  assert.deepEqual(projectBattleResultMetrics(state), playerDeath);

  while (state.tick <= deadline) state = stepBattle(state);
  assert.equal(state.actors.P1.alive, true);
  assert.equal(state.actors.P1.generation, 1);
  assert.deepEqual(projectBattleResultMetrics(state), playerDeath);
});

test('the projection does not mutate the terminal snapshot and a new match resets every counter', () => {
  let state = contactFixture();
  state = defeatByContact(state, 'E29');
  state.matchLimitTicks = state.tick + 1;
  state = stepBattle(state);
  assert.equal(state.phase, 'ended');
  const before = structuredClone(state);
  const metrics = projectBattleResultMetrics(state);
  assert.deepEqual(metrics, { enemyDefeatsTotal: 1, enemyUniqueDefeats: 1, playerDeaths: 0 });
  assert.deepEqual(projectBattleResultMetrics(stepBattle(state)), metrics);
  assert.deepEqual(state, before);
  Object.assign(metrics, { enemyDefeatsTotal: 99 });
  assert.deepEqual(projectBattleResultMetrics(state), { enemyDefeatsTotal: 1, enemyUniqueDefeats: 1, playerDeaths: 0 });

  const nextMatch = fixture('result-metrics-rematch');
  assert.notEqual(nextMatch.matchId, state.matchId);
  assert.deepEqual(projectBattleResultMetrics(nextMatch), ZERO_METRICS);
});
