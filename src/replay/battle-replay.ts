import { createBattle, stepBattle, type BattleIntent, type BattleState, type CreateBattleOptions } from '../simulation/physical-battle.ts';

export const REPLAY_VERSION = 'semekome-physical-replay-2';
const MAX_TICKS = 25_200;
const MAX_BYTES = 8_000_000;
export interface BattleReplay {
  version: typeof REPLAY_VERSION;
  ruleset: string;
  initialState: string;
  initial: CreateBattleOptions;
  steps: Array<{ tick: number; intent?: BattleIntent; accepted: string[] }>;
  initialTick: number;
  finalTick: number;
  finalState: string;
}

/** Record simulation updates only: pause, rendering and wall time are absent. */
export function createBattleRecorder(initial: CreateBattleOptions) {
  const state = createBattle(initial);
  const record: BattleReplay = { version: REPLAY_VERSION, ruleset: state.rules.rulesetId,
    initialState: JSON.stringify(state), initial: structuredClone(initial), steps: [], initialTick: state.tick, finalTick: state.tick, finalState: JSON.stringify(state) };
  let lastState = state;
  return {
    state,
    step(before: BattleState, intent?: BattleIntent): BattleState {
      if (before.matchId !== initial.matchId || before.tick !== record.finalTick) throw new Error('Replay update is out of order');
      const next = stepBattle(before, intent);
      if (next.tick !== before.tick) {
        if (record.steps.length >= MAX_TICKS) throw new Error('Replay limit reached');
        record.steps.push({ tick: next.tick, ...(intent ? { intent: structuredClone(intent) } : {}), accepted: [...next.lastStep.acceptedInputKinds] });
        record.finalTick = next.tick;
      }
      lastState = next;
      return next;
    },
    snapshot(): BattleReplay { return { ...structuredClone(record), finalState: JSON.stringify(lastState) }; },
  };
}

export function parseBattleReplay(raw: string): BattleReplay {
  if (raw.length > MAX_BYTES) throw new Error('Replay is too large');
  const record = JSON.parse(raw) as BattleReplay;
  if (!record || record.version !== REPLAY_VERSION) throw new Error('Unsupported replay version');
  if (!record.initial || typeof record.initial.matchId !== 'string' || record.initial.matchId.length > 100 ||
      !Number.isInteger(record.initial.seed) || !Array.isArray(record.steps) || record.steps.length > MAX_TICKS ||
      !Number.isInteger(record.initialTick) || record.initialTick < 0 || record.finalTick - record.initialTick !== record.steps.length) throw new Error('Invalid replay header');
  const initial = createBattle(record.initial);
  if (record.ruleset !== initial.rules.rulesetId || record.initialState !== JSON.stringify(initial)) throw new Error('Unsupported ruleset or initial state');
  for (const [index, step] of record.steps.entries()) {
    if (step.tick !== record.initialTick + index + 1 || !Array.isArray(step.accepted) || step.accepted.some(kind => typeof kind !== 'string') ||
        step.intent && (step.intent.matchId !== record.initial.matchId || step.intent.actorId !== 'P1' || !Number.isInteger(step.intent.generation))) {
      throw new Error('Invalid replay update');
    }
  }
  return record;
}

/** Replay submitted inputs in order and check the accepted-input boundary. */
export function replayBattle(record: BattleReplay): BattleState {
  const checked = parseBattleReplay(JSON.stringify(record));
  let state = createBattle(checked.initial);
  for (const step of checked.steps) {
    state = stepBattle(state, step.intent);
    if (state.tick !== step.tick || JSON.stringify(state.lastStep.acceptedInputKinds) !== JSON.stringify(step.accepted)) {
      throw new Error(`Replay diverged at tick ${step.tick}`);
    }
  }
  if (JSON.stringify(state) !== checked.finalState) throw new Error('Replay final state diverged');
  return state;
}
