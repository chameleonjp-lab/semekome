import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATTLE_RULESET_ID,
  createBattleSessionRecord,
  createBattleSessionStore,
  sessionRecordStorageKey,
  type BattleSessionResultPayload,
  type BattleSessionStorage,
} from '../../src/presentation/battle-session-record.ts';

function storage(): BattleSessionStorage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

function result(matchId: string): BattleSessionResultPayload {
  return {
    matchId,
    outcome: 'player_win',
    reason: 'enemy_core_hit',
    endedTick: 1_234,
    enemyExteriorDestroyed: 7,
    enemyGatesOpened: 7,
    playerOperatedLaunches: 12,
    playerDashStarts: 3,
  };
}

test('開始記録は開始成立時に一つだけ作られ、同じ試合では同じ記録を返す', () => {
  const matchId = 'session-start-once';
  const store = createBattleSessionStore(storage());
  const record = createBattleSessionRecord({
    matchId,
    playerName: '  記録検査  ',
    playerSupplyAllocation: ['standard_slug', 'dense_payload'],
    idFactory: kind => `${kind}-one`,
  });
  const first = store.begin(record);
  const second = store.begin(record);

  assert.equal(first.start.id, 'start-one');
  assert.equal(second.start.id, first.start.id);
  assert.equal(first.start.status, 'idle');
  assert.equal(first.connection, 'unconnected');
  assert.equal(first.start.payload.rulesetId, BATTLE_RULESET_ID);
  assert.deepEqual(first.start.payload.playerSupplyAllocation, ['standard_slug', 'dense_payload']);
});

test('同じ終局結果の再送は同じ submissionId で冪等になり、内容変更は拒否する', () => {
  const matchId = 'session-result-idempotency';
  const store = createBattleSessionStore(storage());
  const record = createBattleSessionRecord({
    matchId,
    playerName: '結果検査',
    playerSupplyAllocation: [],
    idFactory: kind => `${kind}-one`,
  });
  store.begin(record);

  const first = store.finish(matchId, result(matchId), kind => `${kind}-first`);
  const second = store.finish(matchId, result(matchId), kind => `${kind}-second`);
  assert.equal(first.result?.submissionId, 'result-first');
  assert.equal(second.result?.submissionId, first.result?.submissionId);
  assert.equal(second.result?.status, 'idle');

  assert.throws(() => store.finish(matchId, { ...result(matchId), endedTick: 1_235 }));
});

test('開始記録と結果記録は同じ matchId で sessionStorage 相当へ保存される', () => {
  const matchId = 'session-storage-roundtrip';
  const shared = storage();
  const record = createBattleSessionRecord({
    matchId,
    playerName: '再読込検査',
    playerSupplyAllocation: ['fast_dart'],
    idFactory: kind => `${kind}-roundtrip`,
  });
  const firstStore = createBattleSessionStore(shared);
  firstStore.begin(record);
  firstStore.finish(matchId, result(matchId), kind => `${kind}-roundtrip`);

  const reloadedStore = createBattleSessionStore(shared);
  const reloaded = reloadedStore.read(matchId);
  assert.ok(reloaded);
  assert.equal(reloaded.start.id, 'start-roundtrip');
  assert.equal(reloaded.result?.submissionId, 'result-roundtrip');
  assert.equal(reloaded.result?.payload.matchId, matchId);
  assert.equal(shared.getItem(sessionRecordStorageKey(matchId)) !== null, true);
});

test('別の開始内容を同じ matchId へ重ねることはできない', () => {
  const matchId = 'session-conflicting-start';
  const store = createBattleSessionStore(storage());
  store.begin(createBattleSessionRecord({
    matchId,
    playerName: '最初',
    playerSupplyAllocation: [],
    idFactory: kind => `${kind}-first`,
  }));

  const conflicting = createBattleSessionRecord({
    matchId,
    playerName: '別の名前',
    playerSupplyAllocation: [],
    idFactory: kind => `${kind}-second`,
  });
  assert.throws(() => store.begin(conflicting));
});

test('sessionStorage が書き込めない場合もメモリ記録へ戻り、結果画面を止めない', () => {
  const unavailable: BattleSessionStorage = {
    getItem: () => { throw new Error('storage unavailable'); },
    setItem: () => { throw new Error('storage unavailable'); },
  };
  const store = createBattleSessionStore(unavailable);
  const record = createBattleSessionRecord({
    matchId: 'session-memory-fallback',
    playerName: '保存不可検査',
    playerSupplyAllocation: [],
    idFactory: kind => `${kind}-fallback`,
  });
  store.begin(record);
  assert.equal(store.persistent, false);
  const completed = store.finish(record.matchId, result(record.matchId), kind => `${kind}-fallback`);
  assert.equal(completed.result?.submissionId, 'result-fallback');
});
