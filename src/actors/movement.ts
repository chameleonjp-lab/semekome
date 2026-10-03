import rules from "../../docs/plans/current/INITIAL_RULES.json" with { type: "json" };
export const FLOOR_SUBUNITS = 1000;
export const ACTOR_RADIUS_SUBUNITS = 280;
export const ACTOR_SPEED_UNITS_PER_SECOND = rules.actor.floor_speed_units_per_second;
export const ACTOR_SPEED_SUBUNITS_PER_TICK = ACTOR_SPEED_UNITS_PER_SECOND * FLOOR_SUBUNITS / rules.simulation.ticks_per_second;

export function cellCenter(cell: number): number {
  return cell * FLOOR_SUBUNITS + FLOOR_SUBUNITS / 2;
}

export function floorCell(position: number): number {
  return Math.floor(position / FLOOR_SUBUNITS);
}
