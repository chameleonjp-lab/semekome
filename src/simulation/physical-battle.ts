import { createWorld } from "./world.ts";
import { caseDefinition, CASE_TYPES, SUPPLY_BAG, type CaseType } from "../content/cases.ts";
import { padById } from "../domain/layout.ts";
import { assertObjectLocationsUnique } from "../domain/objects.ts";
import type {
  ActorId,
  ActorState,
  PartId,
  PauseReason,
  Point,
  RejectedInput,
  StepReport,
  TeamId,
  WorldEvent,
  WorldObject,
  WorldState,
} from "../domain/types.ts";
import { GATE_IDS, PART_IDS } from "../domain/types.ts";
import {
  ACTOR_SPEED_SUBUNITS_PER_TICK,
  cellCenter,
  floorCell,
} from "../actors/movement.ts";
import {
  ACTION_RANGE_SUBUNITS as GEOMETRY_ACTION_RANGE_SUBUNITS,
  canOccupyFixed,
  hasFloorLineOfSight,
  walkableApproachCells,
} from "../actors/geometry.ts";
import {
  FLOOR_CASE_LIMIT_PER_ROOM,
  QUEUE_CAPACITY_PER_TURRET,
  STAGING_SLOTS_PER_TURRET,
  SUPPLY_FIRST_DELAY_TICKS,
  SUPPLY_GROUP_LIMIT_PER_SOURCE_TEAM,
  SUPPLY_PERIOD_TICKS,
  carryingSpeedMultiplier,
  canCarry,
} from "../logistics/logistics.ts";
import {
  ARTILLERY_ROUTES,
  MAX_FLIGHT_COUNT,
  ROUTE_LENGTH_UNITS,
  SHARED_LAUNCH_COOLDOWN_TICKS,
  type ArtilleryRoute,
} from "../artillery/artillery.ts";
import { getHandoffPosition, getTurretOperatorPosition } from "../artillery/positions.ts";
import type { CrewAssignment, CrewTask } from "../crew/crew.ts";

const PLAYER_TEAM: TeamId = "player";
const ENEMY_TEAM: TeamId = "enemy";
const ALL_TEAMS: readonly TeamId[] = [PLAYER_TEAM, ENEMY_TEAM];
const ACTION_RANGE_SUBUNITS = GEOMETRY_ACTION_RANGE_SUBUNITS;
const EVENT_LOG_LIMIT = 512;
const ROUTE_COLLISION_EPSILON = 0.012;
const AI_REPLAN_TICKS = 120;
const floorCellCache = new WeakMap<object, Set<string>>();
const gateCellCache = new WeakMap<object, Record<string, Set<string>>>();

function xorshift32(value: number): number {
  let next = value >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function seededSupplyBag(seed: number, team: TeamId, cycle: number): CaseType[] {
  // Fisher–Yates is seeded from match identity, source vehicle, and bag
  // cycle. No port owns an independent offset: simultaneous port spawns walk
  // one shared bag in stable port-number order.
  let random = (seed ^ (team === ENEMY_TEAM ? 0x85ebca6b : 0xc2b2ae35) ^ Math.imul(cycle + 1, 0x9e3779b9)) >>> 0;
  const bag = [...SUPPLY_BAG];
  for (let index = bag.length - 1; index > 0; index -= 1) {
    random = xorshift32(random || 1);
    const swapIndex = random % (index + 1);
    [bag[index], bag[swapIndex]] = [bag[swapIndex], bag[index]];
  }
  return bag;
}

export interface FixedPoint {
  /** Integer subunits; a cell center is cell * 1000 + 500. */
  x: number;
  y: number;
}

export type BattleDirection = { x: -1 | 0 | 1; y: -1 | 0 | 1 };
export type BattleRoute = ArtilleryRoute;
export type BattleHandle = "pickup" | "drop" | "deliver" | "load" | "launch" | "intercept";

/** Renderer/input adapters submit semantics, never object/collision internals. */
export interface BattleIntent {
  /** Every input is bound to the match that produced its snapshot. */
  matchId: string;
  actorId: ActorId;
  generation: number;
  direction?: BattleDirection;
  handle?: BattleHandle;
  slot?: number;
  route?: BattleRoute;
  part?: PartId;
  /** Candidate snapshot token returned by getInteraction. */
  contextToken?: string;
}

export type BattleCaseLocation = "floor" | "carried" | "handoff" | "queue" | "flying" | "consumed";

export interface BattleCaseView {
  id: string;
  type: CaseType;
  sourceTeam: TeamId;
  /** Team currently owning the case; independent from sourceTeam. */
  currentTeam: TeamId;
  weight: number;
  location: BattleCaseLocation;
  currentPosition?: FixedPoint;
  ownerActorId?: ActorId;
  ownerGeneration?: number;
  turretId?: string;
  queueIndex?: number;
  route?: BattleRoute;
  targetPart?: PartId;
  /** Fixed physical handoff floor slot, retained while staged. */
  stagingSlot?: 0 | 1;
  originGroupId: string;
  sourcePortId: string;
  interceptRemaining?: number;
  /** Opaque candidate token; not used as an object id. */
  token?: string;
}

export interface BattleCaseState extends BattleCaseView {
  createdTick: number;
  roomId: string;
  position?: FixedPoint;
  flightId?: string;
  /** Route/part selected before loading; captured into route/targetPart at enqueue. */
  pendingRoute?: BattleRoute;
  pendingTargetPart?: PartId;
  pendingSelectionActorId?: ActorId;
}

export interface BattleFlightView {
  id: string;
  objectId: string;
  team: TeamId;
  sourceActorId: ActorId;
  sourceGeneration: number;
  targetTeam: TeamId;
  route: BattleRoute;
  /** Normalized progress in [0, 1]. */
  progress: number;
  targetPart?: PartId;
  interceptRemaining: number;
}

export interface BattleFlightState extends BattleFlightView {
  createdTick: number;
  distanceUnits: number;
  speedUnitsPerSecond: number;
  previousProgress: number;
}

export interface BattlePortState {
  id: string;
  team: TeamId;
  roomId: string;
  position: FixedPoint;
  nextSpawnTick: number;
  /** Number of live groups currently sourced by this port. */
  groupCount: number;
  groupSequence: number;
  stoppedUntilTick: number | null;
}

export interface BattleTurretState {
  id: string;
  team: TeamId;
  position: FixedPoint;
  roomId: string;
  queueIds: string[];
  handoffIds: string[];
  /** Two physical staging slots; null is an empty slot and never re-packed. */
  stagingSlots: [string | null, string | null];
  stagingPositions: [FixedPoint, FixedPoint];
  operatorPosition: FixedPoint;
  stoppedUntilTick: number | null;
  operatorActorIds: ActorId[];
}

export interface BattleCrewState {
  assignments: Record<string, CrewAssignment>;
}

export interface BattleLogisticsState {
  ports: Record<string, BattlePortState>;
  groups: Record<string, { id: string; team: TeamId; portId: string; caseIds: string[]; retired: boolean }>;
  /** One shuffled eight-case bag per source vehicle, shared by all four ports. */
  bags: Record<TeamId, CaseType[]>;
  bagIndices: Record<TeamId, number>;
  bagCycles: Record<TeamId, number>;
}

export interface BattleArtilleryState {
  turrets: Record<string, BattleTurretState>;
  flights: Record<string, BattleFlightState>;
  nextLaunchTick: Record<TeamId, number>;
  roundRobinTurretIndex: Record<TeamId, number>;
  contactPairs: Record<string, boolean>;
}

export interface BattleInteraction {
  actorId: ActorId;
  generation: number;
  position: FixedPoint;
  cases: BattleCaseView[];
  flights: BattleFlightView[];
  /** Queue ids for all own-team turrets. */
  queue: string[];
  queueEntries: Array<{ id: string; turretId: string; slot: number }>;
  turretIds: string[];
  /** Only actions that have a valid target in this snapshot. */
  handles: BattleHandle[];
  /** The exact nearest pickup target accepted for the selected empty slot. */
  pickupCaseId?: string;
  contextToken: string;
  selectedSlot?: 0 | 1;
}

const BATTLE_HANDLES: readonly BattleHandle[] = ["pickup", "drop", "deliver", "load", "launch", "intercept"];

function isBattleHandle(value: unknown): value is BattleHandle {
  return typeof value === "string" && BATTLE_HANDLES.includes(value as BattleHandle);
}

function isBattleRoute(value: unknown): value is BattleRoute {
  return value === "direct" || value === "detour";
}

function isPartId(value: unknown): value is PartId {
  return typeof value === "string" && PART_IDS.includes(value as PartId);
}

/** R1 remains a structural/cell projection; fixedActors is movement authority. */
export interface BattleState extends WorldState {
  fixedActors: Record<string, { position: FixedPoint; remainder?: FixedPoint }>;
  /** Two stable cargo slots; null is intentional and is never compacted. */
  cargoSlots: Record<string, [string | null, string | null]>;
  battleCases: Record<string, BattleCaseState>;
  logistics: BattleLogisticsState;
  artillery: BattleArtilleryState;
  crew: BattleCrewState;
  /** Latest UI route/part selection; read at the actual enqueue tick. */
  launchSelections: Record<string, { route?: BattleRoute; part?: PartId }>;
  nextLaunchTick: Record<TeamId, number>;
  eventLogLimit: number;
}

function cloneBattle<T extends BattleState>(state: T): T {
  const { layout, ...mutable } = state;
  return { ...structuredClone(mutable), layout } as T;
}

function event(type: WorldEvent["type"], payload: Record<string, unknown>): WorldEvent {
  return { type, ...payload } as WorldEvent;
}

function emptyReport(): StepReport {
  return { processedTick: null, advanced: false, acceptedInputKinds: [], rejected: [], events: [] };
}

function addRejection(report: StepReport, inputIndex: number, reason: RejectedInput["reason"], detail?: string): void {
  report.rejected.push({ inputIndex, reason, detail });
}

function teamLayout(state: BattleState, team: TeamId): typeof state.layout.home {
  return team === PLAYER_TEAM ? state.layout.home : state.layout.enemy;
}

function turretKey(team: TeamId, id: string): string {
  return `${team}:${id}`;
}

function portKey(team: TeamId, id: string): string {
  return `${team}:${id}`;
}

function actorFixed(state: BattleState, actorId: ActorId): FixedPoint {
  return state.fixedActors[actorId]?.position ?? { x: 0, y: 0 };
}

function copyPoint(point: FixedPoint): FixedPoint {
  return { x: Math.trunc(point.x), y: Math.trunc(point.y) };
}

function distanceSquared(a: FixedPoint, b: FixedPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function withinActionRange(a: FixedPoint, b: FixedPoint): boolean {
  return distanceSquared(a, b) <= ACTION_RANGE_SUBUNITS * ACTION_RANGE_SUBUNITS;
}

function casePosition(caseState: BattleCaseState): FixedPoint | undefined {
  return caseState.position ? copyPoint(caseState.position) : caseState.currentPosition ? copyPoint(caseState.currentPosition) : undefined;
}

function caseView(caseState: BattleCaseState, token?: string): BattleCaseView {
  return {
    id: caseState.id,
    type: caseState.type,
    sourceTeam: caseState.sourceTeam,
    currentTeam: caseState.currentTeam,
    weight: caseState.weight,
    location: caseState.location,
    currentPosition: casePosition(caseState),
    ownerActorId: caseState.ownerActorId,
    ownerGeneration: caseState.ownerGeneration,
    turretId: caseState.turretId,
    queueIndex: caseState.queueIndex,
    route: caseState.route,
    targetPart: caseState.targetPart,
    stagingSlot: caseState.stagingSlot,
    originGroupId: caseState.originGroupId,
    sourcePortId: caseState.sourcePortId,
    interceptRemaining: caseState.interceptRemaining,
    token,
  };
}

function caseToken(state: BattleState, actor: ActorState, candidates: BattleCaseState[]): string {
  return [state.tick, actor.id, actor.generation, ...candidates.map((candidate) => {
    const position = candidate.position ?? candidate.currentPosition;
    return `${candidate.id}:${candidate.location}:${candidate.ownerGeneration ?? ""}:${candidate.currentTeam}:${position?.x ?? ""},${position?.y ?? ""}`;
  })].join("|");
}

function isFiniteDirection(direction: BattleDirection | undefined): boolean {
  // Neutral is a valid held-input frame. It advances the simulation without
  // changing the actor position, so the validator accepts (0, 0) as well.
  return !!direction && Number.isInteger(direction.x) && Number.isInteger(direction.y) &&
    direction.x >= -1 && direction.x <= 1 && direction.y >= -1 && direction.y <= 1;
}

function readCell(point: FixedPoint): Point {
  return { x: floorCell(point.x), y: floorCell(point.y) };
}

function isGateClosed(state: BattleState, team: TeamId, cell: Point): boolean {
  const layout = teamLayout(state, team);
  let gateSets = gateCellCache.get(layout as object);
  if (!gateSets) {
    gateSets = Object.fromEntries(GATE_IDS.map((gateId) => [gateId, new Set(layout.gateCells[gateId].map((candidate) => `${candidate.x},${candidate.y}`))]));
    gateCellCache.set(layout as object, gateSets);
  }
  return GATE_IDS.some((gateId) => !state.castles[team].gates[gateId].open && gateSets![gateId].has(`${cell.x},${cell.y}`));
}

function isWalkableCell(state: BattleState, team: TeamId, cell: Point): boolean {
  if (cell.x < 0 || cell.y < 0 || cell.x >= state.layout.widthCells || cell.y >= state.layout.heightCells) return false;
  if (isGateClosed(state, team, cell)) return false;
  const layout = teamLayout(state, team);
  let floorCells = floorCellCache.get(layout as object);
  if (!floorCells) {
    floorCells = new Set(layout.floorCells.map((candidate) => `${candidate.x},${candidate.y}`));
    floorCellCache.set(layout as object, floorCells);
  }
  return floorCells.has(`${cell.x},${cell.y}`);
}

/** Geometry module is authoritative for circle, wall, gate, and equipment collision. */
function canOccupy(state: BattleState, team: TeamId, point: FixedPoint): boolean {
  return canOccupyFixed(state, team, point);
}

function roomForCell(state: BattleState, team: TeamId, cell: Point, preferred?: string): string | undefined {
  const layout = teamLayout(state, team);
  const rooms = layout.rooms;
  if (preferred) {
    const room = rooms.find((candidate) => candidate.id === preferred);
    if (room && room.rect.x0 <= cell.x && cell.x < room.rect.x1 && room.rect.y0 <= cell.y && cell.y < room.rect.y1) return room.id;
    const passage = layout.passageCells?.[preferred.replace(/^passage:/, "")];
    if (passage?.some((candidate) => candidate.x === cell.x && candidate.y === cell.y)) return preferred.startsWith("passage:") ? preferred : `passage:${preferred}`;
  }
  const room = rooms.find((candidate) => candidate.rect.x0 <= cell.x && cell.x < candidate.rect.x1 && candidate.rect.y0 <= cell.y && cell.y < candidate.rect.y1);
  if (room) return room.id;
  const passageId = Object.entries(layout.passageCells ?? {}).find(([, cells]) => cells.some((candidate) => candidate.x === cell.x && candidate.y === cell.y))?.[0];
  return passageId ? `passage:${passageId}` : undefined;
}

function syncActorProjection(state: BattleState, actor: ActorState): void {
  const fixed = actorFixed(state, actor.id);
  const cell = readCell(fixed);
  actor.position = cell;
  if (actor.location.area !== "castle" || !actor.location.castleTeam) return;
  const roomId = roomForCell(state, actor.location.castleTeam, cell, actor.currentRoomId);
  if (!roomId) return;
  if (actor.currentRoomId !== roomId) {
    actor.currentRoomId = roomId;
    actor.location.roomId = roomId;
    actor.location.pathRooms = [...actor.location.pathRooms, roomId];
  }
}

function setActorFixed(state: BattleState, actor: ActorState, point: FixedPoint): void {
  const previous = state.fixedActors[actor.id];
  state.fixedActors[actor.id] = { position: copyPoint(point), remainder: previous?.remainder ?? { x: 0, y: 0 } };
  syncActorProjection(state, actor);
}

function furthestWalkablePoint(state: BattleState, team: TeamId, from: FixedPoint, to: FixedPoint): FixedPoint {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const middle = (low + high) / 2;
    const candidate = {
      x: Math.round(from.x + (to.x - from.x) * middle),
      y: Math.round(from.y + (to.y - from.y) * middle),
    };
    if (canOccupy(state, team, candidate)) low = middle;
    else high = middle;
  }
  return {
    x: Math.round(from.x + (to.x - from.x) * low),
    y: Math.round(from.y + (to.y - from.y) * low),
  };
}

function moveFixed(state: BattleState, actor: ActorState, direction: BattleDirection): boolean {
  if (!actor.alive || actor.location.area !== "castle" || !actor.location.castleTeam) return false;
  const totalWeight = actor.cargoIds.reduce((sum, id) => sum + (state.battleCases[id]?.weight ?? 0), 0);
  const speed = ACTOR_SPEED_SUBUNITS_PER_TICK * carryingSpeedMultiplier(totalWeight);
  const diagonal = direction.x !== 0 && direction.y !== 0 ? Math.SQRT1_2 : 1;
  const motion = state.fixedActors[actor.id] ?? { position: actorFixed(state, actor.id), remainder: { x: 0, y: 0 } };
  const remainder = motion.remainder ?? { x: 0, y: 0 };
  const dxFloat = direction.x * speed * diagonal + remainder.x;
  const dyFloat = direction.y * speed * diagonal + remainder.y;
  const dx = Math.trunc(dxFloat);
  const dy = Math.trunc(dyFloat);
  const nextRemainder = { x: dxFloat - dx, y: dyFloat - dy };
  const current = actorFixed(state, actor.id);
  let moved = false;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 100));
  let next = current;
  for (let index = 1; index <= steps; index += 1) {
    const candidate = {
      x: current.x + Math.round((dx * index) / steps),
      y: current.y + Math.round((dy * index) / steps),
    };
    if (!canOccupy(state, actor.location.castleTeam, candidate)) {
      const partial = furthestWalkablePoint(state, actor.location.castleTeam, next, candidate);
      if (partial.x !== next.x || partial.y !== next.y) {
        next = partial;
        moved = true;
      }
      break;
    }
    next = candidate;
    moved = true;
  }
  if (moved) {
    setActorFixed(state, actor, next);
    state.fixedActors[actor.id].remainder = nextRemainder;
  } else {
    state.fixedActors[actor.id].remainder = remainder;
  }
  return moved;
}

function nearestCellPath(state: BattleState, team: TeamId, from: Point, to: Point): Point[] {
  const pathCellOpen = (cell: Point): boolean => isWalkableCell(state, team, cell) && canOccupyFixed(state, team, { x: cellCenter(cell.x), y: cellCenter(cell.y) });
  if (!pathCellOpen(to)) return [];
  const queue: Point[] = [{ ...from }];
  const parent = new Map<string, string | null>([[`${from.x},${from.y}`, null]]);
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.x === to.x && current.y === to.y) break;
    for (const [dx, dy] of directions) {
      const next = { x: current.x + dx, y: current.y + dy };
      const key = `${next.x},${next.y}`;
      if (parent.has(key) || !pathCellOpen(next)) continue;
      parent.set(key, `${current.x},${current.y}`);
      queue.push(next);
    }
  }
  const targetKey = `${to.x},${to.y}`;
  if (!parent.has(targetKey)) return [];
  const reversed: Point[] = [];
  let cursor: string | null = targetKey;
  while (cursor) {
    const [x, y] = cursor.split(",").map(Number);
    reversed.push({ x, y });
    cursor = parent.get(cursor) ?? null;
  }
  reversed.reverse();
  return reversed;
}

function moveAlongPath(state: BattleState, actor: ActorState, path: Point[], pathIndex: number, finalTarget?: FixedPoint): number {
  if (path.length === 0) return pathIndex;
  let nextIndex = pathIndex;
  const current = actorFixed(state, actor.id);
  while (nextIndex < path.length && distanceSquared(current, { x: cellCenter(path[nextIndex].x), y: cellCenter(path[nextIndex].y) }) <= 650 * 650) nextIndex += 1;
  const target = path[Math.min(nextIndex, path.length - 1)];
  const targetPoint = nextIndex >= path.length && finalTarget ? finalTarget : { x: cellCenter(target.x), y: cellCenter(target.y) };

  // AI routes are cardinal cell segments. Correct the perpendicular residual
  // first before crossing into the next cell: a diagonal step at a doorway can
  // make the actor's radius touch the wall even though both cell centres are
  // walkable. Once aligned, advance along the segment. This also preserves
  // the fixed-point remainder in moveFixed rather than snapping by a large
  // teleport.
  const currentCell = readCell(current);
  const moveSpeed = ACTOR_SPEED_SUBUNITS_PER_TICK * carryingSpeedMultiplier(carryWeight(state, actor));
  const snapAxis = (axis: "x" | "y"): boolean => {
    const point = actorFixed(state, actor.id);
    const delta = targetPoint[axis] - point[axis];
    if (Math.abs(delta) > moveSpeed) return false;
    const candidate = copyPoint(point);
    candidate[axis] = targetPoint[axis];
    if (!canOccupy(state, actor.team, candidate)) return false;
    setActorFixed(state, actor, candidate);
    const remainder = state.fixedActors[actor.id].remainder ?? { x: 0, y: 0 };
    state.fixedActors[actor.id].remainder = { ...remainder, [axis]: 0 };
    return true;
  };
  const moveAxis = (axis: "x" | "y"): void => {
    if (snapAxis(axis)) return;
    const point = actorFixed(state, actor.id);
    const delta = targetPoint[axis] - point[axis];
    if (delta === 0) return;
    moveFixed(state, actor, axis === "x"
      ? { x: delta > 0 ? 1 : -1, y: 0 }
      : { x: 0, y: delta > 0 ? 1 : -1 });
  };
  if (nextIndex < path.length) {
    if (target.x !== currentCell.x) {
      // Horizontal segment: align the perpendicular y coordinate first.
      if (current.y !== targetPoint.y) moveAxis("y");
      else moveAxis("x");
    } else if (target.y !== currentCell.y) {
      // Vertical segment: align the perpendicular x coordinate first.
      if (current.x !== targetPoint.x) moveAxis("x");
      else moveAxis("y");
    } else if (Math.abs(targetPoint.x - current.x) >= Math.abs(targetPoint.y - current.y)) {
      moveAxis("x");
    } else {
      moveAxis("y");
    }
  } else if (Math.abs(targetPoint.x - current.x) >= Math.abs(targetPoint.y - current.y)) {
    moveAxis("x");
  } else {
    moveAxis("y");
  }
  return nextIndex;
}

function actorIsProtected(state: BattleState, actor: ActorState): boolean {
  return actor.protectedUntilTick !== null && state.tick < actor.protectedUntilTick;
}

/** Move one AI actor and deterministically re-plan after two seconds blocked. */
function moveAIAlongPath(state: BattleState, actor: ActorState, assignment: CrewAssignment, target: FixedPoint): void {
  const before = actorFixed(state, actor.id);
  assignment.pathIndex = moveAlongPath(state, actor, assignment.path, assignment.pathIndex, target);
  const after = actorFixed(state, actor.id);
  const moved = after.x !== before.x || after.y !== before.y;
  const inRange = withinActionRange(after, target);
  if (moved || inRange) {
    assignment.stuckTicks = 0;
    assignment.lastPosition = copyPoint(after);
    return;
  }
  assignment.stuckTicks = (assignment.stuckTicks ?? 0) + 1;
  assignment.lastPosition = copyPoint(after);
  if (assignment.stuckTicks < AI_REPLAN_TICKS) return;
  assignment.path = actorTargetPath(state, actor, target);
  assignment.pathIndex = 0;
  assignment.stuckTicks = 0;
  // Re-plan on the same tick so a newly opened passage does not add an
  // artificial two-second idle period.
  moveAlongPath(state, actor, assignment.path, assignment.pathIndex, target);
}

function caseRoomPosition(state: BattleState, caseState: BattleCaseState): void {
  if (!caseState.position) return;
  const room = roomForCell(state, caseState.currentTeam, readCell(caseState.position), caseState.roomId);
  if (room) caseState.roomId = room;
}

function syncWorldObject(state: BattleState, caseState: BattleCaseState): void {
  const object: WorldObject = state.objects[caseState.id] ?? {
    id: caseState.id,
    sourceTeam: caseState.sourceTeam,
    weight: caseState.weight,
    location: { kind: "consumed", reason: "initializing", tick: state.tick },
    originGroupId: caseState.originGroupId,
  };
  object.sourceTeam = caseState.sourceTeam;
  object.weight = caseState.weight;
  object.originGroupId = caseState.originGroupId;
  // WorldState remains the R1 cell projection. Fixed-point precision belongs
  // exclusively to BattleState/UI views; never leak fractional cells into
  // the R1 object location.
  const position = caseState.position ? readCell(caseState.position) : { x: 0, y: 0 };
  if (caseState.location === "carried" && caseState.ownerActorId !== undefined) {
    const actor = state.actors[caseState.ownerActorId];
    const slots = state.cargoSlots[caseState.ownerActorId];
    const slot = slots ? slots.indexOf(caseState.id) : actor?.cargoIds.indexOf(caseState.id) ?? -1;
    object.location = { kind: "carried", actorId: caseState.ownerActorId, slot: Math.max(0, slot) };
  } else if (caseState.location === "queue" && caseState.turretId !== undefined) {
    object.location = { kind: "queue", team: caseState.currentTeam, turretId: caseState.turretId, index: caseState.queueIndex ?? 0 };
  } else if (caseState.location === "flying" && caseState.flightId !== undefined) {
    object.location = { kind: "flying", projectileId: caseState.flightId };
  } else if (caseState.location === "consumed") {
    object.location = { kind: "consumed", reason: "retired", tick: state.tick };
  } else {
    object.location = { kind: "floor", team: caseState.currentTeam, roomId: caseState.roomId, position };
  }
  state.objects[caseState.id] = object;
}

function syncAllWorldObjects(state: BattleState): void {
  for (const caseState of Object.values(state.battleCases)) syncWorldObject(state, caseState);
}

function removeFromArray(list: string[], id: string): void {
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
}

function clearCargoSlot(state: BattleState, actorId: ActorId, caseId: string): void {
  const slots = state.cargoSlots[actorId];
  if (!slots) return;
  const index = slots.indexOf(caseId);
  if (index >= 0) slots[index] = null;
}

function carryWeight(state: BattleState, actor: ActorState): number {
  return actor.cargoIds.reduce((sum, id) => sum + (state.battleCases[id]?.weight ?? 0), 0);
}

function setCaseFloor(state: BattleState, caseState: BattleCaseState, position: FixedPoint, team = caseState.currentTeam): void {
  caseState.location = "floor";
  caseState.currentTeam = team;
  caseState.position = copyPoint(position);
  caseState.currentPosition = copyPoint(position);
  caseState.ownerActorId = undefined;
  caseState.ownerGeneration = undefined;
  caseState.turretId = undefined;
  caseState.queueIndex = undefined;
  caseState.flightId = undefined;
  caseState.stagingSlot = undefined;
  caseRoomPosition(state, caseState);
  syncWorldObject(state, caseState);
}

function setCaseCarried(state: BattleState, caseState: BattleCaseState, actor: ActorState, slot: number): void {
  caseState.location = "carried";
  caseState.currentTeam = actor.team;
  caseState.position = undefined;
  caseState.currentPosition = copyPoint(actorFixed(state, actor.id));
  caseState.ownerActorId = actor.id;
  caseState.ownerGeneration = actor.generation;
  caseState.turretId = undefined;
  caseState.queueIndex = undefined;
  caseState.flightId = undefined;
  caseState.stagingSlot = undefined;
  const slots = state.cargoSlots[actor.id] ?? [null, null];
  slots[slot] = caseState.id;
  state.cargoSlots[actor.id] = slots;
  syncWorldObject(state, caseState);
}

function setCaseHandoff(state: BattleState, caseState: BattleCaseState, turret: BattleTurretState, stagingSlot: 0 | 1): void {
  caseState.location = "handoff";
  caseState.currentTeam = turret.team;
  caseState.position = copyPoint(turret.stagingPositions[stagingSlot]);
  caseState.currentPosition = copyPoint(turret.stagingPositions[stagingSlot]);
  caseState.ownerActorId = undefined;
  caseState.ownerGeneration = undefined;
  caseState.turretId = turret.id;
  caseState.queueIndex = undefined;
  caseState.flightId = undefined;
  caseState.stagingSlot = stagingSlot;
  caseState.roomId = turret.roomId;
  turret.stagingSlots[stagingSlot] = caseState.id;
  syncWorldObject(state, caseState);
}

function setCaseQueue(state: BattleState, caseState: BattleCaseState, turret: BattleTurretState): void {
  caseState.location = "queue";
  caseState.currentTeam = turret.team;
  caseState.position = copyPoint(turret.position);
  caseState.currentPosition = copyPoint(turret.position);
  caseState.ownerActorId = undefined;
  caseState.ownerGeneration = undefined;
  caseState.turretId = turret.id;
  caseState.queueIndex = turret.queueIds.indexOf(caseState.id);
  caseState.flightId = undefined;
  caseState.stagingSlot = undefined;
  caseState.roomId = turret.roomId;
  syncWorldObject(state, caseState);
}

function setCaseConsumed(state: BattleState, caseState: BattleCaseState, reason: string): void {
  caseState.location = "consumed";
  caseState.position = undefined;
  caseState.currentPosition = undefined;
  caseState.ownerActorId = undefined;
  caseState.ownerGeneration = undefined;
  caseState.turretId = undefined;
  caseState.queueIndex = undefined;
  caseState.flightId = undefined;
  caseState.stagingSlot = undefined;
  syncWorldObject(state, caseState);
  state.objects[caseState.id].location = { kind: "consumed", reason, tick: state.tick };
  const group = state.logistics.groups[caseState.originGroupId];
  if (group && !group.retired && group.caseIds.every((id) => state.battleCases[id]?.location === "consumed")) {
    group.retired = true;
    const port = state.logistics.ports[portKey(group.team, group.portId)];
    if (port) port.groupCount = Math.max(0, port.groupCount - 1);
  }
}

function totalFloorCasesInRoom(state: BattleState, team: TeamId, roomId: string): number {
  return Object.values(state.battleCases).filter((item) => item.location === "floor" && item.currentTeam === team && item.roomId === roomId).length;
}

function floorCaseSpawnPosition(state: BattleState, team: TeamId, roomId: string, preferred: FixedPoint): FixedPoint | undefined {
  const layout = teamLayout(state, team);
  const equipmentCells = new Set([
    ...layout.turrets.map((turret) => `${turret.cell.x},${turret.cell.y}`),
    ...layout.supplyPorts.map((port) => `${port.cell.x},${port.cell.y}`),
  ]);
  const occupied = new Set(
    Object.values(state.battleCases)
      .filter((item) => item.location === "floor" && item.currentTeam === team && item.roomId === roomId && item.position)
      .map((item) => `${item.position!.x},${item.position!.y}`),
  );
  const cells = layout.floorCells
    .filter((cell) => roomForCell(state, team, cell, roomId) === roomId)
    .sort((left, right) => {
      const leftDistance = (cellCenter(left.x) - preferred.x) ** 2 + (cellCenter(left.y) - preferred.y) ** 2;
      const rightDistance = (cellCenter(right.x) - preferred.x) ** 2 + (cellCenter(right.y) - preferred.y) ** 2;
      return leftDistance - rightDistance || left.y - right.y || left.x - right.x;
    });
  const cell = cells.find((candidate) => !equipmentCells.has(`${candidate.x},${candidate.y}`) && !occupied.has(`${cellCenter(candidate.x)},${cellCenter(candidate.y)}`));
  return cell ? { x: cellCenter(cell.x), y: cellCenter(cell.y) } : undefined;
}

function activeGroupsForTeam(state: BattleState, team: TeamId): number {
  return Object.values(state.logistics.groups).filter((group) => group.team === team && !group.retired).length;
}

function turretForPort(state: BattleState, team: TeamId, portId: string): BattleTurretState | undefined {
  const ports = teamLayout(state, team).supplyPorts;
  const index = ports.findIndex((port) => port.id === portId);
  const definition = teamLayout(state, team).turrets[index >= 0 ? index : 0];
  return definition ? state.artillery.turrets[turretKey(team, definition.id)] : undefined;
}

function makeCaseId(team: TeamId, portId: string, groupIndex: number): string {
  return `case-${team}-${portId}-g${String(groupIndex + 1).padStart(2, "0")}`;
}

function spawnSupply(state: BattleState, events: WorldEvent[]): void {
  const ports = Object.values(state.logistics.ports).sort((left, right) => {
    if (left.team !== right.team) return left.team.localeCompare(right.team);
    return left.id.localeCompare(right.id);
  });
  for (const port of ports) {
    if (state.tick < port.nextSpawnTick || (port.stoppedUntilTick !== null && state.tick < port.stoppedUntilTick)) continue;
    // The 48-group cap is for live source groups across all four ports of a
    // team. A consumed group retires and frees one slot; a port is not
    // permanently exhausted after its lifetime counter reaches 48.
    if (activeGroupsForTeam(state, port.team) >= SUPPLY_GROUP_LIMIT_PER_SOURCE_TEAM) continue;
    if (totalFloorCasesInRoom(state, port.team, port.roomId) >= FLOOR_CASE_LIMIT_PER_ROOM) {
      port.nextSpawnTick = state.tick + 30;
      continue;
    }
    const spawnPosition = floorCaseSpawnPosition(state, port.team, port.roomId, port.position);
    if (!spawnPosition) {
      port.nextSpawnTick = state.tick + 30;
      continue;
    }
    const bagIndex = state.logistics.bagIndices[port.team];
    const type = state.logistics.bags[port.team][bagIndex];
    const definition = type ? caseDefinition(type) : undefined;
    if (!type || !definition) continue;
    const groupIndex = port.groupSequence;
    port.groupSequence += 1;
    port.groupCount += 1;
    state.logistics.bagIndices[port.team] += 1;
    if (state.logistics.bagIndices[port.team] >= state.logistics.bags[port.team].length) {
      state.logistics.bagCycles[port.team] += 1;
      state.logistics.bags[port.team] = seededSupplyBag(state.seed, port.team, state.logistics.bagCycles[port.team]);
      state.logistics.bagIndices[port.team] = 0;
    }
    port.nextSpawnTick = state.tick + SUPPLY_PERIOD_TICKS;
    const groupId = `group-${port.team}-${port.id}-g${String(groupIndex + 1).padStart(2, "0")}`;
    const caseId = makeCaseId(port.team, port.id, groupIndex);
    const caseState: BattleCaseState = {
      id: caseId,
      type,
      sourceTeam: port.team,
      currentTeam: port.team,
      weight: definition.weight,
      location: "floor",
      currentPosition: copyPoint(spawnPosition),
      originGroupId: groupId,
      sourcePortId: port.id,
      createdTick: state.tick,
      roomId: port.roomId,
      position: copyPoint(spawnPosition),
      interceptRemaining: definition.interceptHits,
    };
    state.battleCases[caseId] = caseState;
    state.logistics.groups[groupId] = { id: groupId, team: port.team, portId: port.id, caseIds: [caseId], retired: false };
    syncWorldObject(state, caseState);
    events.push(event("case_spawned", { objectId: caseId, team: port.team, portId: port.id, caseType: type }));
  }
}

function turretAtActor(state: BattleState, actor: ActorState): BattleTurretState | undefined {
  if (actor.location.area !== "castle" || actor.location.castleTeam !== actor.team) return undefined;
  return Object.values(state.artillery.turrets)
    .filter((turret) => turret.team === actor.team && withinActionRange(actorFixed(state, actor.id), turret.position) && hasFloorLineOfSight(state, actor.team, actorFixed(state, actor.id), turret.position))
    .sort((left, right) => left.id.localeCompare(right.id))[0];
}

function dropActorCargo(state: BattleState, actor: ActorState, events: WorldEvent[]): void {
  for (const objectId of [...actor.cargoIds]) {
    const caseState = state.battleCases[objectId];
    if (!caseState) continue;
    setCaseFloor(state, caseState, actorFixed(state, actor.id), actor.team);
    events.push(event("object_moved", { objectId, location: state.objects[objectId].location }));
  }
  actor.cargoIds = [];
  state.cargoSlots[actor.id] = [null, null];
  actor.reservationIds = [];
}

function pickCase(state: BattleState, actor: ActorState, caseState: BattleCaseState, events: WorldEvent[], requestedSlot?: number): boolean {
  if (caseState.location !== "floor" && caseState.location !== "handoff") return false;
  if (actor.location.area !== "castle" || actor.location.castleTeam !== actor.team || caseState.currentTeam !== actor.team) return false;
  if (!caseState.position || !withinActionRange(actorFixed(state, actor.id), caseState.position)) return false;
  if (!hasFloorLineOfSight(state, actor.team, actorFixed(state, actor.id), caseState.position)) return false;
  if (!canCarry(carryWeight(state, actor), caseState.weight, actor.cargoIds.length)) return false;
  const slots = state.cargoSlots[actor.id] ?? [null, null];
  const slot = requestedSlot === undefined ? slots.findIndex((entry) => entry === null) : requestedSlot;
  if (slot < 0 || slot > 1 || slots[slot] !== null) return false;
  // Validate the requested cargo slot before mutating the physical handoff
  // registry. A rejected press must not make a staged case disappear.
  if (caseState.location === "handoff" && caseState.turretId) {
    const turret = state.artillery.turrets[turretKey(caseState.currentTeam, caseState.turretId)];
    const stagingSlot = caseState.stagingSlot;
    if (!turret || stagingSlot === undefined || turret.stagingSlots[stagingSlot] !== caseState.id) return false;
    removeFromArray(turret.handoffIds, caseState.id);
    turret.stagingSlots[stagingSlot] = null;
  }
  actor.cargoIds.push(caseState.id);
  setCaseCarried(state, caseState, actor, slot);
  events.push(event("object_moved", { objectId: caseState.id, location: state.objects[caseState.id].location }));
  return true;
}

function lowestAlivePart(castle: BattleState["castles"][TeamId]): PartId | undefined {
  return PART_IDS.find((id) => !castle.exterior[id].destroyed);
}

function availableStagingSlot(state: BattleState, actor: ActorState, turret: BattleTurretState): 0 | 1 | undefined {
  const actorPosition = actorFixed(state, actor.id);
  for (const slot of [0, 1] as const) {
    if (turret.stagingSlots[slot] !== null) continue;
    const stagingPosition = turret.stagingPositions[slot];
    if (withinActionRange(actorPosition, stagingPosition) && hasFloorLineOfSight(state, actor.team, actorPosition, stagingPosition)) return slot;
  }
  return undefined;
}

function firstHandoffCase(state: BattleState, turret: BattleTurretState): { caseState: BattleCaseState; slot: 0 | 1 } | undefined {
  for (const slot of [0, 1] as const) {
    const caseId = turret.stagingSlots[slot];
    if (!caseId) continue;
    const caseState = state.battleCases[caseId];
    if (caseState?.location === "handoff") return { caseState, slot };
  }
  // Keep public fixtures and old snapshots readable while all newly created
  // turrets use stagingSlots as the physical source of truth.
  const legacyId = turret.handoffIds[0];
  const legacyCase = legacyId ? state.battleCases[legacyId] : undefined;
  if (legacyCase?.location === "handoff" && legacyCase.stagingSlot !== undefined) return { caseState: legacyCase, slot: legacyCase.stagingSlot };
  return undefined;
}

function deliverCase(state: BattleState, actor: ActorState, caseState: BattleCaseState, route: BattleRoute | undefined, part: PartId | undefined, events: WorldEvent[]): boolean {
  if (!actor.cargoIds.includes(caseState.id)) return false;
  if (route !== undefined && !isBattleRoute(route)) return false;
  if (part !== undefined && !isPartId(part)) return false;
  const turret = turretAtActor(state, actor);
  if (!turret || turret.team !== actor.team) return false;
  const stagingSlot = availableStagingSlot(state, actor, turret);
  if (stagingSlot === undefined) return false;
  // Route/aim selection is held separately while the case waits on the floor;
  // route/targetPart themselves are captured only when load enqueues it.
  caseState.pendingRoute = route;
  caseState.pendingTargetPart = part;
  caseState.pendingSelectionActorId = actor.id;
  removeFromArray(actor.cargoIds, caseState.id);
  clearCargoSlot(state, actor.id, caseState.id);
  turret.handoffIds.push(caseState.id);
  setCaseHandoff(state, caseState, turret, stagingSlot);
  events.push(event("object_moved", { objectId: caseState.id, location: state.objects[caseState.id].location }));
  return true;
}

function loadHandoff(state: BattleState, actor: ActorState, turret: BattleTurretState, route: BattleRoute | undefined, part: PartId | undefined, events: WorldEvent[]): boolean {
  if (turret.team !== actor.team || turret.queueIds.length >= QUEUE_CAPACITY_PER_TURRET) return false;
  if (route !== undefined && !isBattleRoute(route)) return false;
  if (part !== undefined && !isPartId(part)) return false;
  const handoffSelection = firstHandoffCase(state, turret);
  if (!handoffSelection) return false;
  const { caseState } = handoffSelection;
  const caseId = caseState.id;
  if (!withinActionRange(actorFixed(state, actor.id), caseState.position ?? turret.position) ||
      !hasFloorLineOfSight(state, actor.team, actorFixed(state, actor.id), caseState.position ?? turret.position)) return false;
  // A handoff is not a teleport into the queue: the live operator first picks
  // the physical case up, then places that same case into the turret queue.
  if (!pickCase(state, actor, caseState, events)) return false;
  const cargoSlot = state.cargoSlots[actor.id]?.indexOf(caseId) ?? -1;
  if (cargoSlot < 0) return false;
  removeFromArray(actor.cargoIds, caseId);
  clearCargoSlot(state, actor.id, caseId);
  // Explicit load intent wins over a previously held handoff selection. This
  // is the authoritative enqueue capture point for both route and target.
  const operatorSelection = state.launchSelections[actor.id] ??
    (caseState.pendingSelectionActorId ? state.launchSelections[caseState.pendingSelectionActorId] : undefined);
  caseState.route = route ?? operatorSelection?.route ?? caseState.pendingRoute ?? caseState.route ?? "direct";
  caseState.targetPart = part ?? operatorSelection?.part ?? caseState.pendingTargetPart ?? caseState.targetPart ?? lowestAlivePart(state.castles[actor.team === PLAYER_TEAM ? ENEMY_TEAM : PLAYER_TEAM]);
  caseState.pendingRoute = undefined;
  caseState.pendingTargetPart = undefined;
  caseState.pendingSelectionActorId = undefined;
  turret.queueIds.push(caseId);
  setCaseQueue(state, caseState, turret);
  events.push(event("object_moved", { objectId: caseId, location: state.objects[caseId].location }));
  return true;
}

function compactTurretQueue(state: BattleState, turret: BattleTurretState): void {
  turret.queueIds.forEach((caseId, index) => {
    const caseState = state.battleCases[caseId];
    if (!caseState) return;
    caseState.queueIndex = index;
    syncWorldObject(state, caseState);
  });
}

function interactionCandidates(state: BattleState, actor: ActorState): BattleCaseState[] {
  const actorPosition = actorFixed(state, actor.id);
  return Object.values(state.battleCases).filter((candidate) => {
    if (candidate.location === "consumed" || candidate.location === "flying" || candidate.location === "queue") return false;
    if (candidate.ownerActorId === actor.id) return candidate.ownerGeneration === actor.generation;
    if (actor.location.area !== "castle" || actor.location.castleTeam !== actor.team || candidate.currentTeam !== actor.team) return false;
    return !!candidate.position && withinActionRange(actorPosition, candidate.position) && hasFloorLineOfSight(state, actor.team, actorPosition, candidate.position);
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function validPickupCandidate(state: BattleState, actor: ActorState, slot: number, candidates: BattleCaseState[]): BattleCaseState | undefined {
  if (slot !== 0 && slot !== 1) return undefined;
  if ((state.cargoSlots[actor.id] ?? [null, null])[slot] !== null) return undefined;
  return candidates
    .filter((candidate) => (candidate.location === "floor" || candidate.location === "handoff") &&
      canCarry(carryWeight(state, actor), candidate.weight, actor.cargoIds.length))
    .sort((left, right) => distanceSquared(actorFixed(state, actor.id), left.position ?? actorFixed(state, actor.id)) -
      distanceSquared(actorFixed(state, actor.id), right.position ?? actorFixed(state, actor.id)) || left.id.localeCompare(right.id))[0];
}

function handleIntent(
  state: BattleState,
  intent: BattleIntent,
  actor: ActorState,
  report: StepReport,
  events: WorldEvent[],
  snapshotCandidates: BattleCaseState[] = interactionCandidates(state, actor),
): void {
  if (intent.handle === undefined) return;
  if (!isBattleHandle(intent.handle)) {
    addRejection(report, 0, "invalid_transition", "unknown battle handle");
    return;
  }
  if (intent.handle === "launch" || intent.handle === "intercept") {
    addRejection(report, 0, "invalid_transition", "launch/intercept are simulation-owned actions");
    return;
  }
  if (intent.route !== undefined && !isBattleRoute(intent.route)) {
    addRejection(report, 0, "invalid_transition", "unknown artillery route");
    return;
  }
  if (intent.part !== undefined && !isPartId(intent.part)) {
    addRejection(report, 0, "invalid_transition", "unknown target part");
    return;
  }
  if (actor.protectedUntilTick !== null && state.tick < actor.protectedUntilTick) {
    addRejection(report, 0, "protected_actor");
    return;
  }
  const all = snapshotCandidates;
  const expected = caseToken(state, actor, all);
  if (!intent.contextToken || intent.contextToken !== expected) {
    addRejection(report, 0, "invalid_object_transition", "candidate snapshot is stale");
    return;
  }
  const slot = intent.slot ?? 0;
  if (!Number.isInteger(slot) || slot < 0 || slot > 1) {
    addRejection(report, 0, "invalid_object_transition", "slot must be 0 or 1");
    return;
  }
  let candidate: BattleCaseState | undefined;
  if (intent.handle === "pickup") {
    // Pickup and getInteraction share the same nearest *carryable* candidate;
    // an overweight nearby case must not mask a valid lighter one.
    candidate = validPickupCandidate(state, actor, slot, all);
    if (intent.slot !== undefined && (intent.slot !== 0 && intent.slot !== 1)) {
      addRejection(report, 0, "invalid_object_transition", "slot must be 0 or 1");
      return;
    }
    if (!candidate || !pickCase(state, actor, candidate, events, intent.slot ?? 0)) {
      addRejection(report, 0, "invalid_object_transition", "no pickable case in slot");
      return;
    }
  } else if (intent.handle === "drop") {
    const selectedId = state.cargoSlots[actor.id]?.[slot] ?? null;
    candidate = selectedId ? state.battleCases[selectedId] : undefined;
    if (!candidate || !actor.cargoIds.includes(candidate.id)) {
      addRejection(report, 0, "invalid_object_transition", "case is not owned");
      return;
    }
    removeFromArray(actor.cargoIds, candidate.id);
    clearCargoSlot(state, actor.id, candidate.id);
    setCaseFloor(state, candidate, actorFixed(state, actor.id), actor.team);
    events.push(event("object_moved", { objectId: candidate.id, location: state.objects[candidate.id].location }));
  } else if (intent.handle === "deliver") {
    const selectedId = state.cargoSlots[actor.id]?.[slot] ?? null;
    candidate = selectedId ? state.battleCases[selectedId] : undefined;
    if (!candidate || !deliverCase(state, actor, candidate, intent.route, intent.part, events)) {
      addRejection(report, 0, "invalid_object_transition", "case is not owned or destination is unavailable");
      return;
    }
  } else if (intent.handle === "load") {
    const turret = turretAtActor(state, actor);
    if (!turret || !loadHandoff(state, actor, turret, intent.route, intent.part, events)) {
      addRejection(report, 0, "invalid_object_transition", "handoff or queue unavailable");
      return;
    }
  }
  report.acceptedInputKinds.push(`handle:${intent.handle}`);
}

function shooterForTurret(state: BattleState, turret: BattleTurretState, startActors: Record<string, ActorState>): ActorState | undefined {
  return turret.operatorActorIds.map((actorId) => state.actors[actorId]).filter((actor): actor is ActorState => !!actor).find((actor) => {
    const start = startActors[actor.id];
    return !!start && start.alive && actor.alive && actor.location.area === "castle" && actor.location.castleTeam === actor.team &&
      start.generation === actor.generation && !actorIsProtected(state, actor) &&
      (start.protectedUntilTick === null || state.tick >= start.protectedUntilTick) &&
      withinActionRange(actorFixed(state, actor.id), turret.position) && hasFloorLineOfSight(state, actor.team, actorFixed(state, actor.id), turret.position);
  });
}

function launchOne(state: BattleState, turret: BattleTurretState, startActors: Record<string, ActorState>, events: WorldEvent[]): boolean {
  if (turret.queueIds.length === 0 || Object.keys(state.artillery.flights).length >= MAX_FLIGHT_COUNT) return false;
  if (turret.stoppedUntilTick !== null && state.tick < turret.stoppedUntilTick) return false;
  const shooter = shooterForTurret(state, turret, startActors);
  if (!shooter) return false;
  const caseId = turret.queueIds.shift()!;
  compactTurretQueue(state, turret);
  const caseState = state.battleCases[caseId];
  if (!caseState) return false;
  const flightId = `flight-${state.tick}-${turret.team}-${turret.id}-${caseId}`;
  const route = caseState.route ?? "direct";
  const targetTeam = turret.team === PLAYER_TEAM ? ENEMY_TEAM : PLAYER_TEAM;
  const definition = caseDefinition(caseState.type)!;
  const flight: BattleFlightState = {
    id: flightId,
    objectId: caseId,
    team: turret.team,
    sourceActorId: shooter.id,
    sourceGeneration: shooter.generation,
    targetTeam,
    route,
    progress: 0,
    targetPart: caseState.targetPart,
    interceptRemaining: definition.interceptHits,
    createdTick: state.tick,
    distanceUnits: ROUTE_LENGTH_UNITS[route],
    speedUnitsPerSecond: definition.flightSpeedUnitsPerSecond,
    previousProgress: 0,
  };
  state.artillery.flights[flightId] = flight;
  caseState.interceptRemaining = definition.interceptHits;
  caseState.location = "flying";
  caseState.currentTeam = turret.team;
  caseState.position = undefined;
  caseState.currentPosition = undefined;
  caseState.ownerActorId = undefined;
  caseState.ownerGeneration = undefined;
  caseState.turretId = undefined;
  caseState.queueIndex = undefined;
  caseState.flightId = flightId;
  caseState.stagingSlot = undefined;
  caseState.pendingRoute = undefined;
  caseState.pendingTargetPart = undefined;
  syncWorldObject(state, caseState);
  state.projectiles[flightId] = {
    id: flightId,
    objectId: caseId,
    team: turret.team,
    sourceActorId: shooter.id,
    sourceGeneration: shooter.generation,
    targetTeam,
    targetPartId: caseState.targetPart,
  };
  events.push(event("projectile_launched", { projectileId: flightId, objectId: caseId, sourceActorId: shooter.id, sourceGeneration: shooter.generation, team: turret.team, turretId: turret.id, route, targetPart: caseState.targetPart }));
  return true;
}

function autoLoadAtTurrets(state: BattleState, events: WorldEvent[]): void {
  for (const turret of Object.values(state.artillery.turrets).sort((left, right) => `${left.team}:${left.id}`.localeCompare(`${right.team}:${right.id}`))) {
    while (turret.queueIds.length < QUEUE_CAPACITY_PER_TURRET && turret.handoffIds.length > 0) {
      const selected = firstHandoffCase(state, turret);
      if (!selected) {
        turret.handoffIds.shift();
        continue;
      }
      const handoff = selected.caseState;
      // Pick a live, unprotected operator that can actually accept this case.
      // P1 may be the first deterministic operator but have a full/overweight
      // cargo load while P2/P3 are available at the same turret.
      const operator = turret.operatorActorIds
        .map((id) => state.actors[id])
        .filter((actor): actor is ActorState => !!actor && actor.alive && !actorIsProtected(state, actor) &&
          withinActionRange(actorFixed(state, actor.id), turret.position) &&
          hasFloorLineOfSight(state, actor.team, actorFixed(state, actor.id), turret.position) &&
          withinActionRange(actorFixed(state, actor.id), handoff.position ?? turret.position) &&
          hasFloorLineOfSight(state, actor.team, actorFixed(state, actor.id), handoff.position ?? turret.position) &&
          canCarry(carryWeight(state, actor), handoff.weight, actor.cargoIds.length))
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      if (!operator) break;
      // A failed load must make progress impossible for this handoff/operator
      // pair; break rather than spinning on an unchanged staging entry.
      if (!loadHandoff(state, operator, turret, undefined, undefined, events)) break;
    }
  }
}

function autoLaunch(state: BattleState, startActors: Record<string, ActorState>, events: WorldEvent[]): void {
  for (const team of ALL_TEAMS) {
    if (state.tick < state.artillery.nextLaunchTick[team]) continue;
    const turrets = Object.values(state.artillery.turrets).filter((turret) => turret.team === team).sort((left, right) => left.id.localeCompare(right.id));
    if (turrets.length === 0) continue;
    const startIndex = state.artillery.roundRobinTurretIndex[team] % turrets.length;
    for (let offset = 0; offset < turrets.length; offset += 1) {
      const turret = turrets[(startIndex + offset) % turrets.length];
      if (!launchOne(state, turret, startActors, events)) continue;
      state.artillery.nextLaunchTick[team] = state.tick + SHARED_LAUNCH_COOLDOWN_TICKS;
      state.nextLaunchTick[team] = state.artillery.nextLaunchTick[team];
      state.artillery.roundRobinTurretIndex[team] = (startIndex + offset + 1) % turrets.length;
      break;
    }
  }
}

function consumeFlight(state: BattleState, flight: BattleFlightState, reason: string, events?: WorldEvent[]): void {
  const caseState = state.battleCases[flight.objectId];
  if (caseState) setCaseConsumed(state, caseState, reason);
  if (events) events.push(event("object_consumed", { objectId: flight.objectId, reason }));
  delete state.projectiles[flight.id];
  delete state.artillery.flights[flight.id];
  for (const key of Object.keys(state.artillery.contactPairs)) {
    if (key.split("|").includes(flight.id)) delete state.artillery.contactPairs[key];
  }
}

function flightPairs(state: BattleState): Array<[BattleFlightState, BattleFlightState]> {
  const flights = Object.values(state.artillery.flights).sort((left, right) => left.id.localeCompare(right.id));
  const pairs: Array<[BattleFlightState, BattleFlightState]> = [];
  for (let left = 0; left < flights.length; left += 1) for (let right = left + 1; right < flights.length; right += 1) {
    if (flights[left].team !== flights[right].team && flights[left].route === flights[right].route) pairs.push([flights[left], flights[right]]);
  }
  return pairs;
}

function flightContactTime(first: BattleFlightState, second: BattleFlightState): number | undefined {
  const previousSum = first.previousProgress + second.previousProgress;
  const currentSum = first.progress + second.progress;
  // Projectile movement is continuous over the fixed tick. A collision is a
  // crossing of the route midpoint condition, not an equality test on the
  // two end positions (which misses fast 0.45 -> 0.55 crossings).
  if (previousSum > 1 + ROUTE_COLLISION_EPSILON || currentSum < 1 - ROUTE_COLLISION_EPSILON) return undefined;
  const delta = currentSum - previousSum;
  if (Math.abs(delta) < Number.EPSILON) return Math.abs(currentSum - 1) <= ROUTE_COLLISION_EPSILON ? 0 : undefined;
  const time = (1 - previousSum) / delta;
  return time >= -ROUTE_COLLISION_EPSILON && time <= 1 + ROUTE_COLLISION_EPSILON ? Math.max(0, Math.min(1, time)) : undefined;
}

function resolveFlightContact(state: BattleState, first: BattleFlightState, second: BattleFlightState, events: WorldEvent[]): void {
  const key = [first.id, second.id].sort().join("|");
  const time = flightContactTime(first, second);
  if (time === undefined) {
    if (first.previousProgress + second.previousProgress > 1 + ROUTE_COLLISION_EPSILON) delete state.artillery.contactPairs[key];
    return;
  }
  if (state.artillery.contactPairs[key]) return;
  state.artillery.contactPairs[key] = true;
  first.interceptRemaining -= 1;
  second.interceptRemaining -= 1;
  const firstCase = state.battleCases[first.objectId];
  const secondCase = state.battleCases[second.objectId];
  if (firstCase) firstCase.interceptRemaining = first.interceptRemaining;
  if (secondCase) secondCase.interceptRemaining = second.interceptRemaining;
  events.push(event("projectile_intercepted", { firstProjectileId: first.id, secondProjectileId: second.id }));
  if (first.interceptRemaining <= 0) consumeFlight(state, first, "intercepted", events);
  if (second.interceptRemaining <= 0) consumeFlight(state, second, "intercepted", events);
}

interface FlightContactCandidate {
  first: BattleFlightState;
  second: BattleFlightState;
  time: number;
}

function flightContactCandidates(state: BattleState): FlightContactCandidate[] {
  return flightPairs(state)
    .map(([first, second]) => ({ first, second, time: flightContactTime(first, second) }))
    .filter((candidate): candidate is FlightContactCandidate => candidate.time !== undefined)
    .filter((candidate) => !state.artillery.contactPairs[[candidate.first.id, candidate.second.id].sort().join("|")])
    .sort((left, right) => {
      const leftObjects = [left.first.objectId, left.second.objectId].sort((a, b) => a.localeCompare(b));
      const rightObjects = [right.first.objectId, right.second.objectId].sort((a, b) => a.localeCompare(b));
      return left.time - right.time || leftObjects[0].localeCompare(rightObjects[0]) || leftObjects[1].localeCompare(rightObjects[1]);
    });
}

function destroyPartsAndOpenGates(state: BattleState, team: TeamId, events: WorldEvent[]): void {
  const castle = state.castles[team];
  const previous = new Set(castle.destroyedPartIds);
  let previousGateCount = castle.openGateIds.length;
  const destroyed = PART_IDS.filter((partId) => castle.exterior[partId].destroyed);
  castle.destroyedPartIds = [...destroyed];
  castle.openGateIds = GATE_IDS.slice(0, destroyed.length);
  for (let index = 0; index < GATE_IDS.length; index += 1) castle.gates[GATE_IDS[index]].open = index < destroyed.length;
  destroyed.forEach((partId) => {
    if (!previous.has(partId)) {
      const gateId = GATE_IDS[Math.min(previousGateCount, GATE_IDS.length - 1)];
      events.push(event("part_destroyed", { team, partId, gateId }));
      // A same-tick batch of new parts consumes successive prefix gates.
      previousGateCount += 1;
    }
  });
}

function targetPartAtImpact(state: BattleState, targetTeam: TeamId, requested: PartId | undefined, startCastle: BattleState["castles"][TeamId]): PartId | undefined {
  if (requested && !startCastle.exterior[requested].destroyed) return requested;
  return lowestAlivePart(startCastle);
}

function resolveFlights(state: BattleState, events: WorldEvent[]): void {
  const startCastles = structuredClone(state.castles);
  const current = Object.values(state.artillery.flights).sort((left, right) => left.id.localeCompare(right.id));
  for (const flight of current) {
    if (!state.artillery.flights[flight.id]) continue;
    // A launch is an end-of-tick effect; the fresh projectile starts moving
    // on the following fixed update.
    if (flight.createdTick === state.tick) continue;
    flight.previousProgress = flight.progress;
    flight.progress = Math.min(1, flight.progress + flight.speedUnitsPerSecond / 60 / flight.distanceUnits);
  }
  for (const [first, second] of flightPairs(state)) {
    const key = [first.id, second.id].sort().join("|");
    if (flightContactTime(first, second) === undefined && first.previousProgress + second.previousProgress > 1 + ROUTE_COLLISION_EPSILON) {
      delete state.artillery.contactPairs[key];
    }
  }
  for (const candidate of flightContactCandidates(state)) {
    const { first, second } = candidate;
    if (first.createdTick === state.tick || second.createdTick === state.tick) continue;
    if (state.artillery.flights[first.id] && state.artillery.flights[second.id]) resolveFlightContact(state, first, second, events);
  }
  const impactGroups = new Map<string, Array<{ flight: BattleFlightState; caseState: BattleCaseState; targetPart?: PartId }>>();
  for (const flight of Object.values(state.artillery.flights).sort((left, right) => left.id.localeCompare(right.id))) {
    if (flight.progress < 1) continue;
    const caseState = state.battleCases[flight.objectId];
    if (!caseState) continue;
    const targetPart = targetPartAtImpact(state, flight.targetTeam, flight.targetPart, startCastles[flight.targetTeam]);
    const key = `${flight.targetTeam}:${targetPart ?? "none"}`;
    const group = impactGroups.get(key) ?? [];
    group.push({ flight, caseState, targetPart });
    impactGroups.set(key, group);
  }
  for (const [key, impacts] of impactGroups) {
    const [targetTeam, requestedPart] = key.split(":") as [TeamId, PartId | "none"];
    const partId = requestedPart === "none" ? undefined : requestedPart;
    if (partId && !startCastles[targetTeam].exterior[partId].destroyed) {
      const amount = impacts.reduce((sum, impact) => sum + (caseDefinition(impact.caseState.type)?.partDamage ?? 0), 0);
      const part = state.castles[targetTeam].exterior[partId];
      const oldHealth = part.health;
      part.health = Math.max(0, part.health - amount);
      if (oldHealth !== part.health) events.push(event("part_damaged", { team: targetTeam, partId, amount: oldHealth - part.health }));
      if (part.health === 0) part.destroyed = true;
    }
    for (const impact of impacts) {
      events.push(event("projectile_impacted", { projectileId: impact.flight.id, objectId: impact.caseState.id, targetTeam, targetPart: impact.targetPart }));
      consumeFlight(state, impact.flight, "impact", events);
    }
  }
  destroyPartsAndOpenGates(state, PLAYER_TEAM, events);
  destroyPartsAndOpenGates(state, ENEMY_TEAM, events);
}

function pruneRetiredLogistics(state: BattleState): void {
  // Consumption history is carried by the bounded event log/lastStep. Keep
  // only live cases and groups in the cloned simulation state so a long match
  // cannot grow one immutable snapshot per retired supply group.
  for (const [groupId, group] of Object.entries(state.logistics.groups)) {
    if (!group.retired) continue;
    for (const caseId of group.caseIds) {
      const caseState = state.battleCases[caseId];
      if (caseState?.location === "consumed") delete state.battleCases[caseId];
      if (state.objects[caseId]?.location.kind === "consumed") delete state.objects[caseId];
    }
    delete state.logistics.groups[groupId];
  }
  for (const [caseId, caseState] of Object.entries(state.battleCases)) {
    if (caseState.location !== "consumed") continue;
    const belongsToLiveGroup = Object.values(state.logistics.groups).some((group) => !group.retired && group.caseIds.includes(caseId));
    if (!belongsToLiveGroup) {
      delete state.battleCases[caseId];
      if (state.objects[caseId]?.location.kind === "consumed") delete state.objects[caseId];
    }
  }
}

function resetAssignment(state: BattleState, actorId: ActorId): void {
  state.crew.assignments[actorId] = { actorId, task: "idle", path: [], pathIndex: 0 };
}

function actorTargetPath(state: BattleState, actor: ActorState, target: FixedPoint): Point[] {
  if (!actor.location.castleTeam) return [];
  const team = actor.location.castleTeam;
  const from = readCell(actorFixed(state, actor.id));
  const candidates = walkableApproachCells(state, team, target);
  const direct = readCell(target);
  if (!candidates.some((cell) => cell.x === direct.x && cell.y === direct.y)) candidates.push(direct);
  let best: Point[] = [];
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestVerticalOffset = Number.POSITIVE_INFINITY;
  let bestHorizontalOffset = Number.POSITIVE_INFINITY;
  for (const cell of candidates) {
    const path = nearestCellPath(state, team, from, cell);
    if (path.length === 0) continue;
    const endpoint = { x: cellCenter(cell.x), y: cellCenter(cell.y) };
    const distance = distanceSquared(endpoint, target);
    const targetCell = readCell(target);
    const verticalOffset = Math.abs(cell.y - targetCell.y);
    const horizontalOffset = Math.abs(cell.x - targetCell.x);
    if (best.length === 0 || distance < bestDistance ||
      (distance === bestDistance && (verticalOffset < bestVerticalOffset ||
        (verticalOffset === bestVerticalOffset && (horizontalOffset < bestHorizontalOffset ||
          (horizontalOffset === bestHorizontalOffset && path.length < best.length)))))) {
      best = path;
      bestDistance = distance;
      bestVerticalOffset = verticalOffset;
      bestHorizontalOffset = horizontalOffset;
    }
  }
  return best;
}

function chooseCarrierCase(state: BattleState, actor: ActorState): BattleCaseState | undefined {
  const candidates = Object.values(state.battleCases).filter((item) => {
    if (item.location !== "floor" || item.currentTeam !== actor.team) return false;
    if (actor.role !== "ammo_carrier") return true;
    const port = state.logistics.ports[portKey(actor.team, item.sourcePortId)];
    return port?.roomId === actor.homeRoomId;
  });
  return candidates.sort((left, right) => distanceSquared(actorFixed(state, actor.id), left.position ?? actorFixed(state, actor.id)) - distanceSquared(actorFixed(state, actor.id), right.position ?? actorFixed(state, actor.id)) || left.id.localeCompare(right.id))[0];
}

function processCarrierAI(state: BattleState, actor: ActorState, events: WorldEvent[]): void {
  if (!actor.alive || actor.location.area !== "castle") return;
  const assignment = state.crew.assignments[actor.id] ?? { actorId: actor.id, task: "idle" as CrewTask, path: [], pathIndex: 0 };
  const carried = actor.cargoIds.map((id) => state.battleCases[id]).filter((item): item is BattleCaseState => !!item);
  if (carried.length === 0) {
    const target = chooseCarrierCase(state, actor);
    if (!target?.position) {
      assignment.task = "idle";
      assignment.path = [];
      state.crew.assignments[actor.id] = assignment;
      return;
    }
    assignment.task = "carry";
    // The previous delivery path points from the turret back to the supply
    // room. A newly selected case must always build a fresh outbound path.
    assignment.targetTurretId = undefined;
    if (assignment.targetCaseId !== target.id || assignment.path.length === 0) {
      assignment.targetCaseId = target.id;
      assignment.path = actorTargetPath(state, actor, target.position);
      assignment.pathIndex = 0;
      assignment.stuckTicks = 0;
    }
    moveAIAlongPath(state, actor, assignment, target.position);
    // Spawn protection allows movement, but never lets an AI manipulate a
    // case. The same restriction is applied to the manual handle path.
    if (!actorIsProtected(state, actor) && withinActionRange(actorFixed(state, actor.id), target.position)) {
      pickCase(state, actor, target, events);
    }
    state.crew.assignments[actor.id] = assignment;
    return;
  }
  const first = carried[0];
  const turret = turretForPort(state, actor.team, first.sourcePortId) ?? Object.values(state.artillery.turrets).find((item) => item.team === actor.team);
  if (!turret) return;
  assignment.task = "deliver";
  if (assignment.targetTurretId !== turret.id || assignment.path.length === 0) {
    assignment.targetTurretId = turret.id;
    assignment.path = actorTargetPath(state, actor, turret.operatorPosition);
    assignment.pathIndex = 0;
    assignment.stuckTicks = 0;
  }
  moveAIAlongPath(state, actor, assignment, turret.operatorPosition);
  if (!actorIsProtected(state, actor) && availableStagingSlot(state, actor, turret) !== undefined) {
    let delivered = false;
    for (const item of [...carried]) {
      if (turret.handoffIds.length >= STAGING_SLOTS_PER_TURRET) break;
      delivered = deliverCase(state, actor, item, undefined, undefined, events) || delivered;
    }
    if (delivered && actor.cargoIds.length === 0) {
      assignment.task = "idle";
      assignment.path = [];
      assignment.pathIndex = 0;
      assignment.targetCaseId = undefined;
      assignment.targetTurretId = undefined;
      assignment.stuckTicks = 0;
    }
  }
  state.crew.assignments[actor.id] = assignment;
}

function processShooterAI(state: BattleState, actor: ActorState): void {
  if (!actor.alive || actor.location.area !== "castle" || !actor.turretId) return;
  const turret = state.artillery.turrets[turretKey(actor.team, actor.turretId)];
  if (!turret) return;
  const assignment = state.crew.assignments[actor.id] ?? { actorId: actor.id, task: "operate" as CrewTask, path: [], pathIndex: 0 };
  assignment.task = "operate";
  if (assignment.targetTurretId !== turret.id || assignment.path.length === 0) {
    assignment.targetTurretId = turret.id;
    assignment.path = actorTargetPath(state, actor, turret.operatorPosition);
    assignment.pathIndex = 0;
    assignment.stuckTicks = 0;
  }
  moveAIAlongPath(state, actor, assignment, turret.operatorPosition);
  state.crew.assignments[actor.id] = assignment;
}

function processCrewAI(state: BattleState, events: WorldEvent[]): void {
  for (const actor of Object.values(state.actors).sort((left, right) => left.id.localeCompare(right.id))) {
    if (actor.role === "ammo_carrier" || actor.role === "support") processCarrierAI(state, actor, events);
    else if (actor.role === "shooter") processShooterAI(state, actor);
  }
}

function markDeathIfNeeded(state: BattleState, events: WorldEvent[]): void {
  for (const actor of Object.values(state.actors)) {
    if (!actor.alive || actor.health > 0 || actor.respawnAtTick !== null) continue;
    dropActorCargo(state, actor, events);
    actor.alive = false;
    actor.health = 0;
    actor.deathCount += 1;
    actor.lastDeathTick = state.tick;
    actor.respawnAtTick = state.tick + (actor.team === PLAYER_TEAM ? state.rules.playerRespawnTicks : state.rules.enemyRespawnTicks);
    actor.turretControlIds = [];
    resetAssignment(state, actor.id);
    events.push(event("actor_died", { actorId: actor.id, generation: actor.generation, respawnAtTick: actor.respawnAtTick }));
  }
}

function finishRespawns(state: BattleState, events: WorldEvent[]): void {
  for (const actor of Object.values(state.actors)) {
    if (actor.alive || actor.respawnAtTick === null || state.tick < actor.respawnAtTick) continue;
    const pad = padById(teamLayout(state, actor.team), actor.respawnPadId);
    if (!pad) continue;
    actor.alive = true;
    actor.health = actor.maxHealth;
    actor.generation += 1;
    actor.respawnAtTick = null;
    actor.protectedUntilTick = state.tick + state.rules.spawnProtectionTicks;
    actor.currentRoomId = actor.respawnRoomId;
    actor.location = { area: "castle", castleTeam: actor.team, roomId: actor.respawnRoomId, pathRooms: [actor.respawnRoomId], pathGates: [] };
    actor.cargoIds = [];
    state.cargoSlots[actor.id] = [null, null];
    actor.reservationIds = [];
    actor.turretControlIds = actor.turretId ? [actor.turretId] : [];
    setActorFixed(state, actor, { x: cellCenter(pad.cell.x), y: cellCenter(pad.cell.y) });
    state.fixedActors[actor.id].remainder = { x: 0, y: 0 };
    resetAssignment(state, actor.id);
    events.push(event("actor_respawned", { actorId: actor.id, generation: actor.generation, tick: state.tick }));
  }
}

function makePorts(state: BattleState): Record<string, BattlePortState> {
  const ports: Record<string, BattlePortState> = {};
  for (const team of ALL_TEAMS) {
    const layout = teamLayout(state, team);
    layout.supplyPorts.forEach((port, index) => {
      ports[portKey(team, port.id)] = {
        id: port.id,
        team,
        roomId: port.roomId,
        position: { x: cellCenter(port.cell.x), y: cellCenter(port.cell.y) },
        nextSpawnTick: SUPPLY_FIRST_DELAY_TICKS[index] ?? SUPPLY_FIRST_DELAY_TICKS[0],
        groupCount: 0,
        groupSequence: 0,
        stoppedUntilTick: null,
      };
    });
  }
  return ports;
}

function makeTurrets(state: BattleState): Record<string, BattleTurretState> {
  const turrets: Record<string, BattleTurretState> = {};
  for (const team of ALL_TEAMS) {
    for (const definition of teamLayout(state, team).turrets) {
      const operators: ActorId[] = team === ENEMY_TEAM && definition.operatorActorId ? [definition.operatorActorId] : ["P1", "P2", "P3"];
      const position = { x: cellCenter(definition.cell.x), y: cellCenter(definition.cell.y) };
      const positionSource = { team, position };
      const operatorPosition = getTurretOperatorPosition(positionSource);
      const stagingPositions: [FixedPoint, FixedPoint] = [
        getHandoffPosition(positionSource, 0),
        getHandoffPosition(positionSource, 1),
      ];
      turrets[turretKey(team, definition.id)] = {
        id: definition.id,
        team,
        position,
        roomId: definition.roomId,
        queueIds: [],
        handoffIds: [],
        stagingSlots: [null, null],
        stagingPositions,
        operatorPosition,
        stoppedUntilTick: null,
        operatorActorIds: operators,
      };
    }
  }
  return turrets;
}

function makeCrew(state: BattleState): BattleCrewState {
  const assignments: Record<string, CrewAssignment> = {};
  for (const actor of Object.values(state.actors)) assignments[actor.id] = { actorId: actor.id, task: "idle", path: [], pathIndex: 0 };
  return { assignments };
}

export function createBattle(options: { matchId: string; seed: number }): BattleState {
  const world = createWorld({ matchId: options.matchId, seed: options.seed });
  const state = {
    ...world,
    fixedActors: Object.fromEntries(Object.values(world.actors).map((actor) => [actor.id, { position: { x: cellCenter(actor.position.x), y: cellCenter(actor.position.y) }, remainder: { x: 0, y: 0 } }])) as BattleState["fixedActors"],
    cargoSlots: Object.fromEntries(Object.keys(world.actors).map((actorId) => [actorId, [null, null]])) as BattleState["cargoSlots"],
    battleCases: {},
    logistics: {
      ports: {},
      groups: {},
      bags: { player: seededSupplyBag(world.seed, PLAYER_TEAM, 0), enemy: seededSupplyBag(world.seed, ENEMY_TEAM, 0) },
      bagIndices: { player: 0, enemy: 0 },
      bagCycles: { player: 0, enemy: 0 },
    },
    artillery: { turrets: {}, flights: {}, nextLaunchTick: { player: 0, enemy: 0 }, roundRobinTurretIndex: { player: 0, enemy: 0 }, contactPairs: {} },
    crew: { assignments: {} },
    launchSelections: {},
    nextLaunchTick: { player: 0, enemy: 0 },
    eventLogLimit: EVENT_LOG_LIMIT,
  } as BattleState;
  state.logistics.ports = makePorts(state);
  state.artillery.turrets = makeTurrets(state);
  state.crew = makeCrew(state);
  return state;
}

function resolveActor(state: BattleState, intent: BattleIntent, report: StepReport): ActorState | undefined {
  const actorId = intent.actorId;
  if (actorId !== "P1") {
    addRejection(report, 0, "unknown_actor", "public battle input is limited to P1");
    return undefined;
  }
  const actor = state.actors[actorId];
  if (!actor) {
    addRejection(report, 0, "unknown_actor", actorId);
    return undefined;
  }
  if (!Number.isInteger(intent.generation)) {
    addRejection(report, 0, "missing_generation", `${actorId} generation is required`);
    return undefined;
  }
  if (intent.generation !== undefined && intent.generation !== actor.generation) {
    addRejection(report, 0, "stale_generation", `${actorId} generation ${intent.generation} != ${actor.generation}`);
    return undefined;
  }
  if (!actor.alive) {
    addRejection(report, 0, "dead_actor");
    return undefined;
  }
  return actor;
}

function applyIntent(state: BattleState, intent: BattleIntent | undefined, report: StepReport, events: WorldEvent[]): void {
  if (!intent) return;
  if (!intent.matchId) {
    addRejection(report, 0, "missing_match");
    return;
  }
  if (intent.matchId !== state.matchId) {
    addRejection(report, 0, "wrong_match");
    return;
  }
  const actor = resolveActor(state, intent, report);
  if (!actor) return;
  // Route/part are presentation selections, not object identifiers. Retain
  // the latest validated values so an automatic operator load captures the
  // selection that was current at the actual enqueue tick.
  if (intent.route !== undefined && !isBattleRoute(intent.route)) {
    addRejection(report, 0, "invalid_transition", "unknown artillery route");
    return;
  }
  if (intent.part !== undefined && !isPartId(intent.part)) {
    addRejection(report, 0, "invalid_transition", "unknown target part");
    return;
  }
  if (intent.route !== undefined || intent.part !== undefined) {
    const previous = state.launchSelections[actor.id] ?? {};
    state.launchSelections[actor.id] = {
      route: intent.route ?? previous.route,
      part: intent.part ?? previous.part,
    };
  }
  // The UI obtains its opaque token from the tick-start interaction. Latch
  // that candidate set before movement so a simultaneous direction update
  // cannot invalidate a legitimate near-boundary handling action.
  const snapshotCandidates = interactionCandidates(state, actor);
  if (intent.handle !== undefined) handleIntent(state, intent, actor, report, events, snapshotCandidates);
  if (intent.direction !== undefined) {
    if (intent.direction.x === 0 && intent.direction.y === 0) {
      // A held movement pad commonly reports its neutral vector each tick.
    } else if (!isFiniteDirection(intent.direction)) addRejection(report, 0, "invalid_transition", "direction must be a unit vector");
    else {
      moveFixed(state, actor, intent.direction);
      report.acceptedInputKinds.push("direction");
    }
  }
}

function updateCaseCarriedPositions(state: BattleState): void {
  for (const caseState of Object.values(state.battleCases)) if (caseState.location === "carried" && caseState.ownerActorId) {
    caseState.currentPosition = copyPoint(actorFixed(state, caseState.ownerActorId));
    syncWorldObject(state, caseState);
  }
}

function advanceBattleTick(state: BattleState, intent: BattleIntent | undefined): BattleState {
  const next = cloneBattle(state);
  const report = emptyReport();
  next.lastStep = report;
  const events: WorldEvent[] = [];
  if (next.phase === "ended") {
    if (intent) addRejection(report, 0, "ended");
    return next;
  }
  if (next.phase === "paused" || next.visibility !== "visible") {
    if (intent) addRejection(report, 0, "paused");
    return next;
  }
  const currentTick = next.tick;
  report.processedTick = currentTick;
  const startActors = structuredClone(next.actors);
  applyIntent(next, intent, report, events);
  markDeathIfNeeded(next, events);
  processCrewAI(next, events);
  updateCaseCarriedPositions(next);
  autoLoadAtTurrets(next, events);
  autoLaunch(next, startActors, events);
  resolveFlights(next, events);
  spawnSupply(next, events);
  markDeathIfNeeded(next, events);

  let finalOutcome: BattleState["outcome"] = "ongoing";
  if (currentTick >= next.matchLimitTicks - 1) finalOutcome = "draw";
  if (finalOutcome !== "ongoing") {
    next.outcome = finalOutcome;
    next.phase = "ended";
    for (const actor of Object.values(next.actors)) if (!actor.alive) actor.respawnAtTick = null;
    events.push(event("outcome", { outcome: finalOutcome, tick: currentTick }));
  } else finishRespawns(next, events);

  next.tick = currentTick + 1;
  next.randomState = xorshift32(next.randomState);
  report.advanced = true;
  report.events = events;
  next.eventLog = [...next.eventLog, ...events].slice(-next.eventLogLimit);
  pruneRetiredLogistics(next);
  syncAllWorldObjects(next);
  assertObjectLocationsUnique(next);
  return next;
}

export function stepBattle(state: BattleState, intent?: BattleIntent): BattleState {
  return advanceBattleTick(state, intent);
}

export function pauseBattle(state: BattleState): BattleState {
  const next = cloneBattle(state);
  if (next.phase === "ended") return next;
  if (!next.pauseReasons.includes("explicit" as PauseReason)) next.pauseReasons.push("explicit" as PauseReason);
  next.phase = "paused";
  return next;
}

export function setBattleVisibility(state: BattleState, visible: boolean): BattleState {
  const next = cloneBattle(state);
  if (next.phase === "ended") return next;
  const wasHidden = next.visibility === "hidden" || next.pauseReasons.includes("visibility" as PauseReason);
  next.visibility = visible ? "visible" : "hidden";
  if (!visible) {
    if (!next.pauseReasons.includes("visibility" as PauseReason)) next.pauseReasons.push("visibility" as PauseReason);
  } else {
    next.pauseReasons = next.pauseReasons.filter((reason) => reason !== "visibility");
    if (wasHidden && !next.pauseReasons.includes("explicit" as PauseReason)) next.pauseReasons.push("explicit" as PauseReason);
  }
  next.phase = next.pauseReasons.length > 0 ? "paused" : "running";
  return next;
}

export function resumeBattle(state: BattleState): BattleState {
  const next = cloneBattle(state);
  if (next.phase === "ended") return next;
  next.pauseReasons = next.pauseReasons.filter((reason) => reason !== "explicit");
  next.phase = next.pauseReasons.length || next.visibility !== "visible" ? "paused" : "running";
  return next;
}

export function getInteraction(state: BattleState, actorId: ActorId = "P1", slot: number = 0): BattleInteraction {
  const actor = state.actors[actorId];
  const fixed = actor ? actorFixed(state, actor.id) : { x: 0, y: 0 };
  const candidates = actor ? interactionCandidates(state, actor) : [];
  const contextToken = actor ? caseToken(state, actor, candidates) : `${state.tick}|${actorId}|unknown`;
  const candidateViews = candidates.map((candidate) => caseView(candidate, contextToken));
  const validSlot = slot === 0 || slot === 1;
  const selectedSlot = validSlot ? slot as 0 | 1 : undefined;
  const selectedCaseId = actor && selectedSlot !== undefined ? state.cargoSlots[actor.id]?.[selectedSlot] ?? null : null;
  const selectedCase = selectedCaseId ? state.battleCases[selectedCaseId] : undefined;
  const pickupCandidate = actor && validSlot ? validPickupCandidate(state, actor, slot, candidates) : undefined;
  const turret = actor ? turretAtActor(state, actor) : undefined;
  const handles: BattleHandle[] = [];
  const actionable = !!actor && actor.alive && !actorIsProtected(state, actor) && validSlot;
  const selectedOwned = !!selectedCase && selectedCase.location === "carried" && selectedCase.ownerActorId === actorId && selectedCase.ownerGeneration === actor?.generation;
  if (actionable && selectedOwned && turret && availableStagingSlot(state, actor!, turret) !== undefined) handles.push("deliver");
  if (actionable && selectedOwned) handles.push("drop");
  const loadCandidate = turret ? firstHandoffCase(state, turret)?.caseState : undefined;
  if (actionable && turret && loadCandidate && turret.queueIds.length < QUEUE_CAPACITY_PER_TURRET &&
      canCarry(carryWeight(state, actor!), loadCandidate.weight, actor!.cargoIds.length) &&
      loadCandidate.position && withinActionRange(fixed, loadCandidate.position) && hasFloorLineOfSight(state, actor!.team, fixed, loadCandidate.position)) handles.push("load");
  if (actionable && !selectedOwned && pickupCandidate) handles.push("pickup");
  const queue: string[] = [];
  const queueEntries: Array<{ id: string; turretId: string; slot: number }> = [];
  if (actor) for (const candidate of Object.values(state.battleCases).filter((item) => item.location === "queue" && item.currentTeam === actor.team).sort((left, right) => left.id.localeCompare(right.id))) {
    queue.push(candidate.id);
    queueEntries.push({ id: candidate.id, turretId: candidate.turretId ?? "", slot: candidate.queueIndex ?? 0 });
  }
  return {
    actorId,
    generation: actor?.generation ?? 0,
    position: copyPoint(fixed),
    cases: candidateViews,
    flights: Object.values(state.artillery.flights).map((flight) => ({ ...flight, progress: Math.max(0, Math.min(1, flight.progress)) })),
    queue,
    queueEntries,
    turretIds: actor ? Object.values(state.artillery.turrets).filter((item) => item.team === actor.team).map((item) => item.id).sort() : [],
    handles,
    pickupCaseId: pickupCandidate?.id,
    contextToken,
    selectedSlot,
  };
}

export { CASE_TYPES, ARTILLERY_ROUTES };
