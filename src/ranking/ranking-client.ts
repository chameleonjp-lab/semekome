import { validatePlayerName } from '../input/session-clock.ts';
export interface RankingConfig { endpoint: string; publishableKey: string; gameSlug: string; clientVersion: string; scoreMin: number; scoreMax: number }
export type SubmissionStatus = 'idle' | 'submitting' | 'submitted' | 'retryable_failed' | 'permanent_failed';
export interface RankingResult { resultType: 'clear' | 'game_over' | 'retire'; reached: number; score: number; ranked: boolean }
interface PendingPlay { version: 1; startId: string; playId?: string; submissionId?: string; name: string; gameSlug: string; clientVersion: string; result?: RankingResult; finished: boolean; submitted: boolean }
interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface RankingRow { rank_no: number; display_name: string; best_score: number; play_count: number; best_score_at: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = 'semekome-pending-ranking-v1';
const integer = (value: unknown) => Number.isSafeInteger(value);
class RankingError extends Error { readonly retryable: boolean; constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; } }
export function createRankingClient(config: RankingConfig, storage: Storage, fetchImpl = globalThis.fetch.bind(globalThis)) {
  let keyIsPublic = config.publishableKey.startsWith('sb_publishable_');
  if (!keyIsPublic) { try { keyIsPublic = JSON.parse(atob(config.publishableKey.split('.')[1])).role === 'anon'; } catch {} }
  if (!keyIsPublic) throw new Error('Only a publishable or anon key may be used');
  if (!/^https:\/\/[^/]+\/rest\/v1\/?$/.test(config.endpoint) || !config.publishableKey || !config.gameSlug || !config.clientVersion || !integer(config.scoreMin) || !integer(config.scoreMax) || config.scoreMin > config.scoreMax) throw new Error('Unverified ranking configuration');
  let status: SubmissionStatus = 'idle';
  let busy: Promise<void> | undefined;
  const validateResult = (value: RankingResult) => {
    if (!['clear','game_over','retire'].includes(value.resultType) || !integer(value.reached) || value.reached < 0 || value.reached > 7 || !integer(value.score) || value.score < config.scoreMin || value.score > config.scoreMax || typeof value.ranked !== 'boolean' || value.resultType === 'retire' && value.ranked) throw new RankingError('Invalid fixed result', false);
  };
  const load = (): PendingPlay | undefined => {
    const raw = storage.getItem(KEY); if (!raw) return;
    try {
      if (raw.length > 20_000) throw new Error('Oversized record');
      const value = JSON.parse(raw) as PendingPlay;
      if (value.version !== 1 || !UUID.test(value.startId) || value.playId && !UUID.test(value.playId) || value.submissionId && !UUID.test(value.submissionId) || validatePlayerName(value.name).error || value.gameSlug !== config.gameSlug || value.clientVersion !== config.clientVersion || typeof value.finished !== 'boolean' || typeof value.submitted !== 'boolean' || value.finished && (!value.playId || !value.result) || value.submitted && !value.finished) throw new Error('Invalid pending record');
      if (value.result) { validateResult(value.result); if (!value.submissionId) throw new Error('Missing submission'); }
      return value;
    } catch { throw new RankingError('Pending record needs review; it was retained', false); }
  };
  const save = (play: PendingPlay) => { storage.setItem(KEY, JSON.stringify(play)); };
  async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const headers: Record<string, string> = { apikey: config.publishableKey, 'Content-Type': 'application/json' };
      if (!config.publishableKey.startsWith('sb_publishable_')) headers.Authorization = `Bearer ${config.publishableKey}`;
      const response = await fetchImpl.call(globalThis, `${config.endpoint.replace(/\/$/, '')}/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args), signal: controller.signal });
      const raw = await response.text(); if (raw.length > 100_000) throw new RankingError('Oversized response', false);
      let data: any; try { data = JSON.parse(raw); } catch { throw new RankingError('Invalid response', true); }
      if (!response.ok) throw new RankingError(typeof data.code === 'string' ? data.code : 'RPC rejected', [408,425,429].includes(response.status) || response.status >= 500 || typeof data.message === 'string' && /rate limit/i.test(data.message));
      if (data?.accepted === false) throw new RankingError(String(data.reason ?? 'Rejected'), /rate_limit/.test(String(data.reason)));
      return data;
    } catch (error) { if (error instanceof RankingError) throw error; throw new RankingError('Network or timeout failure', true); }
    finally { clearTimeout(timer); }
  }
  async function sync() {
    if (busy) return busy;
    busy = (async () => {
      try {
        const play = load(); if (!play) { status = 'idle'; return; } if (play.submitted) { status = 'submitted'; return; }
        status = 'submitting';
        const common = { p_display_name: play.name, p_game_slug: play.gameSlug, p_client_version: play.clientVersion };
        if (!play.playId) {
          const result = await rpc('start_game_play_v1', { ...common, p_start_id: play.startId });
          if (result.accepted !== true || !UUID.test(result.play_id) || result.start_id !== play.startId || result.game_slug !== play.gameSlug || result.display_name !== play.name || result.client_version !== play.clientVersion) throw new RankingError('Start response mismatch', false);
          play.playId = result.play_id; save(play);
        }
        if (!play.result) { status = 'idle'; return; }
        if (!play.finished) {
          // The shared service accepts waves 1..30; our 0..7 opened gates map to 1..8.
          const reachedWave = play.result.reached + 1;
          const result = await rpc('finish_game_play_v1', { ...common, p_play_id: play.playId, p_result_type: play.result.resultType, p_reached_wave: reachedWave, p_score: play.result.score, p_ranking_score: null });
          if (result.accepted !== true || result.play_id !== play.playId || result.game_slug !== play.gameSlug || result.result_type !== play.result.resultType || result.reached_wave !== reachedWave || result.score !== play.result.score) throw new RankingError('Finish response mismatch', false);
          play.finished = true; save(play);
        }
        if (play.result.ranked) {
          const rows = await rpc('submit_score_idempotent_v1', { ...common, p_play_id: play.playId, p_submission_id: play.submissionId, p_score: play.result.score });
          const result = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
          if (!result || result.accepted !== true || result.result_play_id !== play.playId || result.result_submission_id !== play.submissionId || result.result_display_name !== play.name || !integer(result.result_best_score) || result.result_best_score < play.result.score || result.result_best_score > config.scoreMax || !integer(result.result_first_score) || result.result_first_score < config.scoreMin || result.result_first_score > config.scoreMax || !integer(result.result_play_count) || result.result_play_count < 1 || typeof result.was_duplicate !== 'boolean') throw new RankingError('Submission response mismatch', false);
        }
        play.submitted = true; save(play); status = 'submitted';
      } catch (error) { status = error instanceof RankingError && !error.retryable ? 'permanent_failed' : 'retryable_failed'; throw error; }
    })();
    try { await busy; } finally { busy = undefined; }
  }
  const locked = async <T>(operation: () => Promise<T>): Promise<T> => typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.request(KEY, operation) : await operation();
  return {
    get status() { return status; },
    pending() { return structuredClone(load()); },
    begin: (name: string) => locked(async () => {
      if (busy) throw new Error('Synchronization in progress');
      const existing = load(); if (existing && !existing.submitted) throw new Error('Pending play must finish before another ranked play');
      const validated = validatePlayerName(name); if (validated.error) throw new Error(validated.error);
      save({ version: 1, startId: crypto.randomUUID(), name: validated.name, gameSlug: config.gameSlug, clientVersion: config.clientVersion, finished: false, submitted: false });
      await sync();
    }),
    finish: (result: RankingResult) => locked(async () => {
      if (busy) await busy;
      validateResult(result); const play = load(); if (!play) throw new Error('No accepted or pending start');
      if (play.result && (play.result.resultType !== result.resultType || play.result.reached !== result.reached || play.result.score !== result.score || play.result.ranked !== result.ranked)) throw new Error('Fixed result conflict');
      if (!play.result) { play.result = structuredClone(result); play.submissionId = crypto.randomUUID(); save(play); }
      await sync();
    }),
    sync: () => locked(sync),
    async topTen(): Promise<RankingRow[]> {
      const rows = await rpc('get_game_ranking', { p_game_slug: config.gameSlug, p_limit: 10 });
      if (!Array.isArray(rows) || rows.length > 10 || rows.some(row => !integer(row.rank_no) || row.rank_no < 1 || typeof row.display_name !== 'string' || validatePlayerName(row.display_name).error || !integer(row.best_score) || row.best_score < config.scoreMin || row.best_score > config.scoreMax || !integer(row.play_count) || row.play_count < 1 || typeof row.best_score_at !== 'string' || !Number.isFinite(Date.parse(row.best_score_at)))) throw new RankingError('Ranking response mismatch', false);
      return rows;
    },
  };
}
