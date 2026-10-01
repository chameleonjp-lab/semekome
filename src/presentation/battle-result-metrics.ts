import { ENEMY_ROSTER } from '../content/roster.ts';
import type { BattleState } from '../simulation/physical-battle.ts';

export interface BattleResultMetrics {
  /** Enemy deaths across the match, including repeat defeats by the player team. */
  readonly enemyDefeatsTotal: number;
  /** Fixed enemy roster members defeated at least once; at most 30. */
  readonly enemyUniqueDefeats: number;
  /** P1 deaths only; support actor deaths are separate. */
  readonly playerDeaths: number;
}

/** The bounded event log cannot reconstruct these lifetime counters or attribute defeats to P1. */
export function projectBattleResultMetrics(state: BattleState): BattleResultMetrics {
  let enemyDefeatsTotal = 0;
  let enemyUniqueDefeats = 0;
  for (const member of ENEMY_ROSTER) {
    const actor = state.actors[member.id];
    if (!actor || actor.id !== member.id || actor.team !== 'enemy') continue;
    enemyDefeatsTotal += actor.deathCount;
    if (actor.deathCount > 0) enemyUniqueDefeats += 1;
  }
  return { enemyDefeatsTotal, enemyUniqueDefeats, playerDeaths: state.actors.P1.deathCount };
}
