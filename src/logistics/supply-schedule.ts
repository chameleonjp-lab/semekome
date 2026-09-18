import { CASE_TYPES, SUPPLY_BAG, type CaseType } from "../content/cases.ts";
import type { TeamId } from "../domain/types.ts";

const PLAYER_SCHEDULE_SALT = 0xc2b2ae35;
const ENEMY_SCHEDULE_SALT = 0x85ebca6b;
const CYCLE_SALT = 0x9e3779b9;

function xorshift32(value: number): number {
  let next = value >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function normaliseSeed(seed: number): number {
  if (!Number.isFinite(seed)) throw new RangeError("supply schedule seed must be finite");
  const value = Math.trunc(seed) >>> 0;
  return value === 0 ? 1 : value;
}

function validateTeam(team: TeamId): void {
  if (team !== "player" && team !== "enemy") throw new RangeError("supply schedule team is invalid");
}

function validateAllocation(allocation: readonly CaseType[]): CaseType[] {
  if (allocation.length !== 8) throw new RangeError("supply allocation must contain exactly eight cases");
  const knownTypes = new Set<string>(CASE_TYPES);
  if (allocation.some((type) => !knownTypes.has(type))) throw new RangeError("supply allocation contains an unknown case type");
  return [...allocation];
}

function shuffledAllocation(seed: number, team: TeamId, cycle: number, allocation: readonly CaseType[]): CaseType[] {
  let random = (normaliseSeed(seed) ^ (team === "enemy" ? ENEMY_SCHEDULE_SALT : PLAYER_SCHEDULE_SALT) ^ Math.imul(cycle + 1, CYCLE_SALT)) >>> 0;
  const order = [...allocation];
  for (let index = order.length - 1; index > 0; index -= 1) {
    random = xorshift32(random || 1);
    const swapIndex = random % (index + 1);
    [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
  }
  return order;
}

/**
 * One shared, deterministic schedule for a source vehicle.  The physical
 * coordinator owns the actual floor object and calls advance only after the
 * common `spawn_supply` transition has accepted it.
 */
export interface SupplySchedule {
  seed: number;
  team: TeamId;
  cycle: number;
  index: number;
  allocation: readonly CaseType[];
  order: readonly CaseType[];
}

export interface CreateSupplyScheduleOptions {
  seed: number;
  team: TeamId;
  cycle?: number;
  allocation?: readonly CaseType[];
}

export function createSupplySchedule(options: CreateSupplyScheduleOptions): SupplySchedule {
  validateTeam(options.team);
  const cycle = options.cycle ?? 0;
  if (!Number.isInteger(cycle) || cycle < 0) throw new RangeError("supply schedule cycle must be a non-negative integer");
  const allocation = validateAllocation(options.allocation ?? SUPPLY_BAG);
  const seed = normaliseSeed(options.seed);
  return {
    seed,
    team: options.team,
    cycle,
    index: 0,
    allocation,
    order: shuffledAllocation(seed, options.team, cycle, allocation),
  };
}

/** Return the schedule entry that is waiting for a successful spawn. */
export function currentSupplyType(schedule: SupplySchedule): CaseType {
  const type = schedule.order[schedule.index];
  if (!type) throw new RangeError("supply schedule cursor is outside its order");
  return type;
}

/**
 * Consume exactly one successful entry.  Calling code must not advance this
 * cursor for a blocked port, a full room, a stopped device, or a rejected
 * common-world transition.
 */
export function advanceSupplySchedule(schedule: SupplySchedule): SupplySchedule {
  currentSupplyType(schedule);
  const nextIndex = schedule.index + 1;
  if (nextIndex < schedule.order.length) return { ...schedule, index: nextIndex };
  return createSupplySchedule({
    seed: schedule.seed,
    team: schedule.team,
    cycle: schedule.cycle + 1,
    allocation: schedule.allocation,
  });
}

/** Build one cycle without exposing the mutable schedule cursor. */
export function supplyBagForCycle(
  seed: number,
  team: TeamId,
  cycle = 0,
  allocation: readonly CaseType[] = SUPPLY_BAG,
): CaseType[] {
  return [...createSupplySchedule({ seed, team, cycle, allocation }).order];
}
