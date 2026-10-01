import assert from 'node:assert/strict';
import test from 'node:test';
import { createBattleRecorder, parseBattleReplay, replayBattle } from '../../src/replay/battle-replay.ts';
import { pauseBattle, resumeBattle } from '../../src/simulation/physical-battle.ts';

test('recorded public inputs reproduce the complete state and accepted-input order', () => {
  const recorder = createBattleRecorder({ matchId: 'replay-standard', seed: 20260913 });
  let state = recorder.state;
  for (let tick = 0; tick < 200; tick++) {
    state = recorder.step(state, { matchId: state.matchId, actorId: 'P1', generation: state.actors.P1.generation,
      direction: { x: 1, y: 0 }, ...(tick === 20 ? { allyCommand: { allyId: 'P2', kind: 'hold' } } : {}) });
    if (tick === 70) { state = pauseBattle(state); state = recorder.step(state); state = resumeBattle(state); }
  }
  const saved = parseBattleReplay(JSON.stringify(recorder.snapshot()));
  assert.equal(saved.steps.length, 200, 'pause does not advance replay time');
  assert.deepEqual(replayBattle(saved), state);
  saved.steps[0].accepted.push('fake-contact');
  assert.throws(() => replayBattle(saved), /diverged/);
});

test('replay snapshots are independent and unsupported or unordered records fail', () => {
  const recorder = createBattleRecorder({ matchId: 'replay-invalid', seed: 7 });
  const next = recorder.step(recorder.state);
  const record = recorder.snapshot();
  record.steps[0].tick = 4;
  assert.equal(recorder.snapshot().steps[0].tick, 1);
  assert.throws(() => parseBattleReplay(JSON.stringify(record)), /update/);
  assert.throws(() => recorder.step(recorder.state), /order/);
  assert.equal(next.tick, 1);
  assert.throws(() => parseBattleReplay('{"version":"old"}'), /version/);
  const changed = recorder.snapshot(); changed.initialState = '{}';
  assert.throws(() => replayBattle(changed), /initial state/);
});
