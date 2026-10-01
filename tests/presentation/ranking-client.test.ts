import assert from 'node:assert/strict';
import test from 'node:test';
import { createRankingClient, type RankingConfig } from '../../src/ranking/ranking-client.ts';
const config: RankingConfig = { endpoint: 'https://example.test/rest/v1', publishableKey: 'sb_publishable_test_public', gameSlug: 'fixture', clientVersion: 'fixture-1', scoreMin: 0, scoreMax: 111800 };
const playId = '00000000-0000-4000-8000-000000000001';
function storage() { const values = new Map<string,string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value); } }; }
function server() {
  const calls: { name: string; args: any }[] = [];
  let loseSubmissionResponse = false;
  const fetchImpl: typeof fetch = async (url, request) => {
    const name = String(url).split('/').at(-1)!; const args = JSON.parse(request!.body as string); calls.push({name,args});
    if (name === 'start_game_play_v1') return Response.json({ accepted: true, start_id: args.p_start_id, play_id: playId, game_slug: args.p_game_slug, display_name: args.p_display_name, client_version: args.p_client_version });
    if (name === 'finish_game_play_v1') return Response.json({ accepted: true, play_id: playId, game_slug: args.p_game_slug, result_type: args.p_result_type, reached_wave: args.p_reached_wave, score: args.p_score });
    if (name === 'get_game_ranking') return Response.json([1,1,3].map(rank_no => ({ rank_no, display_name: '同率', best_score: 100000, play_count: 2, best_score_at: '2026-10-01T00:00:00Z' })));
    if (loseSubmissionResponse) { loseSubmissionResponse = false; throw new TypeError('response lost after server acceptance'); }
    return Response.json([{ accepted: true, result_play_id: playId, result_submission_id: args.p_submission_id, result_display_name: args.p_display_name, result_first_score: args.p_score, result_best_score: args.p_score, result_play_count: 1, was_duplicate: true }]);
  };
  return { fetchImpl, calls, loseResponse() { loseSubmissionResponse = true; } };
}

test('lost acknowledgment, reload and concurrent retry preserve submission identity and fixed result', async () => {
  const saved = storage(), rpc = server();
  let client = createRankingClient(config, saved, rpc.fetchImpl);
  await client.begin(' 名前 '); rpc.loseResponse();
  const result = { resultType: 'clear' as const, reached: 7, score: 100000, ranked: true };
  await assert.rejects(client.finish(result)); assert.equal(client.status, 'retryable_failed');
  await assert.rejects(client.begin('次の試合'), /Pending/);
  const first = rpc.calls.find(call => call.name === 'submit_score_idempotent_v1')!.args;
  client = createRankingClient(config, saved, rpc.fetchImpl);
  await Promise.all([client.sync(), client.sync()]);
  assert.equal(client.status, 'submitted');
  const submissions = rpc.calls.filter(call => call.name === 'submit_score_idempotent_v1');
  assert.equal(submissions.length, 2); assert.deepEqual(submissions[1].args, first);
  assert.equal(rpc.calls.filter(call => call.name === 'start_game_play_v1').length, 1);
  assert.equal(rpc.calls.filter(call => call.name === 'finish_game_play_v1').length, 1);
  await client.finish({ ranked: true, score: 100000, reached: 7, resultType: 'clear' });
  await assert.rejects(client.finish({ ...result, score: 99999 }), /conflict/);
  assert.deepEqual((await client.topTen()).map(row => row.rank_no), [1,1,3]);
});

test('pending start persists before network; same start retries; unranked retire never submits a score', async () => {
  const saved = storage(), rpc = server(); let first = true;
  const client = createRankingClient(config, saved, async (...args) => { if (first) { first = false; throw new TypeError('offline'); } return rpc.fetchImpl(...args); });
  await assert.rejects(client.begin('開始')); const startId = client.pending()!.startId;
  await client.sync(); assert.equal(rpc.calls[0].args.p_start_id, startId);
  await client.finish({ resultType: 'retire', reached: 0, score: 0, ranked: false });
  assert.equal(client.status, 'submitted'); assert.equal(rpc.calls.some(call => call.name === 'submit_score_idempotent_v1'), false);
});

test('malformed acknowledgment and permanent rejection cannot look successful; pending records are retained', async () => {
  for (const response of [Response.json({ accepted: true, play_id: playId }), Response.json({ code: 'P0001', message: 'unregistered' }, {status: 400})]) {
    const client = createRankingClient(config, storage(), async () => response);
    await assert.rejects(client.begin('検査')); assert.equal(client.status, 'permanent_failed');
    assert.ok(client.pending()?.startId);
  }
  const saved = storage(); saved.setItem('semekome-pending-ranking-v1', '{');
  const client = createRankingClient(config, saved, server().fetchImpl);
  await assert.rejects(client.begin('上書き不可'), /retained/);
  assert.equal(saved.getItem('semekome-pending-ranking-v1'), '{');
  await assert.rejects(createRankingClient(config, storage(), async () => Response.json(Array.from({length: 11}, () => ({})))).topTen(), /mismatch/);
});

test('unapproved score proposal preserves the victory base, counts distinct enemies, and floors only the variable part', async () => {
  const { createBattle } = await import('../../src/simulation/physical-battle.ts');
  const { calculateProposedScore } = await import('../../src/ranking/score-proposal.ts');
  const state = createBattle({ matchId: 'score-boundary', seed: 1 });
  assert.throws(() => calculateProposedScore(state), /terminal/);
  state.phase = 'ended'; state.outcome = 'player_win';
  state.castles.enemy.destroyedPartIds = ['P1','P2','P3','P4','P5','P6','P7'];
  for (const actor of Object.values(state.actors).filter(actor => actor.team === 'enemy')) actor.deathCount = 10;
  assert.equal(calculateProposedScore(state), 111800, 'repeat defeats do not add points');
  state.tick = 61; assert.equal(calculateProposedScore(state), 111780, 'remaining time uses integer floor');
  state.outcome = 'enemy_win'; assert.equal(calculateProposedScore(state), 7600, 'non-winners do not get time points');
  state.actors.P1.deathCount = 1000; assert.equal(calculateProposedScore(state), 0);
  state.outcome = 'player_win'; assert.equal(calculateProposedScore(state), 100000, 'death penalty does not reduce the victory base');
});
