import assert from 'node:assert/strict';
import test from 'node:test';
import { createBattleAudio } from '../../src/presentation/battle-audio.ts';

test('audio suspends on pause, resumes after interaction, and lets the terminal tone finish before closing', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.AudioContext;
  let active: FakeContext | undefined;
  class FakeContext {
    state = 'suspended'; currentTime = 0; destination = {}; voices = 0; closes = 0;
    constructor() { active = this; }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; this.closes++; }
    createOscillator() { return { frequency:{value:0}, connect() {}, disconnect() {}, start: () => this.voices++, stop() {}, onended: undefined }; }
    createGain() { return { gain:{setValueAtTime() {},exponentialRampToValueAtTime() {}}, connect() {}, disconnect() {} }; }
  }
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  try {
    const muted = createBattleAudio(false); muted.activate(); assert.equal(active,undefined);
    const audio = createBattleAudio(true); audio.activate();
    audio.observe([{type:'outcome',outcome:'player_win',tick:10}]); assert.equal(active!.voices,1);
    audio.suspend(); audio.observe([{type:'outcome',outcome:'player_win',tick:10}]); assert.equal(active!.voices,1);
    audio.activate(); audio.observe([{type:'outcome',outcome:'player_win',tick:10}]); assert.equal(active!.voices,2);
    audio.finish(); assert.equal(active!.closes,0,'closing immediately would truncate the result tone');
    audio.activate(); audio.observe([{type:'outcome',outcome:'player_win',tick:10}]); assert.equal(active!.voices,2);
    context.mock.timers.tick(150); assert.equal(active!.closes,1);
    const replayAudio = createBattleAudio(true); replayAudio.activate(); replayAudio.finish(); replayAudio.dispose();
    assert.equal(active!.closes,1); context.mock.timers.tick(150); assert.equal(active!.closes,1,'a disposed screen must cancel its delayed close');
  } finally { globalThis.AudioContext = original; }
});
