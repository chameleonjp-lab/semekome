import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePreferences, defaultPreferences } from '../../src/presentation/game-preferences.ts';
import { createBattle, stepBattle } from '../../src/simulation/physical-battle.ts';
import { MATCH_PRESETS, DIFFICULTIES } from '../../src/content/match-presets.ts';
import { createPracticeProgress } from '../../src/presentation/practice-progress.ts';

test('saved preferences validate version, names, allocation and support types without restoring partial battles', () => {
  const expected = { ...defaultPreferences(), name: '前回', preset: 'repair', difficulty: 'easy', supports: ['mechanic', 'mechanic'], practiceCompleted: ['transport'] };
  assert.deepEqual(parsePreferences(JSON.stringify(expected)), expected);
  for (const value of [{ ...expected, version: 0 }, { ...expected, allocation: [] }, { ...expected, preset: 'unknown' }, { ...expected, supports: ['secret'] }, { ...expected, practiceCompleted: ['unknown'] }]) {
    assert.deepEqual(parsePreferences(JSON.stringify(value)), defaultPreferences());
  }
  assert.deepEqual(parsePreferences('{'), defaultPreferences());
  assert.deepEqual(parsePreferences(' '.repeat(20_001)), defaultPreferences());
});

test('all six settings change actual enemy supply while preserving roster and respawn rules', () => {
  for (const preset of Object.keys(MATCH_PRESETS) as (keyof typeof MATCH_PRESETS)[]) {
    const state = createBattle({ matchId: preset, seed: 1, preset });
    assert.deepEqual([...state.logistics.bags.enemy].sort(), [...MATCH_PRESETS[preset].allocation].sort());
    assert.equal(Object.values(state.actors).filter(actor => actor.team === 'enemy').length, 30);
    assert.equal(state.rules.enemyRespawnTicks, 1200);
  }
  for (const difficulty of Object.keys(DIFFICULTIES) as (keyof typeof DIFFICULTIES)[]) {
    const state = stepBattle(createBattle({ matchId: difficulty, seed: 1, difficulty }));
    assert.ok(Object.values(state.enemyDecisions).length > 0);
    assert.ok(Object.values(state.enemyDecisions).every(decision => decision.nextDecisionTick === state.tick - 1 + DIFFICULTIES[difficulty].decisionTicks));
  }
});

test('practice does not accept NPC launches, arbitrary interception, or exterior damage alone', () => {
  const state = createBattle({ matchId: 'practice', seed: 1 });
  const transport = createPracticeProgress('transport'), interception = createPracticeProgress('interception');
  state.lastStep.events = [{ type: 'projectile_launched', projectileId: 'npc', objectId: 'case', sourceActorId: 'P2', sourceGeneration: 0, team: 'player', turretId: 'T1', route: 'direct' }, { type: 'projectile_intercepted', firstProjectileId: 'npc', secondProjectileId: 'enemy' }];
  assert.equal(transport.observe(state), false); assert.equal(interception.observe(state), false);
  state.lastStep.events = [{ ...state.lastStep.events[0], sourceActorId: 'P1', projectileId: 'player' } as typeof state.lastStep.events[number]];
  assert.equal(transport.observe(state), true); assert.equal(interception.observe(state), false);
  state.lastStep.events = [{ type: 'projectile_intercepted', firstProjectileId: 'player', secondProjectileId: 'enemy' }];
  assert.equal(interception.observe(state), true);
  assert.equal(createPracticeProgress('core').observe(state), false);
});
