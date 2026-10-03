import { DEFAULT_RULES } from '../content/rules.ts';
import type { BattleResultMetrics } from './battle-result-metrics.ts';

export const BATTLE_RULESET_ID = DEFAULT_RULES.rulesetId;
export const SESSION_RECORD_STORAGE_PREFIX = 'semekome:battle-session:';

export type BattleOutcome = 'player_win' | 'enemy_win' | 'draw';
export type BattleResultReason = 'enemy_core_hit' | 'player_core_hit' | 'simultaneous_core_hit' | 'time_limit';
export type SubmissionStatus = 'idle' | 'submitting' | 'submitted' | 'retryable_failed' | 'permanent_failed';
export type SessionRecordConnection = 'unconnected';

export interface BattleSessionStartPayload {
  readonly matchId: string;
  readonly playerName: string;
  readonly mode: 'standard';
  readonly rulesetId: string;
  readonly playerSupplyAllocation: readonly string[];
}

export interface BattleSessionResultPayload {
  readonly matchId: string;
  readonly outcome: BattleOutcome;
  readonly reason: BattleResultReason;
  readonly endedTick: number;
  readonly enemyExteriorDestroyed: number;
  readonly enemyGatesOpened: number;
  readonly playerOperatedLaunches: number;
  readonly playerDashStarts: number;
  /** Older local records may lack a release score. */
  readonly score?: number;
  readonly scoreVersion?: string;
  /** Records made before R2ai have no combat detail; absence is not zero. */
  readonly combatMetrics?: BattleResultMetrics;
}

export interface BattleSessionRecord {
  readonly matchId: string;
  readonly connection: SessionRecordConnection;
  readonly start: {
    readonly id: string;
    readonly payload: BattleSessionStartPayload;
    readonly status: SubmissionStatus;
  };
  readonly result?: {
    readonly submissionId: string;
    readonly payload: BattleSessionResultPayload;
    readonly status: SubmissionStatus;
  };
}

export type SessionRecordIdFactory = (kind: 'start' | 'result') => string;

export interface BattleSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultId(kind: 'start' | 'result'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${kind}-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function immutableRecord(record: BattleSessionRecord): BattleSessionRecord {
  return Object.freeze({
    ...record,
    start: Object.freeze({
      ...record.start,
      payload: Object.freeze({
        ...record.start.payload,
        playerSupplyAllocation: Object.freeze([...record.start.payload.playerSupplyAllocation]),
      }),
    }),
    ...(record.result ? {
      result: Object.freeze({
        ...record.result,
        payload: Object.freeze({
          ...record.result.payload,
          ...(record.result.payload.combatMetrics ? {
            combatMetrics: Object.freeze({ ...record.result.payload.combatMetrics }),
          } : {}),
        }),
      }),
    } : {}),
  });
}

export function sessionRecordStorageKey(matchId: string): string {
  return `${SESSION_RECORD_STORAGE_PREFIX}${matchId}`;
}

export function createBattleSessionRecord(options: {
  matchId: string;
  playerName: string;
  playerSupplyAllocation: readonly string[];
  idFactory?: SessionRecordIdFactory;
}): BattleSessionRecord {
  const idFactory = options.idFactory ?? defaultId;
  return immutableRecord({
    matchId: options.matchId,
    connection: 'unconnected',
    start: {
      id: idFactory('start'),
      payload: {
        matchId: options.matchId,
        playerName: options.playerName,
        mode: 'standard',
        rulesetId: BATTLE_RULESET_ID,
        playerSupplyAllocation: [...options.playerSupplyAllocation],
      },
      status: 'idle',
    },
  });
}

export function completeBattleSessionRecord(
  record: BattleSessionRecord,
  payload: BattleSessionResultPayload,
  idFactory: SessionRecordIdFactory = defaultId,
): BattleSessionRecord {
  if (payload.matchId !== record.matchId) throw new Error('result record matchId must match the session');
  if (record.result) {
    if (!sameJson(record.result.payload, payload)) throw new Error('result record is immutable after completion');
    return record;
  }
  return immutableRecord({
    ...record,
    result: {
      submissionId: idFactory('result'),
      payload: {
        ...payload,
        ...(payload.combatMetrics ? { combatMetrics: { ...payload.combatMetrics } } : {}),
      },
      status: 'idle',
    },
  });
}

function defaultStorage(): BattleSessionStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export interface BattleSessionStore {
  readonly persistent: boolean;
  read(matchId: string): BattleSessionRecord | undefined;
  begin(record: BattleSessionRecord): BattleSessionRecord;
  finish(matchId: string, payload: BattleSessionResultPayload, idFactory?: SessionRecordIdFactory): BattleSessionRecord;
}

export function createBattleSessionStore(storage: BattleSessionStorage | undefined = defaultStorage()): BattleSessionStore {
  const memory = new Map<string, BattleSessionRecord>();
  let persistent = storage !== undefined;

  const read = (matchId: string): BattleSessionRecord | undefined => {
    const cached = memory.get(matchId);
    if (cached) return cached;
    if (!storage) return undefined;
    try {
      const raw = storage.getItem(sessionRecordStorageKey(matchId));
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as BattleSessionRecord;
      if (parsed.matchId !== matchId || parsed.connection !== 'unconnected' || !parsed.start) return undefined;
      const restored = immutableRecord(parsed);
      memory.set(matchId, restored);
      return restored;
    } catch {
      persistent = false;
      return undefined;
    }
  };

  const write = (record: BattleSessionRecord): void => {
    memory.set(record.matchId, record);
    if (!storage) return;
    try {
      storage.setItem(sessionRecordStorageKey(record.matchId), JSON.stringify(record));
    } catch {
      // Private browsing and quota failures must not stop the result screen.
      persistent = false;
    }
  };

  return {
    get persistent() { return persistent; },
    read,
    begin(record) {
      const existing = read(record.matchId);
      if (!existing) {
        const started = immutableRecord(record);
        write(started);
        return started;
      }
      if (!sameJson(existing.start, record.start)) throw new Error('a different start record already exists for this match');
      return existing;
    },
    finish(matchId, payload, idFactory = defaultId) {
      const existing = read(matchId);
      if (!existing) throw new Error('cannot finish an unknown battle session');
      const completed = completeBattleSessionRecord(existing, payload, idFactory);
      write(completed);
      return completed;
    },
  };
}
