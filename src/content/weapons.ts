import source from "../../docs/plans/current/ORIGINAL_CASES.json" with { type: "json" };
import rules from "../../docs/plans/current/INITIAL_RULES.json" with { type: "json" };

export type WeaponEffect =
  | { kind: "split"; children: number; durability: number; speed: number; damage: number; spacing: number }
  | { kind: "disrupt"; duration: number; immunity: number }
  | { kind: "slow"; duration: number; multiplier: number; radius: number };

export interface WeaponDefinition {
  id: string;
  name: string;
  weight: number;
  durability: number;
  speed: number;
  damage: number;
  effects: WeaponEffect[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid weapon record");
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 100_000) {
    throw new Error("invalid weapon integer");
  }
  return value;
}
function positive(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) throw new Error("invalid weapon ratio/radius");
  return value;
}

/** IDs describe content, not executable branches. Unknown effects fail closed. */
export function compileWeapons(rows: readonly unknown[]): Record<string, WeaponDefinition> {
  const catalog: Record<string, WeaponDefinition> = Object.create(null);
  for (const row of rows) {
    const raw = record(row);
    if (typeof raw.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(raw.id) || raw.id === "constructor" || catalog[raw.id]) throw new Error("invalid/duplicate weapon id");
    if (typeof raw.name_ja !== "string" || !raw.name_ja.trim()) throw new Error("missing weapon name");
    const weapon: WeaponDefinition = {
      id: raw.id, name: raw.name_ja, weight: integer(raw.weight),
      durability: integer(raw.intercept_hits), speed: integer(raw.flight_speed),
      damage: integer(raw.part_damage, 0), effects: [],
    };
    if (weapon.weight > rules.actor.carry_weight_limit) throw new Error("uncarryable weapon");
    switch (raw.effect) {
      case "none": break;
      case "split_once_after_midpoint": {
        const split = record(raw.split);
        const effect: WeaponEffect = {
          kind: "split", children: integer(split.children), durability: integer(split.child_intercept_hits),
          speed: integer(split.child_speed), damage: integer(split.child_part_damage, 0), spacing: integer(split.spacing_route_units),
        };
        if (effect.children < 2 || effect.children > rules.limits.projectiles_total || effect.children * effect.damage !== weapon.damage) throw new Error("split must conserve damage");
        weapon.effects.push(effect);
        break;
      }
      case "disable_enemy_supply_6s_then_immunity_4s":
        weapon.effects.push({ kind: "disrupt", duration: rules.supply.disruption_duration_ticks, immunity: rules.supply.disruption_immunity_after_end_ticks });
        break;
      case "slow_zone_at_enemy_entry": {
        const zone = record(raw.zone);
        if (zone.affects !== "all_actors" || zone.max_per_team !== 1 || zone.refresh_policy !== "replace_previous") throw new Error("unsupported slow policy");
        weapon.effects.push({ kind: "slow", duration: integer(zone.duration_ticks), multiplier: positive(zone.speed_multiplier, 1), radius: positive(zone.radius_floor_units, 10) });
        break;
      }
      default: throw new Error(`unsupported weapon effect: ${String(raw.effect)}`);
    }
    catalog[weapon.id] = weapon;
  }
  return catalog;
}

export const WEAPONS = compileWeapons(source.cases);
export const COMBAT_RULES = {
  routeLengths: rules.cannon.route_length_units,
  cooldown: {
    player: rules.cannon.team_profiles.player.vehicle_launch_cooldown_ticks,
    enemy: rules.cannon.team_profiles.enemy.vehicle_launch_cooldown_ticks,
  },
  projectileLimit: rules.limits.projectiles_total,
  actionRange: rules.actor.action_range_units,
  carryWeight: rules.actor.carry_weight_limit,
  heavyMultiplier: rules.actor.weight_3_speed_multiplier,
} as const;
