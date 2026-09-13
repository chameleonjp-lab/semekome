export const FLOOR_SUBUNITS = 1000;
export const ACTOR_RADIUS_SUBUNITS = 280;
export const ACTOR_SPEED_UNITS_PER_SECOND = 3;
export const ACTOR_SPEED_SUBUNITS_PER_TICK = 50;

export function cellCenter(cell: number): number {
  return cell * FLOOR_SUBUNITS + FLOOR_SUBUNITS / 2;
}

export function floorCell(position: number): number {
  return Math.floor(position / FLOOR_SUBUNITS);
}
