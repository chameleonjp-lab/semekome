export const SUPPORT_TYPES = ['carrier', 'interceptor', 'mechanic'] as const;
export type SupportType = typeof SUPPORT_TYPES[number];
export const SUPPORT_LABELS: Record<SupportType, string> = {
  carrier: '運搬型：補給と砲撃を優先', interceptor: '迎撃型：敵弾と同じ経路を優先', mechanic: '整備型：損傷時は修理を優先',
};
export function validateSupportTypes(types: readonly string[]): [SupportType, SupportType] {
  if (types.length !== 2 || types.some(type => !SUPPORT_TYPES.includes(type as SupportType))) throw new Error('Select two support types');
  return [...types] as [SupportType, SupportType];
}
