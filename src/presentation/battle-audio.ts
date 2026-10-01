import type { WorldEvent } from '../domain/types.ts';
// All sounds are original Web Audio oscillator tones; no sampled assets.
const tones: Record<string, number> = { object_moved: 660, projectile_launched: 180,
  projectile_intercepted: 900, repair_completed: 520, equipment_repair_completed: 520,
  part_destroyed: 140, equipment_damaged: 440, core_hit_candidate: 100, outcome: 720 };
export function createBattleAudio(enabled: boolean) {
  let context: AudioContext | undefined;
  let closed = false;
  return {
    activate() { if (!enabled || closed) return; try { context ??= new AudioContext(); void context.resume().catch(() => {}); } catch {} },
    suspend() { if (context && !closed) void context.suspend().catch(() => {}); },
    observe(events: readonly WorldEvent[]) {
      if (!context || closed || context.state !== 'running') return;
      const frequencies = [...new Set(events.map(event => event.type === "object_moved" ? (event.location.kind === "carried" ? 660 : event.location.kind === "queue" ? 330 : 0) : tones[event.type]).filter(Boolean))].slice(0, 3);
      for (const frequency of frequencies) {
        const oscillator = context.createOscillator(), gain = context.createGain();
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.04, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.start(); oscillator.stop(context.currentTime + 0.13);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      }
    },
    dispose() { closed = true; if (context) void context.close().catch(() => {}); },
  };
}
