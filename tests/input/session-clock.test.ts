import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionClock, validatePlayerName } from '../../src/input/session-clock.ts';

test('name is trimmed, 1–20 Unicode scalar values, never silently truncated', () => {
  for (const name of ['', '   ', 'あ'.repeat(21), '😀'.repeat(21)]) assert.notEqual(validatePlayerName(name).error, null);
  for (const name of ['あ', 'あ'.repeat(20), '😀'.repeat(20)]) assert.equal(validatePlayerName(name).error, null);
  assert.equal(validatePlayerName('　 太郎  ').name, '太郎');
});

test('30/60/120 Hz rendering produces exactly the same fixed tick count', () => {
  for (const hz of [30, 60, 120]) {
    const clock = new SessionClock(); let ticks = 0;
    for (let frame = 0; frame <= hz * 10; frame++) ticks += clock.advance(frame * 1000 / hz).ticks;
    assert.equal(ticks, 600);
  }
});

test('pause and stalls discard wall time instead of fast forwarding', () => {
  const clock = new SessionClock(); clock.advance(0); clock.advance(10); clock.reset();
  assert.equal(clock.advance(30000).ticks, 0);
  assert.equal(clock.advance(30000 + 1000 / 60).ticks, 1);
  assert.deepEqual(clock.advance(31000), { ticks: 0, interrupted: true });
  assert.equal(clock.advance(32000).ticks, 0);
});
