import type { BattleState } from '../simulation/physical-battle.ts';
import { projectBattleResultMetrics } from '../presentation/battle-result-metrics.ts';
export const SCORE_VERSION = 'semekome-score-v5-1';
/** The release score is independent of network availability. */
export function calculateBattleScore(state: BattleState): number {
  if (state.phase !== 'ended' || state.outcome === 'ongoing') throw new Error('Score requires a terminal battle');
  const metrics = projectBattleResultMetrics(state);
  const win = state.outcome === 'player_win';
  const remaining = win ? Math.max(0, Math.floor(420 - state.tick / 60)) : 0;
  return (win ? 100_000 : 0) + Math.max(0, state.castles.enemy.destroyedPartIds.length * 1000 +
    metrics.enemyUniqueDefeats * 20 + remaining * 10 - metrics.playerDeaths * 100);
}
