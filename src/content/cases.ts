/**
 * The authored catalog has eight case identities.  The default R2a supply bag
 * still selects the four ordinary cases from the initial loadout; the three
 * effect cases are nevertheless compiled here so a selected loadout and the
 * physical artillery path use the same identity as the common rule catalog.
 */
export const CASE_TYPES = [
  "standard_slug", "dense_payload", "screen_panel", "fast_dart",
  "split_payload", "disruption_pack", "breach_lance", "adhesive_pod",
] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export type CaseEffect =
  | { kind: "none" }
  | { kind: "split"; children: 3; childInterceptHits: 1; childSpeedUnitsPerSecond: 16; spacingRouteUnits: 2; childPartDamage: 4 }
  | { kind: "disrupt"; durationTicks: 360; immunityTicks: 240 }
  | { kind: "slow"; durationTicks: 240; multiplier: 0.65; radiusFloorUnits: 1 };

export interface CaseDefinition {
  type: CaseType;
  weight: 1 | 2;
  interceptHits: number;
  flightSpeedUnitsPerSecond: number;
  partDamage: number;
  effect: CaseEffect;
}

export const CASE_DEFINITIONS: Record<CaseType, CaseDefinition> = {
  standard_slug: {
    type: "standard_slug",
    weight: 1,
    interceptHits: 1,
    flightSpeedUnitsPerSecond: 20,
    partDamage: 14,
    effect: { kind: "none" },
  },
  dense_payload: {
    type: "dense_payload",
    weight: 2,
    interceptHits: 2,
    flightSpeedUnitsPerSecond: 12,
    partDamage: 30,
    effect: { kind: "none" },
  },
  screen_panel: {
    type: "screen_panel",
    weight: 1,
    interceptHits: 3,
    flightSpeedUnitsPerSecond: 9,
    partDamage: 0,
    effect: { kind: "none" },
  },
  fast_dart: {
    type: "fast_dart",
    weight: 1,
    interceptHits: 1,
    flightSpeedUnitsPerSecond: 28,
    partDamage: 8,
    effect: { kind: "none" },
  },
  split_payload: {
    type: "split_payload",
    weight: 1,
    interceptHits: 1,
    flightSpeedUnitsPerSecond: 16,
    partDamage: 12,
    effect: {
      kind: "split",
      children: 3,
      childInterceptHits: 1,
      childSpeedUnitsPerSecond: 16,
      spacingRouteUnits: 2,
      childPartDamage: 4,
    },
  },
  disruption_pack: {
    type: "disruption_pack",
    weight: 1,
    interceptHits: 1,
    flightSpeedUnitsPerSecond: 18,
    partDamage: 6,
    effect: { kind: "disrupt", durationTicks: 360, immunityTicks: 240 },
  },
  breach_lance: {
    type: "breach_lance",
    weight: 2,
    interceptHits: 3,
    flightSpeedUnitsPerSecond: 10,
    partDamage: 18,
    effect: { kind: "none" },
  },
  adhesive_pod: {
    type: "adhesive_pod",
    weight: 1,
    interceptHits: 1,
    flightSpeedUnitsPerSecond: 14,
    partDamage: 4,
    effect: { kind: "slow", durationTicks: 240, multiplier: 0.65, radiusFloorUnits: 1 },
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
