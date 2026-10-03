import { DEFAULT_RULES } from "../content/rules.ts";
export const SUPPLY_PORT_COUNT = 4;
export const SUPPLY_PERIOD_TICKS = 210;
export const SUPPLY_FIRST_DELAY_TICKS = [30, 82, 135, 187] as const;
export const FLOOR_CASE_LIMIT_PER_ROOM = 16;
/** Live source groups per vehicle (all four ports combined). */
export const SUPPLY_GROUP_LIMIT_PER_SOURCE_TEAM = 48;
export const MAX_CARRY_SLOTS = DEFAULT_RULES.maxCarrySlots;
/** Deprecated: weight no longer restricts pickup. */
export const MAX_CARRY_WEIGHT = Number.POSITIVE_INFINITY;
export const WEIGHT_THREE_SPEED_MULTIPLIER = 1;
export const STAGING_SLOTS_PER_TURRET = 2;
export const QUEUE_CAPACITY_PER_TURRET = 2;

export function carryingSpeedMultiplier(totalWeight: number): number {
  return 1; // Carrying capacity and movement are count-based, independent of weight.
}

export function canCarry(totalWeight: number, addedWeight: number, slots: number): boolean {
  return Number.isInteger(slots) && slots >= 0 && slots < MAX_CARRY_SLOTS;
}
