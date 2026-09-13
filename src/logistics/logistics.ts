export const SUPPLY_PORT_COUNT = 4;
export const SUPPLY_PERIOD_TICKS = 210;
export const SUPPLY_FIRST_DELAY_TICKS = [30, 82, 135, 187] as const;
export const FLOOR_CASE_LIMIT_PER_ROOM = 16;
/** Live source groups per vehicle (all four ports combined). */
export const SUPPLY_GROUP_LIMIT_PER_SOURCE_TEAM = 48;
export const MAX_CARRY_SLOTS = 2;
export const MAX_CARRY_WEIGHT = 3;
export const WEIGHT_THREE_SPEED_MULTIPLIER = 0.85;
export const STAGING_SLOTS_PER_TURRET = 2;
export const QUEUE_CAPACITY_PER_TURRET = 2;

export function carryingSpeedMultiplier(totalWeight: number): number {
  return totalWeight >= 3 ? WEIGHT_THREE_SPEED_MULTIPLIER : 1;
}

export function canCarry(totalWeight: number, addedWeight: number, slots: number): boolean {
  return slots < MAX_CARRY_SLOTS && totalWeight + addedWeight <= MAX_CARRY_WEIGHT;
}
