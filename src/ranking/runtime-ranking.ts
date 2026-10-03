import manifest from '../../ranking-manifest.json' with { type: 'json' };
import { createRankingClient } from './ranking-client.ts';
export interface RankingRuntime { client: ReturnType<typeof createRankingClient>; canonicalUrl: string; labUrl?: string }
export function loadRankingRuntime(): RankingRuntime | undefined {
  // Owner-requested suspension (2026-10-03). This precedes configuration,
  // client creation and localStorage access: pending plays are retained and
  // never retried. Re-enable only after an explicit owner instruction.
  if (rankingSuspended()) return;
  // Connection code remains for a separately reviewed future resumption.
  // Local development stays offline unless the public connection is configured.
  if (!import.meta.env.VITE_SUPABASE_REST_ENDPOINT || !import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) return;
  try {
    const entry = manifest.ranking_entries.find(entry => entry.game_slug === manifest.lab.representative_slug);
    if (!entry) return;
    const url = new URL(manifest.canonical_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return;
    const lab = new URL('https://chameleonjp-lab.github.io/chameleonjp_lab/ranking.html');
    lab.searchParams.set('game', entry.game_slug);
    return {
      client: createRankingClient({
        endpoint: import.meta.env.VITE_SUPABASE_REST_ENDPOINT,
        publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        gameSlug: entry.game_slug,
        clientVersion: manifest.client_version,
        scoreMin: entry.score_min,
        scoreMax: entry.score_max,
      }, localStorage),
      canonicalUrl: url.href,
      labUrl: lab.href,
    };
  } catch { return; }
}

// No environment variable or saved preference may resume a user-requested stop.
function rankingSuspended(): boolean { return true; }
