export const ARTILLERY_ROUTES = ["direct", "detour"] as const;
export type ArtilleryRoute = (typeof ARTILLERY_ROUTES)[number];
export const ROUTE_LENGTH_UNITS: Record<ArtilleryRoute, number> = {
  direct: 120,
  detour: 156,
};
export const SHARED_LAUNCH_COOLDOWN_TICKS = 48;
export const MAX_FLIGHT_COUNT = 96;

export function routeLength(route: ArtilleryRoute): number {
  return ROUTE_LENGTH_UNITS[route];
}
