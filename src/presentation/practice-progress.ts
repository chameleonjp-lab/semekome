import type { BattleState } from '../simulation/physical-battle.ts';
export const PRACTICES = {
  transport: { label: '運搬と砲撃', description: '床の弾を拾い、砲台へ装填して操作位置から発射します。' },
  interception: { label: '迎撃', description: '防護板などを敵弾と同じ経路へ発射し、弾同士を接触させます。' },
  core: { label: '7部位・7門とコア', description: '7部位を破壊して7門を順に越え、敵コアへ射撃します。' },
} as const;
export type Practice = keyof typeof PRACTICES;
export function createPracticeProgress(practice: Practice) {
  const launched = new Set<string>();
  let complete = false;
  return { observe(state: BattleState): boolean {
    for (const event of state.lastStep.events) {
      if (event.type === 'projectile_launched' && event.sourceActorId === 'P1') {
        launched.add(event.projectileId);
        if (practice === 'transport') complete = true;
      }
      if (practice === 'interception' && event.type === 'projectile_intercepted' &&
          (launched.has(event.firstProjectileId) || launched.has(event.secondProjectileId))) complete = true;
    }
    if (practice === 'core' && state.outcome === 'player_win' && state.castles.enemy.destroyedPartIds.length === 7 &&
        state.castles.enemy.openGateIds.length === 7 && state.actors.P1.location.pathGates.length === 7 && state.castles.enemy.core.hit && state.lastStep.events.some(event => event.type === "core_hit_candidate" && event.attackerId === "P1" && event.targetTeam === "enemy")) complete = true;
    return complete;
  } };
}
