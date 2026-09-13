/** The four ordinary R2a cases are the only cases produced by the supply bag. */
export const CASE_TYPES = ["standard_slug", "dense_payload", "screen_panel", "fast_dart"] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export interface CaseDefinition {
  type: CaseType;
  weight: 1 | 2;
  interceptHits: number;
  flightSpeedUnitsPerSecond: number;
  partDamage: number;
}

export const CASE_DEFINITIONS: Record<CaseType, CaseDefinition> = {
  standard_slug: {
    type: "standard_slug",
    weight: 1,
    interceptHits: 1,
    flightSpeedUnitsPerSecond: 20,
    partDamage: 14,
  },
  dense_payload: {
    type: "dense_payload",
    weight: 2,
    interceptHits: 2,
    flightSpeedUnitsPerSecond: 12,
    partDamage: 30,
  },
  screen_panel: {
    type: "screen_panel",
    weight: 1,
    interceptHits: 3,
    flightSpeedUnitsPerSecond: 9,
    partDamage: 0,
  },
  fast_dart: {
    type: "fast_dart",
    weight: 1,
    interceptHits: 1,
    flightSpeedUnitsPerSecond: 28,
    partDamage: 8,
  },
};

/** One deterministic eight-case bag: 3 standard, 2 dense, 2 screen, 1 fast. */
export const SUPPLY_BAG: readonly CaseType[] = [
  "standard_slug",
  "standard_slug",
  "standard_slug",
  "dense_payload",
  "dense_payload",
  "screen_panel",
  "screen_panel",
  "fast_dart",
];

export function caseDefinition(type: string): CaseDefinition | undefined {
  return CASE_DEFINITIONS[type as CaseType];
}
