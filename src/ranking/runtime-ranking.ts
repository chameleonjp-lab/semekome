import manifest from '../../ranking-manifest.json';
import { createRankingClient, type RankingConfig } from './ranking-client.ts';
import { SCORE_PROPOSAL_VERSION } from './score-proposal.ts';
export interface RankingRuntime { client: ReturnType<typeof createRankingClient>; canonicalUrl: string; labUrl?: string }
/** Activation is deliberately impossible with the current unregistered manifest. */
export function loadRankingRuntime(): RankingRuntime | undefined {
  const value = manifest as unknown as { status: string; game_id: string; client_version: string; canonical_url: string; lab: { representative_slug: string; base_url: string }; score_proposal: { approved: boolean; version: string; min: number; max: number } };
  if (value.status !== 'registered_and_approved' || !value.score_proposal.approved || value.score_proposal.version !== SCORE_PROPOSAL_VERSION || !value.game_id || !value.client_version || !value.lab.representative_slug || !value.canonical_url) return;
  try {
    const url = new URL(value.canonical_url); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return;
    const lab = new URL('ranking.html', value.lab.base_url); if (lab.protocol !== 'https:' || lab.username || lab.password) return;
    lab.searchParams.set('game',value.lab.representative_slug);
    const config: RankingConfig = { endpoint: import.meta.env.VITE_SUPABASE_REST_ENDPOINT, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      gameSlug: value.lab.representative_slug, clientVersion: value.client_version, scoreMin: value.score_proposal.min, scoreMax: value.score_proposal.max };
    return { client: createRankingClient(config, localStorage), canonicalUrl: url.href, labUrl: lab.href };
  } catch { return; }
}
