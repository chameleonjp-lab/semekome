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

/**
 * Validate the player-facing eight-case loadout.
 *
 * A loadout selects exactly four distinct case types. Each selected type is
 * assigned one to three entries, and the resulting cycle always contains
 * eight entries. Keeping this check at the schedule boundary prevents a UI
 * or replay caller from bypassing the allocation contract.
 */
export function validateSupplyAllocation(allocation: readonly CaseType[]): CaseType[] {
  if (allocation.length !== 8) throw new RangeError("supply allocation must contain exactly eight cases");
  const knownTypes = new Set<string>(CASE_TYPES);
  if (allocation.some((type) => !knownTypes.has(type))) throw new RangeError("supply allocation contains an unknown case type");
  const counts = new Map<CaseType, number>();
  for (const type of allocation) counts.set(type, (counts.get(type) ?? 0) + 1);
  if (counts.size !== 4) throw new RangeError("supply allocation must contain exactly four case types");
  if ([...counts.values()].some((count) => count < 1 || count > 3)) {
    throw new RangeError("supply allocation counts must be between one and three");
  }
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
  const allocation = validateSupplyAllocation(options.allocation ?? SUPPLY_BAG);
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
 * Preview at most the two entries exposed to the player before they spawn.
 * The cursor advances across a cycle boundary in the returned view but does
 * not mutate the schedule.
 */
export function previewSupplyTypes(schedule: SupplySchedule, count = 2): CaseType[] {
  if (!Number.isInteger(count) || count < 0 || count > 2) {
    throw new RangeError("supply preview count must be between zero and two");
  }
  const preview: CaseType[] = [];
  let cursor = schedule;
  for (let index = 0; index < count; index += 1) {
    preview.push(currentSupplyType(cursor));
    cursor = advanceSupplySchedule(cursor);
  }
  return preview;
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
