import { SUPPLY_BAG, type CaseType } from './cases.ts';
export const MATCH_PRESETS = {
  standard: { label: '標準', description: '標準の補給と仕事配分。', allocation: SUPPLY_BAG, priority: 'balanced', route: 'direct' },
  heavy: { label: '重量砲撃', description: '重量弾と貫通杭を多く運び、迂回砲撃を重視。', allocation: ['dense_payload','dense_payload','dense_payload','breach_lance','breach_lance','standard_slug','standard_slug','fast_dart'], priority: 'artillery', route: 'detour' },
  interception: { label: '迎撃重視', description: '防護板を優先して運び、見えている敵弾の経路へ発射。', allocation: ['screen_panel','screen_panel','screen_panel','breach_lance','breach_lance','standard_slug','standard_slug','fast_dart'], priority: 'interception', route: 'direct' },
  invasion: { label: '侵入重視', description: '既存の侵入担当が前進を優先し、通路妨害を運ぶ。', allocation: ['adhesive_pod','adhesive_pod','adhesive_pod','disruption_pack','disruption_pack','standard_slug','standard_slug','fast_dart'], priority: 'invasion', route: 'direct' },
  repair: { label: '修理防衛', description: '内部兵の一人が現物を修理へ回し、損傷した設備と外装を守る。', allocation: ['standard_slug','standard_slug','standard_slug','screen_panel','screen_panel','disruption_pack','disruption_pack','fast_dart'], priority: 'repair', route: 'direct' },
  mixed: { label: '混合作戦', description: '分裂・妨害・貫通を組み合わせ、迂回経路も使う。', allocation: ['split_payload','split_payload','split_payload','disruption_pack','disruption_pack','breach_lance','breach_lance','adhesive_pod'], priority: 'balanced', route: 'detour' },
} as const satisfies Record<string, { label: string; description: string; allocation: readonly CaseType[]; priority: string; route: 'direct' | 'detour' }>;
export type MatchPreset = keyof typeof MATCH_PRESETS;
export const DIFFICULTIES = { easy: { label: '易しい', decisionTicks: 54 }, standard: { label: '標準', decisionTicks: 36 }, hard: { label: '難しい', decisionTicks: 18 } } as const;
export type Difficulty = keyof typeof DIFFICULTIES;
export function validateMatchOptions(preset: string, difficulty: string): { preset: MatchPreset; difficulty: Difficulty } {
  if (!Object.hasOwn(MATCH_PRESETS, preset) || !Object.hasOwn(DIFFICULTIES, difficulty)) throw new Error('Unknown match configuration');
  return { preset: preset as MatchPreset, difficulty: difficulty as Difficulty };
}
