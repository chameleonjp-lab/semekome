import type { BattleState, FixedPoint } from "../simulation/physical-battle.ts";
import { GATE_IDS, type CastleLayout, type GateId, type Point, type TeamId } from "../domain/types.ts";
import { ACTOR_RADIUS_SUBUNITS, FLOOR_SUBUNITS } from "./movement.ts";

/**
 * These helpers are physical geometry only. Callers handling a case must
 * first enforce the actor and case share the same physical floorLocation;
 * a walkable point is not an ownership or interaction permission.
 */

/** The action range used by interaction and the approach-point helpers. */
export const ACTION_RANGE_SUBUNITS = 800;

/** Equipment body diameter in fixed subunits (0.6 floor units). */
export const EQUIPMENT_BODY_SIZE_SUBUNITS = 600;

/** A half-open rectangle in integer subunits. */
export interface FixedRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface LayoutGeometryIndex {
  floorCells: ReadonlySet<string>;
  gateCells: Record<GateId, ReadonlySet<string>>;
  equipmentRects: readonly FixedRect[];
}

const layoutIndexCache = new WeakMap<CastleLayout, LayoutGeometryIndex>();

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function fixedPointKey(point: FixedPoint): string {
  return `${point.x},${point.y}`;
}

function layoutForTeam(state: BattleState, team: TeamId): CastleLayout {
  return team === "player" ? state.layout.home : state.layout.enemy;
}

function rectForCell(cell: Point): FixedRect {
  return {
    x0: cell.x * FLOOR_SUBUNITS,
    y0: cell.y * FLOOR_SUBUNITS,
    x1: (cell.x + 1) * FLOOR_SUBUNITS,
    y1: (cell.y + 1) * FLOOR_SUBUNITS,
  };
}

/** Return the centered 0.6x0.6 equipment body for a layout cell. */
export function equipmentRectForCell(cell: Point): FixedRect {
  const centerX = cell.x * FLOOR_SUBUNITS + FLOOR_SUBUNITS / 2;
  const centerY = cell.y * FLOOR_SUBUNITS + FLOOR_SUBUNITS / 2;
  const halfSize = EQUIPMENT_BODY_SIZE_SUBUNITS / 2;
  return {
    x0: centerX - halfSize,
    y0: centerY - halfSize,
    x1: centerX + halfSize,
    y1: centerY + halfSize,
  };
}

function buildLayoutIndex(layout: CastleLayout): LayoutGeometryIndex {
  const floorCells = new Set(layout.floorCells.map(pointKey));
  const gateCells = Object.fromEntries(GATE_IDS.map((gateId) => [
    gateId,
    new Set((layout.gateCells[gateId] ?? []).map(pointKey)),
  ])) as unknown as Record<GateId, ReadonlySet<string>>;

  const equipmentRects: FixedRect[] = [];
  const cells = [
    ...layout.turrets.map((turret) => turret.cell),
    ...layout.supplyPorts.map((port) => port.cell),
  ];
  for (const cell of cells) {
    const rect = equipmentRectForCell(cell);
    if (equipmentRects.some((candidate) => candidate.x0 === rect.x0 && candidate.y0 === rect.y0)) continue;
    equipmentRects.push(rect);
  }

  return { floorCells, gateCells, equipmentRects };
}

function layoutIndex(layout: CastleLayout): LayoutGeometryIndex {
  const cached = layoutIndexCache.get(layout);
  if (cached) return cached;
  const built = buildLayoutIndex(layout);
  layoutIndexCache.set(layout, built);
  return built;
}

function isFinitePoint(point: FixedPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isInsideCastleBounds(layout: CastleLayout, point: FixedPoint, margin = 0): boolean {
  return point.x - margin >= 0 && point.y - margin >= 0 &&
    point.x + margin <= layout.widthCells * FLOOR_SUBUNITS &&
    point.y + margin <= layout.heightCells * FLOOR_SUBUNITS;
}

function cellAt(point: FixedPoint): Point {
  return {
    x: Math.floor(point.x / FLOOR_SUBUNITS),
    y: Math.floor(point.y / FLOOR_SUBUNITS),
  };
}

function isOpenFloorCell(
  state: BattleState,
  team: TeamId,
  cell: Point,
  index = layoutIndex(layoutForTeam(state, team)),
): boolean {
  const layout = layoutForTeam(state, team);
  if (cell.x < 0 || cell.y < 0 || cell.x >= layout.widthCells || cell.y >= layout.heightCells) return false;
  const key = pointKey(cell);
  if (!index.floorCells.has(key)) return false;

  // Gate occupancy is intentionally evaluated against the live castle state;
  // gate open/closed state must never be captured in layoutIndexCache.
  const castle = state.castles[team];
  for (const gateId of GATE_IDS) {
    if (castle?.gates[gateId]?.open !== true && index.gateCells[gateId].has(key)) return false;
  }
  return true;
}

function isBlockedCell(
  state: BattleState,
  team: TeamId,
  cell: Point,
  index: LayoutGeometryIndex,
): boolean {
  return !isOpenFloorCell(state, team, cell, index);
}

function circleIntersectsRect(point: FixedPoint, rect: FixedRect, radius: number): boolean {
  const closestX = Math.max(rect.x0, Math.min(point.x, rect.x1));
  const closestY = Math.max(rect.y0, Math.min(point.y, rect.y1));
  const dx = point.x - closestX;
  const dy = point.y - closestY;
  // Tangency is treated as blocked. This leaves a one-subunit conservative
  // clearance for integer fixed-point movement and avoids edge tunnelling.
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Exact circle-vs-cell occupancy for the continuous fixed-point mover.
 *
 * The caller owns the semantic scope check: before applying this geometry to
 * an interaction, it must verify that actor.location.castleTeam equals the
 * case's currentTeam. This helper only answers physical occupancy for the
 * selected castle layout.
 */
export function canOccupyFixed(state: BattleState, team: TeamId, point: FixedPoint): boolean {
  if (!isFinitePoint(point)) return false;
  const layout = layoutForTeam(state, team);
  if (!isInsideCastleBounds(layout, point, ACTOR_RADIUS_SUBUNITS)) return false;
  const index = layoutIndex(layout);
  const radius = ACTOR_RADIUS_SUBUNITS;
  const minCellX = Math.floor((point.x - radius) / FLOOR_SUBUNITS);
  const maxCellX = Math.floor((point.x + radius) / FLOOR_SUBUNITS);
  const minCellY = Math.floor((point.y - radius) / FLOOR_SUBUNITS);
  const maxCellY = Math.floor((point.y + radius) / FLOOR_SUBUNITS);

  for (let y = minCellY; y <= maxCellY; y += 1) {
    for (let x = minCellX; x <= maxCellX; x += 1) {
      const cell = { x, y };
      if (isBlockedCell(state, team, cell, index) && circleIntersectsRect(point, rectForCell(cell), radius)) {
        return false;
      }
    }
  }

  // Equipment bodies are smaller than their authored cell. They are checked
  // as their own AABBs so the remaining floor in the equipment cell stays
  // available for a correctly cleared approach.
  for (const equipmentRect of index.equipmentRects) {
    if (circleIntersectsRect(point, equipmentRect, radius)) return false;
  }
  return true;
}

function segmentIntersectsRect(from: FixedPoint, to: FixedPoint, rect: FixedRect): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let near = 0;
  let far = 1;

  for (const [start, delta, min, max] of [
    [from.x, dx, rect.x0, rect.x1],
    [from.y, dy, rect.y0, rect.y1],
  ] as const) {
    if (delta === 0) {
      if (start < min || start > max) return false;
      continue;
    }
    let enter = (min - start) / delta;
    let exit = (max - start) / delta;
    if (enter > exit) [enter, exit] = [exit, enter];
    near = Math.max(near, enter);
    far = Math.min(far, exit);
    if (near > far) return false;
  }
  return far >= 0 && near <= 1;
}

/**
 * Test a center-to-center interaction ray against authored floor and closed
 * gate cells. Equipment is deliberately not an occluder: an equipment target
 * center is allowed to be the endpoint of this query.
 */
export function hasFloorLineOfSight(
  state: BattleState,
  team: TeamId,
  from: FixedPoint,
  to: FixedPoint,
): boolean {
  if (!isFinitePoint(from) || !isFinitePoint(to)) return false;
  const layout = layoutForTeam(state, team);
  if (!isInsideCastleBounds(layout, from) || !isInsideCastleBounds(layout, to)) return false;
  const index = layoutIndex(layout);
  if (!isOpenFloorCell(state, team, cellAt(from), index) || !isOpenFloorCell(state, team, cellAt(to), index)) return false;

  const minCellX = Math.floor(Math.min(from.x, to.x) / FLOOR_SUBUNITS);
  const maxCellX = Math.floor(Math.max(from.x, to.x) / FLOOR_SUBUNITS);
  const minCellY = Math.floor(Math.min(from.y, to.y) / FLOOR_SUBUNITS);
  const maxCellY = Math.floor(Math.max(from.y, to.y) / FLOOR_SUBUNITS);
  for (let y = minCellY; y <= maxCellY; y += 1) {
    for (let x = minCellX; x <= maxCellX; x += 1) {
      const cell = { x, y };
      if (!isOpenFloorCell(state, team, cell, index) && segmentIntersectsRect(from, to, rectForCell(cell))) {
        return false;
      }
    }
  }
  return true;
}

/** Read-only 0.6x0.6 body rectangles for the turrets and supply ports. */
export function equipmentRectangles(state: BattleState, team: TeamId): readonly FixedRect[] {
  return layoutIndex(layoutForTeam(state, team)).equipmentRects;
}

function distanceSquared(from: FixedPoint, to: FixedPoint): number {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  return dx * dx + dy * dy;
}

function withinActionRange(from: FixedPoint, to: FixedPoint, range: number): boolean {
  return distanceSquared(from, to) <= range * range;
}

function addCandidate(
  candidates: FixedPoint[],
  seen: Set<string>,
  target: FixedPoint,
  point: FixedPoint,
  range: number,
  state: BattleState,
  team: TeamId,
): void {
  if (!isFinitePoint(point) || !withinActionRange(point, target, range) ||
      !canOccupyFixed(state, team, point) || !hasFloorLineOfSight(state, team, point, target)) return;
  const key = fixedPointKey(point);
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({ x: Math.trunc(point.x), y: Math.trunc(point.y) });
}

/**
 * Enumerate deterministic, physically walkable subpoints within action range
 * of a target. The 32-point ring includes the four cardinal positions around
 * a 0.6x0.6 equipment body, which are 799 subunits from its center and
 * therefore leave generous interaction clearance.
 */
export function walkableApproachSubpoints(
  state: BattleState,
  team: TeamId,
  target: FixedPoint,
  range = ACTION_RANGE_SUBUNITS,
): FixedPoint[] {
  if (!isFinitePoint(target) || !Number.isFinite(range) || range < 0) return [];
  const candidates: FixedPoint[] = [];
  const seen = new Set<string>();
  if (range === 0) {
    addCandidate(candidates, seen, target, target, range, state, team);
    return candidates;
  }

  const sampleRadius = Math.max(1, Math.trunc(range) - 1);
  for (let index = 0; index < 32; index += 1) {
    const angle = (Math.PI * 2 * index) / 32;
    addCandidate(candidates, seen, target, {
      x: Math.round(target.x + Math.cos(angle) * sampleRadius),
      y: Math.round(target.y + Math.sin(angle) * sampleRadius),
    }, range, state, team);
  }
  return candidates;
}

/** Return the authored floor cells containing the approach subpoints. */
export function walkableApproachCells(
  state: BattleState,
  team: TeamId,
  target: FixedPoint,
  range = ACTION_RANGE_SUBUNITS,
): Point[] {
  const seen = new Set<string>();
  const cells: Point[] = [];
  for (const point of walkableApproachSubpoints(state, team, target, range)) {
    const cell = cellAt(point);
    const key = pointKey(cell);
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push(cell);
  }
  return cells;
}
