import rawInitialRules from "../../docs/plans/current/INITIAL_RULES.json" with { type: "json" };
import type { RulesConfig } from "../domain/types.ts";

type InitialRulesShape = {
  ruleset_id?: string;
  simulation?: { ticks_per_second?: number; match_limit_ticks?: number };
  actor?: {
    health?: number;
    dash_distance_units?: number;
    dash_duration_ticks?: number;
    dash_cooldown_ticks?: number;
    dash_actor_damage?: number;
    dash_equipment_damage?: number;
    dash_knockback_units?: number;
    damage_invulnerability_ticks?: number;
    spawn_protection_ticks?: number;
    carry_slots?: number;
  };
  exterior?: {
    parts?: Array<{ max_health?: number }>;
    repair_budget_per_team?: number;
    repair_per_crate?: number;
    repair_work_ticks?: number;
  };
  equipment?: {
    health?: number;
    disabled_ticks?: number;
    repair_work_ticks?: number;
    manual_restore_health?: number;
  };
  team_profiles?: {
    player?: { respawn_ticks?: number };
    enemy?: { respawn_ticks?: number };
  };
};

const source = rawInitialRules as InitialRulesShape;

const positiveInteger = (value: number | undefined, fallback: number): number => {
  if (!Number.isInteger(value) || value === undefined || value <= 0) return fallback;
  return value;
};

const positiveNumber = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return value;
};

export const DEFAULT_RULES: RulesConfig = {
  rulesetId: source.ruleset_id ?? "semekome-prototype-0.4-facing-castles",
  ticksPerSecond: positiveInteger(source.simulation?.ticks_per_second, 60),
  matchLimitTicks: positiveInteger(source.simulation?.match_limit_ticks, 25_200),
  actorHealth: positiveNumber(source.actor?.health, 4),
  dashDistanceSubunits: Math.round(positiveNumber(source.actor?.dash_distance_units, 1.2) * 1_000),
  dashDurationTicks: positiveInteger(source.actor?.dash_duration_ticks, 12),
  dashCooldownTicks: positiveInteger(source.actor?.dash_cooldown_ticks, 54),
  dashActorDamage: positiveNumber(source.actor?.dash_actor_damage, 1),
  dashEquipmentDamage: positiveNumber(source.actor?.dash_equipment_damage, 10),
  dashKnockbackSubunits: Math.round(positiveNumber(source.actor?.dash_knockback_units, 0.6) * 1_000),
  equipmentHealth: positiveNumber(source.equipment?.health, 60),
  equipmentDisabledTicks: positiveInteger(source.equipment?.disabled_ticks, 480),
  equipmentRepairWorkTicks: positiveInteger(source.equipment?.repair_work_ticks, 120),
  equipmentRepairHealth: positiveNumber(source.equipment?.manual_restore_health, 60),
  playerRespawnTicks: positiveInteger(source.team_profiles?.player?.respawn_ticks, 300),
  enemyRespawnTicks: positiveInteger(source.team_profiles?.enemy?.respawn_ticks, 1_200),
  spawnProtectionTicks: positiveInteger(source.actor?.spawn_protection_ticks, 60),
  damageInvulnerabilityTicks: positiveInteger(source.actor?.damage_invulnerability_ticks, 36),
  exteriorPartHealth: positiveNumber(source.exterior?.parts?.[0]?.max_health, 50),
  repairBudget: positiveNumber(source.exterior?.repair_budget_per_team, 96),
  repairPerCase: positiveNumber(source.exterior?.repair_per_crate, 12),
  repairWorkTicks: positiveInteger(source.exterior?.repair_work_ticks, 90),
  maxCarrySlots: positiveInteger(source.actor?.carry_slots, 2),
};

export const TICKS_PER_SECOND = DEFAULT_RULES.ticksPerSecond;
export const ENEMY_RESPAWN_TICKS = DEFAULT_RULES.enemyRespawnTicks;
export const PLAYER_RESPAWN_TICKS = DEFAULT_RULES.playerRespawnTicks;
export const SPAWN_PROTECTION_TICKS = DEFAULT_RULES.spawnProtectionTicks;

export function makeRules(overrides: Partial<RulesConfig> = {}): RulesConfig {
  return { ...DEFAULT_RULES, ...overrides };
}
