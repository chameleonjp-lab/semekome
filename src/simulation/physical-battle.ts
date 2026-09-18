import { createWorld, stepWorld } from "./world.ts";
import { caseDefinition, CASE_TYPES, SUPPLY_BAG, type CaseType } from "../content/cases.ts";
import layoutSource from "../../docs/plans/current/INTERIOR_LAYOUTS.json" with { type: "json" };
import { padById } from "../domain/layout.ts";
import { assertObjectLocationsUnique } from "../domain/objects.ts";
import type {
  ActorId,
  ActorState,
  PartId,
  PauseReason,
  Point,
  RejectedInput,
  Reservation,
  StepReport,
  TeamId,
  WorldEvent,
  WorldObject,
  WorldState,
} from "../domain/types.ts";
import { GATE_IDS, PART_IDS } from "../domain/types.ts";
import {
  ACTOR_SPEED_SUBUNITS_PER_TICK,
  ACTOR_RADIUS_SUBUNITS,
  cellCenter,
  floorCell,
  FLOOR_SUBUNITS,
} from "../actors/movement.ts";
import {
  ACTION_RANGE_SUBUNITS as GEOMETRY_ACTION_RANGE_SUBUNITS,
  canOccupyFixed,
  equipmentRectForCell,
  hasFloorLineOfSight,
  walkableApproachCells,
  type FixedRect,
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
import type { EnemyIntent } from "../domain/battle.ts";
import {
  preparePlazaEntry,
  prepareR2bWorldInput,
  type PhysicalActorContactEvidence,
  type PlazaEntryEvidence,
  type R2bBridgeRequest,
} from "./r2b-bridge.ts";
import { chooseEnemyIntent, type EnemyObservation } from "./enemy-rules.ts";

const PLAYER_TEAM: TeamId = "player";
const ENEMY_TEAM: TeamId = "enemy";
const ALL_TEAMS: readonly TeamId[] = [PLAYER_TEAM, ENEMY_TEAM];
const ACTION_RANGE_SUBUNITS = GEOMETRY_ACTION_RANGE_SUBUNITS;
const EVENT_LOG_LIMIT = 512;
const ROUTE_COLLISION_EPSILON = 0.012;
const AI_REPLAN_TICKS = 120;
const ENEMY_DECISION_INTERVAL_TICKS = 36;
const PLAZA_EDGE_OFFSET_SUBUNITS = 500;
const PLAZA_ENTRY_TRIGGER_SUBUNITS = 750;
const PLAZA_ENTRY_HALF_HEIGHT_SUBUNITS = 9_500;
const PLAZA_GUARD_STANDOFF_SUBUNITS = 10_500;
// A full cell search is intentionally amortised across simulation ticks. A
// browser frame must not spend hundreds of milliseconds planning all internal
// soldiers at once (the UI clock treats that as an interruption).
const INTERNAL_PATH_PLANS_PER_TICK = 2;
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
export type BattleHandle = "pickup" | "drop" | "deliver" | "load" | "repair" | "launch" | "intercept";

/** Renderer/input adapters submit semantics, never object/collision internals. */
export interface BattleIntent {
  /** Every input is bound to the match that produced its snapshot. */
  matchId: string;
  actorId: ActorId;
  generation: number;
  direction?: BattleDirection;
  /** Starts a fixed-duration dash in the sampled direction. */
  dash?: BattleDirection;
  handle?: BattleHandle;
  slot?: number;
  route?: BattleRoute;
  part?: PartId;
  /** Optional repair target. When present, both fields must be supplied. */
  equipmentKind?: BattleEquipmentKind;
  equipmentId?: string;
  /** Candidate snapshot token returned by getInteraction. */
  contextToken?: string;
  /**
   * Physical first-contact evidence.  It is evaluated after this tick's
   * physical movement and consumed by the same authoritative world tick; it
   * is never treated as a direct common-world command.
   */
  bridge?: R2bBridgeRequest;
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
  /** Split children inherit the parent case but use their own damage. */
  damageOverride?: number;
  /** A child cannot recursively split, even though it retains the case ID. */
  splitAttempted?: boolean;
}

export interface BattleSupplyStop {
  disruptedUntilTick: number;
  immuneUntilTick: number;
}

export interface BattleSlowZone {
  sourceTeam: TeamId;
  targetTeam: TeamId;
  center: FixedPoint;
  radiusSubunits: number;
  multiplier: number;
  expiresAtTick: number;
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
  /** Equipment health is independent from supply disruption and stops. */
  health: number;
  disabledUntilTick: number | null;
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
  /** Equipment health is independent from supply disruption and stops. */
  health: number;
  disabledUntilTick: number | null;
  operatorActorIds: ActorId[];
}

export interface BattleCrewState {
  assignments: Record<string, CrewAssignment>;
}

export interface BattleRepairTask {
  actorId: ActorId;
  generation: number;
  objectId: string;
  team: TeamId;
  partId: PartId;
  startedTick: number;
  completesAtTick: number;
}

export interface BattleEquipmentRepairTask {
  actorId: ActorId;
  generation: number;
  objectId: string;
  team: TeamId;
  equipmentKind: BattleEquipmentKind;
  equipmentId: string;
  startedTick: number;
  completesAtTick: number;
}

export interface BattleRepairState {
  tasks: Record<string, BattleRepairTask>;
  equipmentTasks: Record<string, BattleEquipmentRepairTask>;
  /** Consumed exterior repair budget, kept separate for each vehicle. */
  budgetUsed: Record<TeamId, number>;
}

/**
 * The physical coordinator keeps a deterministic copy of the common enemy
 * intention.  The observation is projected from fixed-point state, while the
 * role priority itself is selected by the shared R2a rule.  Physical
 * execution still validates movement, line of sight, cargo, and equipment
 * independently; copying an intent never teleports an actor or grants an
 * object transition.
 */
export type PhysicalEnemyIntent = EnemyIntent;

export interface PhysicalEnemyDecision {
  generation: number;
  nextDecisionTick: number;
  intent: PhysicalEnemyIntent;
}

export interface BattleDashState {
  direction: BattleDirection;
  remainingTicks: number;
  /** Fixed-point origin captured when the dash starts. */
  start: FixedPoint;
}

export interface BattleLogisticsState {
  ports: Record<string, BattlePortState>;
  groups: Record<string, { id: string; team: TeamId; portId: string; caseIds: string[]; retired: boolean }>;
  /** One shuffled eight-case bag per source vehicle, shared by all four ports. */
  bags: Record<TeamId, CaseType[]>;
  bagIndices: Record<TeamId, number>;
  bagCycles: Record<TeamId, number>;
  /** Supply disruption and movement zones are separate from equipment stops. */
  supplyStops: Record<TeamId, BattleSupplyStop>;
  slowZones: Partial<Record<TeamId, BattleSlowZone>>;
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
  /** Own equipment that can be selected as a manual repair target. */
  equipmentRepairTargets: Array<{
    kind: BattleEquipmentKind;
    id: string;
    health: number;
    disabledUntilTick: number | null;
  }>;
  contextToken: string;
  selectedSlot?: 0 | 1;
}

const BATTLE_HANDLES: readonly BattleHandle[] = ["pickup", "drop", "deliver", "load", "repair", "launch", "intercept"];

function isBattleHandle(value: unknown): value is BattleHandle {
  return typeof value === "string" && BATTLE_HANDLES.includes(value as BattleHandle);
}

function isBattleRoute(value: unknown): value is BattleRoute {
  return value === "direct" || value === "detour";
}

function isBattleEquipmentKind(value: unknown): value is BattleEquipmentKind {
  return value === "turret" || value === "supply_port";
}

function isPartId(value: unknown): value is PartId {
  return typeof value === "string" && PART_IDS.includes(value as PartId);
}

/** R1 remains a structural/cell projection; fixedActors is movement authority. */
export interface BattleState extends WorldState {
  fixedActors: Record<string, { position: FixedPoint; remainder?: FixedPoint }>;
  /** Active dashes are physical state; the common world only sees contacts. */
  dashes: Record<string, BattleDashState | undefined>;
  /** Tick at which each actor may start another dash. */
  dashCooldownUntilTick: Record<string, number>;
  /** Two stable cargo slots; null is intentional and is never compacted. */
  cargoSlots: Record<string, [string | null, string | null]>;
  battleCases: Record<string, BattleCaseState>;
  logistics: BattleLogisticsState;
  artillery: BattleArtilleryState;
  crew: BattleCrewState;
  repairs: BattleRepairState;
  /** Fixed-point movement decisions for enemy internal soldiers. */
  enemyDecisions: Record<string, PhysicalEnemyDecision>;
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

function frontEntryCenter(state: BattleState, team: TeamId): FixedPoint {
  const [homeX, y] = layoutSource.front_entry.cell as [number, number];
  const cellX = team === PLAYER_TEAM ? homeX : state.layout.widthCells - 1 - homeX;
  return { x: cellCenter(cellX), y: cellCenter(y) };
}

function plazaBounds(state: BattleState): FixedRect {
  return {
    x0: state.layout.plaza.x0 * FLOOR_SUBUNITS,
    y0: state.layout.plaza.y0 * FLOOR_SUBUNITS,
    x1: state.layout.plaza.x1 * FLOOR_SUBUNITS,
    y1: state.layout.plaza.y1 * FLOOR_SUBUNITS,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Plaza has no authored interior walls, but the actor still needs a circle of clearance from its boundary. */
function plazaPointCanOccupy(state: BattleState, point: FixedPoint): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  const bounds = plazaBounds(state);
  return point.x - ACTOR_RADIUS_SUBUNITS >= bounds.x0 && point.x + ACTOR_RADIUS_SUBUNITS <= bounds.x1 &&
    point.y - ACTOR_RADIUS_SUBUNITS >= bounds.y0 && point.y + ACTOR_RADIUS_SUBUNITS <= bounds.y1;
}

function plazaEntryPoint(state: BattleState, team: TeamId, y: number): FixedPoint {
  const bounds = plazaBounds(state);
  return {
    x: team === PLAYER_TEAM ? bounds.x0 + PLAZA_EDGE_OFFSET_SUBUNITS : bounds.x1 - PLAZA_EDGE_OFFSET_SUBUNITS,
    y: clamp(y, bounds.y0 + ACTOR_RADIUS_SUBUNITS, bounds.y1 - ACTOR_RADIUS_SUBUNITS),
  };
}

function plazaGuardPoint(state: BattleState, team: TeamId, y: number): FixedPoint {
  const bounds = plazaBounds(state);
  return {
    x: team === PLAYER_TEAM
      ? bounds.x0 + PLAZA_GUARD_STANDOFF_SUBUNITS
      : bounds.x1 - PLAZA_GUARD_STANDOFF_SUBUNITS,
    y: clamp(y, bounds.y0 + ACTOR_RADIUS_SUBUNITS, bounds.y1 - ACTOR_RADIUS_SUBUNITS),
  };
}

function castleEntryY(state: BattleState, team: TeamId, y: number): number {
  const room = teamLayout(state, team).rooms.find((candidate) => candidate.id === layoutSource.front_entry.room_id);
  if (!room) return frontEntryCenter(state, team).y;
  return clamp(
    y,
    room.rect.y0 * FLOOR_SUBUNITS + ACTOR_RADIUS_SUBUNITS,
    room.rect.y1 * FLOOR_SUBUNITS - ACTOR_RADIUS_SUBUNITS,
  );
}

function atFrontExit(state: BattleState, actor: ActorState, direction: BattleDirection, point = actorFixed(state, actor.id)): boolean {
  if (actor.location.area !== "castle" || !actor.location.castleTeam) return false;
  const team = actor.location.castleTeam;
  const entry = frontEntryCenter(state, team);
  const frontDirection = teamLayout(state, team).frontDirection;
  const reachedDoor = team === PLAYER_TEAM
    ? point.x >= entry.x - PLAZA_ENTRY_TRIGGER_SUBUNITS
    : point.x <= entry.x + PLAZA_ENTRY_TRIGGER_SUBUNITS;
  return direction.x === frontDirection && reachedDoor && Math.abs(point.y - entry.y) <= PLAZA_ENTRY_HALF_HEIGHT_SUBUNITS;
}

function clearPhysicalAssignment(state: BattleState, actor: ActorState): void {
  const assignment = state.crew.assignments[actor.id];
  if (!assignment) return;
  assignment.task = "idle";
  assignment.path = [];
  assignment.pathIndex = 0;
  assignment.targetRoomId = undefined;
  assignment.targetActorId = undefined;
  assignment.targetPosition = undefined;
  assignment.stuckTicks = 0;
}

function enterPlaza(state: BattleState, actor: ActorState, y: number): void {
  const castleTeam = actor.location.castleTeam ?? actor.team;
  actor.location = { area: "plaza", pathRooms: [], pathGates: [] };
  actor.currentRoomId = "plaza";
  setActorFixed(state, actor, plazaEntryPoint(state, castleTeam, y));
  state.fixedActors[actor.id].remainder = { x: 0, y: 0 };
  clearPhysicalAssignment(state, actor);
}

function tryEnterPlaza(state: BattleState, actor: ActorState, direction: BattleDirection): boolean {
  const current = actorFixed(state, actor.id);
  if (!atFrontExit(state, actor, direction, current)) return false;
  enterPlaza(state, actor, current.y);
  return true;
}

function tryEnterCastleFromPlaza(state: BattleState, actor: ActorState, direction: BattleDirection): boolean {
  if (actor.location.area !== "plaza" || direction.x === 0) return false;
  const current = actorFixed(state, actor.id);
  const bounds = plazaBounds(state);
  const targetTeam = current.x <= bounds.x0 + PLAZA_ENTRY_TRIGGER_SUBUNITS && direction.x < 0
    ? PLAYER_TEAM
    : current.x >= bounds.x1 - PLAZA_ENTRY_TRIGGER_SUBUNITS && direction.x > 0
      ? ENEMY_TEAM
      : undefined;
  if (!targetTeam) return false;

  const guardGenerations = Object.fromEntries(Object.values(state.actors)
    .filter((candidate) => candidate.id !== actor.id && candidate.team === targetTeam &&
      candidate.canGuardPlaza === true && candidate.location.area === "plaza")
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((candidate) => [String(candidate.id), candidate.generation]));
  const evidence: PlazaEntryEvidence = {
    matchId: state.matchId,
    tick: state.tick,
    actorId: actor.id,
    generation: actor.generation,
    targetTeam,
    guardGenerations,
  };
  const prepared = preparePlazaEntry(state, evidence);
  if (!prepared.ok) return false;

  // The bridge only installs generation-bound permission. The physical
  // coordinator performs the actual boundary crossing and owns the fixed
  // coordinate projection for the new castle.
  state.plaza = prepared.value.state.plaza;
  actor.location = {
    area: "castle",
    castleTeam: targetTeam,
    roomId: layoutSource.front_entry.room_id,
    pathRooms: [layoutSource.front_entry.room_id],
    pathGates: [],
  };
  actor.currentRoomId = layoutSource.front_entry.room_id;
  setActorFixed(state, actor, frontEntryCenter(state, targetTeam));
  state.fixedActors[actor.id].position.y = castleEntryY(state, targetTeam, current.y);
  state.fixedActors[actor.id].remainder = { x: 0, y: 0 };
  syncActorProjection(state, actor, current);
  clearPhysicalAssignment(state, actor);
  return true;
}

function hasPhysicalLineOfSight(state: BattleState, actor: ActorState, from: FixedPoint, to: FixedPoint): boolean {
  if (actor.location.area === "plaza") return plazaPointCanOccupy(state, from) && plazaPointCanOccupy(state, to);
  return actor.location.castleTeam !== undefined && hasFloorLineOfSight(state, actor.location.castleTeam, from, to);
}

/**
 * The slow-zone effect is attached to the target vehicle's authored front
 * entry.  It affects every actor currently walking in that vehicle, including
 * an invader, and composes with the heavy-cargo multiplier.
 */
function effectMovementMultiplier(state: BattleState, actor: ActorState, position: FixedPoint = actorFixed(state, actor.id)): number {
  const castleTeam = actor.location.area === "castle" ? actor.location.castleTeam : undefined;
  if (!castleTeam || actor.currentRoomId !== layoutSource.front_entry.room_id) return 1;
  const zone = state.logistics.slowZones[castleTeam];
  if (!zone || state.tick >= zone.expiresAtTick) return 1;
  if (distanceSquared(position, zone.center) > zone.radiusSubunits * zone.radiusSubunits) return 1;
  return zone.multiplier;
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

function syncActorProjection(state: BattleState, actor: ActorState, previousPosition?: FixedPoint): void {
  const fixed = actorFixed(state, actor.id);
  const cell = readCell(fixed);
  actor.position = cell;
  if (actor.location.area !== "castle" || !actor.location.castleTeam) return;
  const layout = teamLayout(state, actor.location.castleTeam);
  const previousCell = previousPosition ? readCell(previousPosition) : undefined;
  if (previousCell && (previousCell.x !== cell.x || previousCell.y !== cell.y)) {
    const crossedGate = GATE_IDS.find((gateId) => (layout.gateCells[gateId] ?? []).some((gateCell) =>
      (gateCell.x === previousCell.x && gateCell.y === previousCell.y) ||
      (gateCell.x === cell.x && gateCell.y === cell.y)));
    if (crossedGate && !actor.location.pathGates.includes(crossedGate)) {
      actor.location.pathGates = [...actor.location.pathGates, crossedGate];
    }
  }
  const roomId = roomForCell(state, actor.location.castleTeam, cell, actor.currentRoomId);
  if (!roomId) return;
  if (actor.currentRoomId !== roomId) {
    actor.currentRoomId = roomId;
    actor.location.roomId = roomId;
    // Passage ids describe the floor geometry but are not rooms in the core
    // route proof. Keep them as the current physical projection while the
    // route history records authored rooms only.
    if (layout.rooms.some((room) => room.id === roomId)) {
      actor.location.pathRooms = [...actor.location.pathRooms, roomId];
    }
  }
}

function setActorFixed(state: BattleState, actor: ActorState, point: FixedPoint): void {
  const previous = state.fixedActors[actor.id];
  state.fixedActors[actor.id] = { position: copyPoint(point), remainder: previous?.remainder ?? { x: 0, y: 0 } };
  syncActorProjection(state, actor, previous?.position);
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

function furthestPlazaPoint(state: BattleState, from: FixedPoint, to: FixedPoint): FixedPoint {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const middle = (low + high) / 2;
    const candidate = {
      x: Math.round(from.x + (to.x - from.x) * middle),
      y: Math.round(from.y + (to.y - from.y) * middle),
    };
    if (plazaPointCanOccupy(state, candidate)) low = middle;
    else high = middle;
  }
  return {
    x: Math.round(from.x + (to.x - from.x) * low),
    y: Math.round(from.y + (to.y - from.y) * low),
  };
}

function moveFixed(state: BattleState, actor: ActorState, direction: BattleDirection): boolean {
  if (!actor.alive) return false;
  const inPlaza = actor.location.area === "plaza";
  const castleTeam = actor.location.area === "castle" ? actor.location.castleTeam : undefined;
  if (!inPlaza && !castleTeam) return false;
  if (inPlaza && tryEnterCastleFromPlaza(state, actor, direction)) return true;
  if (!inPlaza && tryEnterPlaza(state, actor, direction)) return true;

  const totalWeight = actor.cargoIds.reduce((sum, id) => sum + (state.battleCases[id]?.weight ?? 0), 0);
  const speed = ACTOR_SPEED_SUBUNITS_PER_TICK * carryingSpeedMultiplier(totalWeight) * effectMovementMultiplier(state, actor);
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
  const canOccupyPoint = (point: FixedPoint): boolean => inPlaza
    ? plazaPointCanOccupy(state, point)
    : canOccupy(state, castleTeam!, point);
  const furthest = (from: FixedPoint, to: FixedPoint): FixedPoint => {
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const middle = (low + high) / 2;
      const candidate = {
        x: Math.round(from.x + (to.x - from.x) * middle),
        y: Math.round(from.y + (to.y - from.y) * middle),
      };
      if (canOccupyPoint(candidate)) low = middle;
      else high = middle;
    }
    return {
      x: Math.round(from.x + (to.x - from.x) * low),
      y: Math.round(from.y + (to.y - from.y) * low),
    };
  };
  for (let index = 1; index <= steps; index += 1) {
    const candidate = {
      x: current.x + Math.round((dx * index) / steps),
      y: current.y + Math.round((dy * index) / steps),
    };
    if (!canOccupyPoint(candidate)) {
      const partial = furthest(next, candidate);
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

function dashDirectionValid(direction: BattleDirection | undefined): direction is BattleDirection {
  if (!direction || !isFiniteDirection(direction)) return false;
  return direction.x !== 0 || direction.y !== 0;
}

function startDash(
  state: BattleState,
  actor: ActorState,
  direction: BattleDirection | undefined,
  report: StepReport,
): boolean {
  if (!dashDirectionValid(direction)) {
    addRejection(report, 0, "invalid_transition", "dash direction must be a non-neutral unit vector");
    return false;
  }
  if (actorIsProtected(state, actor)) {
    addRejection(report, 0, "protected_actor", "spawn protection blocks dash attacks");
    return false;
  }
  if (state.dashes[actor.id]) {
    addRejection(report, 0, "invalid_transition", "actor is already dashing");
    return false;
  }
  const cooldownUntil = state.dashCooldownUntilTick[actor.id] ?? 0;
  if (state.tick < cooldownUntil) {
    addRejection(report, 0, "invalid_transition", `dash cooldown until tick ${cooldownUntil}`);
    return false;
  }
  state.dashes[actor.id] = {
    direction: { ...direction },
    remainingTicks: state.rules.dashDurationTicks,
    start: copyPoint(actorFixed(state, actor.id)),
  };
  state.dashCooldownUntilTick[actor.id] = state.tick + state.rules.dashCooldownTicks;
  report.acceptedInputKinds.push("dash");
  return true;
}

/** Return the first segment parameter at which two actor circles overlap. */
function segmentActorContactT(from: FixedPoint, to: FixedPoint, target: FixedPoint): number | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const fx = from.x - target.x;
  const fy = from.y - target.y;
  const radius = ACTOR_RADIUS_SUBUNITS * 2;
  const radiusSquared = radius * radius;
  const startDistance = fx * fx + fy * fy;
  if (startDistance <= radiusSquared) return 0;
  const a = dx * dx + dy * dy;
  if (a === 0) return undefined;
  const b = 2 * (fx * dx + fy * dy);
  const c = startDistance - radiusSquared;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return undefined;
  const root = Math.sqrt(discriminant);
  const entry = (-b - root) / (2 * a);
  if (entry < 0 || entry > 1) return undefined;
  return entry;
}

function interpolatePoint(from: FixedPoint, to: FixedPoint, progress: number): FixedPoint {
  return {
    x: Math.round(from.x + (to.x - from.x) * progress),
    y: Math.round(from.y + (to.y - from.y) * progress),
  };
}

export type BattleEquipmentKind = "turret" | "supply_port";
type BattleEquipmentRuntime = BattleTurretState | BattlePortState;

interface DashEquipmentContact {
  kind: BattleEquipmentKind;
  team: TeamId;
  id: string;
  position: FixedPoint;
  progress: number;
  equipment: BattleEquipmentRuntime;
}

interface DashAdvanceResult {
  bridge?: R2bBridgeRequest;
  equipmentContact?: DashEquipmentContact;
  equipmentDamaged?: boolean;
}

function expandRect(rect: FixedRect, margin: number): FixedRect {
  return {
    x0: rect.x0 - margin,
    y0: rect.y0 - margin,
    x1: rect.x1 + margin,
    y1: rect.y1 + margin,
  };
}

/** Return the first segment parameter at which a line enters an AABB. */
function segmentRectEntryT(from: FixedPoint, to: FixedPoint, rect: FixedRect): number | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let near = 0;
  let far = 1;
  for (const [start, delta, min, max] of [
    [from.x, dx, rect.x0, rect.x1],
    [from.y, dy, rect.y0, rect.y1],
  ] as const) {
    if (delta === 0) {
      if (start < min || start > max) return undefined;
      continue;
    }
    let enter = (min - start) / delta;
    let exit = (max - start) / delta;
    if (enter > exit) [enter, exit] = [exit, enter];
    near = Math.max(near, enter);
    far = Math.min(far, exit);
    if (near > far) return undefined;
  }
  if (far < 0 || near > 1) return undefined;
  return Math.max(0, near);
}

function dashEquipmentContact(
  state: BattleState,
  actor: ActorState,
  from: FixedPoint,
  requested: FixedPoint,
  endpoint: FixedPoint,
): DashEquipmentContact | undefined {
  if (actor.location.area !== "castle" || !actor.location.castleTeam) return undefined;
  const totalDistance = Math.hypot(requested.x - from.x, requested.y - from.y);
  if (totalDistance === 0) return undefined;
  const endpointProgress = Math.hypot(endpoint.x - from.x, endpoint.y - from.y) / totalDistance;
  const team = actor.location.castleTeam;
  const layout = teamLayout(state, team);
  const candidates: DashEquipmentContact[] = [];
  for (const definition of layout.turrets) {
    const equipment = state.artillery.turrets[turretKey(team, definition.id)];
    if (!equipment) continue;
    const progress = segmentRectEntryT(from, requested, expandRect(equipmentRectForCell(definition.cell), ACTOR_RADIUS_SUBUNITS));
    // The clearance bisection rounds the conservative endpoint down by up to
    // a few fixed units; allow that bounded quantization error when matching
    // the expanded equipment body to the same first obstacle.
    if (progress === undefined || progress > endpointProgress + 0.02) continue;
    candidates.push({
      kind: "turret",
      team,
      id: definition.id,
      position: interpolatePoint(from, requested, progress),
      progress,
      equipment,
    });
  }
  for (const definition of layout.supplyPorts) {
    const equipment = state.logistics.ports[portKey(team, definition.id)];
    if (!equipment) continue;
    const progress = segmentRectEntryT(from, requested, expandRect(equipmentRectForCell(definition.cell), ACTOR_RADIUS_SUBUNITS));
    if (progress === undefined || progress > endpointProgress + 0.02) continue;
    candidates.push({
      kind: "supply_port",
      team,
      id: definition.id,
      position: interpolatePoint(from, requested, progress),
      progress,
      equipment,
    });
  }
  return candidates.sort((left, right) => left.progress - right.progress || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))[0];
}

function equipmentReady(state: BattleState, equipment: BattleEquipmentRuntime): boolean {
  return equipment.disabledUntilTick === null || state.tick > equipment.disabledUntilTick;
}

function restoreDisabledEquipment(state: BattleState, events: WorldEvent[]): void {
  const entries: Array<{ kind: BattleEquipmentKind; team: TeamId; id: string; equipment: BattleEquipmentRuntime }> = [
    ...Object.values(state.artillery.turrets).map((equipment) => ({ kind: "turret" as const, team: equipment.team, id: equipment.id, equipment })),
    ...Object.values(state.logistics.ports).map((equipment) => ({ kind: "supply_port" as const, team: equipment.team, id: equipment.id, equipment })),
  ];
  for (const entry of entries.sort((left, right) => `${left.team}:${left.kind}:${left.id}`.localeCompare(`${right.team}:${right.kind}:${right.id}`))) {
    if (entry.equipment.disabledUntilTick === null || state.tick <= entry.equipment.disabledUntilTick) continue;
    entry.equipment.health = state.rules.equipmentHealth;
    entry.equipment.disabledUntilTick = null;
    events.push(event("equipment_restored", {
      team: entry.team,
      equipmentId: entry.id,
      equipmentKind: entry.kind,
    }));
    for (const task of Object.values(state.repairs.equipmentTasks)) {
      if (task.team !== entry.team || task.equipmentKind !== entry.kind || task.equipmentId !== entry.id) continue;
      cancelEquipmentRepair(state, task, "invalid_target", events);
    }
  }
}

function damageEquipment(state: BattleState, actor: ActorState, contact: DashEquipmentContact, events: WorldEvent[]): boolean {
  // A dash can be stopped by friendly equipment, but only hostile equipment
  // consumes the authored equipment damage budget.
  if (contact.team === actor.team || !equipmentReady(state, contact.equipment) || contact.equipment.health <= 0) return false;
  const amount = Math.min(state.rules.dashEquipmentDamage, contact.equipment.health);
  contact.equipment.health -= amount;
  if (contact.equipment.health === 0) contact.equipment.disabledUntilTick = state.tick + state.rules.equipmentDisabledTicks;
  events.push(event("equipment_damaged", {
    team: contact.team,
    equipmentId: contact.id,
    equipmentKind: contact.kind,
    amount,
    remainingHealth: contact.equipment.health,
    disabledUntilTick: contact.equipment.disabledUntilTick,
  }));
  return true;
}

function dashContactTarget(
  state: BattleState,
  actor: ActorState,
  from: FixedPoint,
  to: FixedPoint,
): { target: ActorState; progress: number; position: FixedPoint } | undefined {
  if (actor.location.area === "castle" && !actor.location.castleTeam) return undefined;
  if (actor.location.area !== "castle" && actor.location.area !== "plaza") return undefined;
  const candidates = Object.values(state.actors)
    .filter((candidate) => candidate.id !== actor.id && candidate.alive && candidate.team !== actor.team &&
      candidate.location.area === actor.location.area &&
      (actor.location.area === "plaza" || candidate.location.castleTeam === actor.location.castleTeam))
    .map((candidate) => ({ candidate, progress: segmentActorContactT(from, to, actorFixed(state, candidate.id)) }))
    .filter((entry): entry is { candidate: ActorState; progress: number } => entry.progress !== undefined)
    .sort((left, right) => left.progress - right.progress || String(left.candidate.id).localeCompare(String(right.candidate.id)));
  const first = candidates[0];
  if (!first) return undefined;
  return {
    target: first.candidate,
    progress: first.progress,
    position: interpolatePoint(from, to, first.progress),
  };
}

/**
 * Advance all active physical dashes by one tick and return the one contact
 * envelope produced during this tick. The movement is authoritative here;
 * actor damage or victory is still resolved by the R2b bridge/common world;
 * equipment damage is resolved against the physical equipment runtime.
 */
function advanceDashes(state: BattleState, events: WorldEvent[]): DashAdvanceResult {
  for (const actor of Object.values(state.actors).sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    const dash = state.dashes[actor.id];
    if (!dash) continue;
    if (!actor.alive || (actor.location.area === "castle" && !actor.location.castleTeam) ||
        (actor.location.area !== "castle" && actor.location.area !== "plaza")) {
      state.dashes[actor.id] = undefined;
      continue;
    }
    const current = actorFixed(state, actor.id);
    const distance = state.rules.dashDistanceSubunits / state.rules.dashDurationTicks;
    const diagonal = dash.direction.x !== 0 && dash.direction.y !== 0 ? Math.SQRT1_2 : 1;
    const requested = {
      x: Math.round(current.x + dash.direction.x * distance * diagonal),
      y: Math.round(current.y + dash.direction.y * distance * diagonal),
    };
    const walkable = actor.location.area === "plaza"
      ? plazaPointCanOccupy(state, requested)
      : canOccupy(state, actor.location.castleTeam!, requested);
    const endpoint = walkable ? requested : actor.location.area === "plaza"
      ? furthestPlazaPoint(state, current, requested)
      : furthestWalkablePoint(state, actor.location.castleTeam!, current, requested);
    const blocked = endpoint.x !== requested.x || endpoint.y !== requested.y;
    const contact = dashContactTarget(state, actor, current, endpoint);
    if (contact) {
      setActorFixed(state, actor, contact.position);
      state.dashes[actor.id] = undefined;
      const targetSlots = state.cargoSlots[contact.target.id] ?? [null, null];
      const targetCargoId = targetSlots.find((objectId) => objectId !== null && contact.target.cargoIds.includes(objectId)) ?? undefined;
      return {
        bridge: {
          kind: "actor_contact",
          evidence: {
            matchId: state.matchId,
            tick: state.tick,
            actorId: actor.id,
            generation: actor.generation,
            targetActorId: contact.target.id,
            targetGeneration: contact.target.generation,
            attackType: "dash",
            firstContact: "actor",
            from: contact.position,
            to: copyPoint(actorFixed(state, contact.target.id)),
            targetPosition: copyPoint(actorFixed(state, contact.target.id)),
            ...(targetCargoId ? { targetCargoId } : {}),
          },
        },
      };
    }
    const equipmentContact = dashEquipmentContact(state, actor, current, requested, endpoint);
    if (equipmentContact) {
      if (endpoint.x !== current.x || endpoint.y !== current.y) setActorFixed(state, actor, endpoint);
      state.dashes[actor.id] = undefined;
      return {
        equipmentContact,
        equipmentDamaged: damageEquipment(state, actor, equipmentContact, events),
      };
    }
    if (endpoint.x !== current.x || endpoint.y !== current.y) setActorFixed(state, actor, endpoint);
    // A wall, closed gate, or equipment body is the first physical obstacle;
    // the dash ends at its conservative clearance point and never tunnels.
    if (blocked || actor.currentRoomId === "core") {
      if (actor.currentRoomId === "core") {
        const currentCastleTeam = actor.location.castleTeam;
        if (!currentCastleTeam) {
          state.dashes[actor.id] = undefined;
          continue;
        }
        state.dashes[actor.id] = undefined;
        return {
          bridge: {
            kind: "core_contact",
            evidence: {
              matchId: state.matchId,
              tick: state.tick,
              actorId: actor.id,
              generation: actor.generation,
              targetTeam: currentCastleTeam === actor.team ? (actor.team === PLAYER_TEAM ? ENEMY_TEAM : PLAYER_TEAM) : currentCastleTeam,
              attackType: "dash",
              firstContact: "core",
              from: copyPoint(actorFixed(state, actor.id)),
              to: copyPoint(actorFixed(state, actor.id)),
            },
          },
        };
      }
      state.dashes[actor.id] = undefined;
      continue;
    }
    dash.remainingTicks -= 1;
    if (dash.remainingTicks <= 0) state.dashes[actor.id] = undefined;
  }
  return {};
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
  const castleTeam = actor.location.castleTeam ?? actor.team;
  const moveSpeed = ACTOR_SPEED_SUBUNITS_PER_TICK * carryingSpeedMultiplier(carryWeight(state, actor)) * effectMovementMultiplier(state, actor);
  const snapAxis = (axis: "x" | "y"): boolean => {
    const point = actorFixed(state, actor.id);
    const delta = targetPoint[axis] - point[axis];
    if (Math.abs(delta) > moveSpeed) return false;
    const candidate = copyPoint(point);
    candidate[axis] = targetPoint[axis];
    if (!canOccupy(state, castleTeam, candidate)) return false;
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

/** Collision-safe fallback while an authored route is being planned. */
function moveDirectlyToward(state: BattleState, actor: ActorState, target: FixedPoint, preferHorizontal = false): void {
  const current = actorFixed(state, actor.id);
  const deltaX = target.x - current.x;
  const deltaY = target.y - current.y;
  // Match the cardinal segment ordering used by moveAlongPath. This keeps
  // the fallback physically conservative and avoids diagonal corner cuts.
  const direction = (preferHorizontal || Math.abs(deltaX) >= Math.abs(deltaY)
    ? { x: deltaX === 0 ? 0 : deltaX > 0 ? 1 : -1, y: 0 }
    : { x: 0, y: deltaY === 0 ? 0 : deltaY > 0 ? 1 : -1 }) as BattleDirection;
  if (direction.x === 0 && direction.y === 0) return;
  moveFixed(state, actor, direction);
}

function roomTargetPoint(state: BattleState, team: TeamId, roomId: string): FixedPoint | undefined {
  const room = teamLayout(state, team).rooms.find((candidate) => candidate.id === roomId);
  if (!room) return undefined;
  const center = {
    x: cellCenter(Math.floor((room.rect.x0 + room.rect.x1 - 1) / 2)),
    y: cellCenter(Math.floor((room.rect.y0 + room.rect.y1 - 1) / 2)),
  };
  const candidates: FixedPoint[] = [center];
  // A room center can be occupied by an authored equipment body. Search the
  // same room in a stable spiral before giving up; never teleport an actor to
  // a point that the physical geometry rejects.
  for (let radius = 1; radius < Math.max(room.rect.x1 - room.rect.x0, room.rect.y1 - room.rect.y0); radius += 1) {
    candidates.push(
      { x: cellCenter(Math.min(room.rect.x1 - 1, Math.floor((room.rect.x0 + room.rect.x1 - 1) / 2) + radius)), y: center.y },
      { x: cellCenter(Math.max(room.rect.x0, Math.floor((room.rect.x0 + room.rect.x1 - 1) / 2) - radius)), y: center.y },
      { x: center.x, y: cellCenter(Math.min(room.rect.y1 - 1, Math.floor((room.rect.y0 + room.rect.y1 - 1) / 2) + radius)) },
      { x: center.x, y: cellCenter(Math.max(room.rect.y0, Math.floor((room.rect.y0 + room.rect.y1 - 1) / 2) - radius)) },
    );
  }
  return candidates.find((point) => canOccupy(state, team, point));
}

function physicalEnemyObservation(state: BattleState, actor: ActorState): EnemyObservation {
  const local = (candidate: ActorState): boolean => candidate.id !== actor.id && candidate.alive &&
    candidate.team !== actor.team && candidate.location.area === actor.location.area &&
    candidate.location.castleTeam === actor.location.castleTeam && candidate.currentRoomId === actor.currentRoomId;
  const threats = Object.values(state.actors)
    .filter(local)
    .sort((left, right) => distanceSquared(actorFixed(state, actor.id), actorFixed(state, left.id)) -
      distanceSquared(actorFixed(state, actor.id), actorFixed(state, right.id)) || String(left.id).localeCompare(String(right.id)))
    .map((candidate) => candidate.id);
  const turretDefinition = actor.turretId
    ? teamLayout(state, actor.team).turrets.find((candidate) => candidate.id === actor.turretId)
    : undefined;
  const turret = turretDefinition
    ? state.artillery.turrets[turretKey(actor.team, turretDefinition.id)]
    : undefined;
  const nearbyCases = Object.values(state.battleCases)
    .filter((caseState) => caseState.location === "floor" && caseState.currentTeam === actor.team &&
      caseState.roomId === actor.currentRoomId && caseState.position !== undefined &&
      withinActionRange(actorFixed(state, actor.id), caseState.position))
    .sort((left, right) => distanceSquared(actorFixed(state, actor.id), left.position!) -
      distanceSquared(actorFixed(state, actor.id), right.position!) || left.id.localeCompare(right.id))
    .map((caseState) => caseState.id);
  return {
    role: actor.role,
    health: actor.health,
    homeRoomId: actor.homeRoomId,
    currentRoomId: actor.currentRoomId,
    inHomeCastle: actor.location.area === "castle" && actor.location.castleTeam === actor.team,
    threats,
    cargo: actor.cargoIds.filter((caseId) => state.battleCases[caseId]?.location === "carried"),
    nearbyCases,
    turret: turret && turretDefinition ? {
      id: turret.id,
      roomId: turret.roomId,
      atPosition: actor.location.area === "castle" && actor.location.castleTeam === actor.team &&
        actor.currentRoomId === turret.roomId && withinActionRange(actorFixed(state, actor.id), turret.position) &&
        hasFloorLineOfSight(state, actor.team, actorFixed(state, actor.id), turret.position),
      hasCapacity: turret.queueIds.length < QUEUE_CAPACITY_PER_TURRET && turret.handoffIds.length < STAGING_SLOTS_PER_TURRET,
    } : undefined,
    canAssault: actor.canAssaultOtherVehicle === true,
    canGuardPlaza: actor.canGuardPlaza === true,
  };
}

function physicalEnemyIntent(state: BattleState, actor: ActorState): PhysicalEnemyIntent {
  // Keep the role priority in one place: the fixed-point adapter supplies
  // physical observations, then the shared common-rule selector chooses the
  // same intent used by the non-physical battle state.
  return chooseEnemyIntent(physicalEnemyObservation(state, actor));
}

function clearEnemyAssignment(assignment: CrewAssignment): void {
  assignment.path = [];
  assignment.pathIndex = 0;
  assignment.stuckTicks = 0;
  assignment.targetRoomId = undefined;
  assignment.targetActorId = undefined;
  assignment.targetPosition = undefined;
}

interface CrossAreaGoalResult {
  handled: boolean;
  pathPlanned: boolean;
}

function processInternalCrossAreaGoal(
  state: BattleState,
  actor: ActorState,
  assignment: CrewAssignment,
  roomId: string,
  purpose: "plaza" | "assault",
  canPlanPath: boolean,
): CrossAreaGoalResult {
  const [, entryY] = layoutSource.front_entry.cell as [number, number];
  if (actor.location.area === "plaza") {
    const bounds = plazaBounds(state);
    const targetTeam = actor.team === PLAYER_TEAM ? ENEMY_TEAM : PLAYER_TEAM;
    const ownSide = plazaGuardPoint(state, actor.team, actorFixed(state, actor.id).y);
    const target = {
      x: purpose === "plaza"
        ? ownSide.x
        : targetTeam === PLAYER_TEAM
          ? bounds.x0 + PLAZA_EDGE_OFFSET_SUBUNITS
          : bounds.x1 - PLAZA_EDGE_OFFSET_SUBUNITS,
      y: cellCenter(entryY),
    };
    const targetChanged = !assignment.targetPosition ||
      assignment.targetPosition.x !== target.x || assignment.targetPosition.y !== target.y;
    if (targetChanged) {
      assignment.targetRoomId = roomId;
      assignment.targetPosition = copyPoint(target);
      assignment.path = [];
      assignment.pathIndex = 0;
      assignment.stuckTicks = 0;
    }
    assignment.task = "patrol";
    if (purpose === "assault") {
      const direction: BattleDirection = targetTeam === PLAYER_TEAM ? { x: -1, y: 0 } : { x: 1, y: 0 };
      const atTargetBoundary = targetTeam === PLAYER_TEAM
        ? actorFixed(state, actor.id).x <= bounds.x0 + PLAZA_ENTRY_TRIGGER_SUBUNITS
        : actorFixed(state, actor.id).x >= bounds.x1 - PLAZA_ENTRY_TRIGGER_SUBUNITS;
      if (atTargetBoundary && tryEnterCastleFromPlaza(state, actor, direction)) {
        return { handled: true, pathPlanned: false };
      }
    }
    moveDirectlyToward(state, actor, target, true);
    return { handled: true, pathPlanned: false };
  }

  // A guard or assault unit leaves its own castle through the authored front
  // entry. Once an assault unit has entered the opposing castle, the regular
  // authored-room mover resumes below in processInternalSoldierAI.
  if (actor.location.area !== "castle" || actor.location.castleTeam !== actor.team) {
    return { handled: false, pathPlanned: false };
  }
  const target = frontEntryCenter(state, actor.team);
  const targetChanged = !assignment.targetPosition ||
    assignment.targetPosition.x !== target.x || assignment.targetPosition.y !== target.y;
  if (targetChanged) {
    assignment.targetRoomId = roomId;
    assignment.targetPosition = copyPoint(target);
    assignment.path = [];
    assignment.pathIndex = 0;
    assignment.stuckTicks = 0;
  }
  assignment.task = "patrol";
  const outward: BattleDirection = { x: teamLayout(state, actor.team).frontDirection, y: 0 };
  if (atFrontExit(state, actor, outward)) {
    moveFixed(state, actor, outward);
    return { handled: true, pathPlanned: false };
  }
  if (assignment.path.length === 0 && canPlanPath) {
    assignment.path = actorTargetPath(state, actor, target);
    assignment.pathIndex = 0;
    assignment.stuckTicks = 0;
    if (assignment.path.length > 0) {
      moveAIAlongPath(state, actor, assignment, target);
      return { handled: true, pathPlanned: true };
    }
  }
  if (assignment.path.length > 0) moveAIAlongPath(state, actor, assignment, target);
  else moveDirectlyToward(state, actor, target, true);
  return { handled: true, pathPlanned: false };
}

function updatePhysicalEnemyDecisions(state: BattleState): void {
  const enemyIds = new Set<string>();
  for (const actor of Object.values(state.actors)
    .filter((candidate) => candidate.team === ENEMY_TEAM && candidate.role !== "player" && candidate.role !== "support")
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    enemyIds.add(String(actor.id));
    if (!actor.alive || (actor.protectedUntilTick !== null && state.tick < actor.protectedUntilTick)) {
      delete state.enemyDecisions[actor.id];
      clearEnemyAssignment(state.crew.assignments[actor.id] ?? { actorId: actor.id, task: "idle", path: [], pathIndex: 0 });
      continue;
    }
    const previous = state.enemyDecisions[actor.id];
    if (previous?.generation === actor.generation && state.tick < previous.nextDecisionTick) continue;
    const intent = physicalEnemyIntent(state, actor);
    state.enemyDecisions[actor.id] = {
      generation: actor.generation,
      nextDecisionTick: state.tick + ENEMY_DECISION_INTERVAL_TICKS,
      intent,
    };
    const assignment = state.crew.assignments[actor.id] ?? { actorId: actor.id, task: "idle", path: [], pathIndex: 0 };
    clearEnemyAssignment(assignment);
    assignment.task = "idle";
    if (intent.kind === "move_goal") assignment.targetRoomId = intent.roomId;
    else if (intent.kind === "defend" || intent.kind === "retreat") assignment.targetActorId = intent.kind === "defend" ? intent.targetId : intent.awayFromId;
    state.crew.assignments[actor.id] = assignment;
  }
  for (const actorId of Object.keys(state.enemyDecisions)) if (!enemyIds.has(actorId)) delete state.enemyDecisions[actorId];
}

function retreatTargetPoint(state: BattleState, actor: ActorState, threat: ActorState): FixedPoint | undefined {
  if (actor.location.area === "plaza") {
    return plazaGuardPoint(state, actor.team, actorFixed(state, actor.id).y);
  }
  const team = actor.location.castleTeam;
  const room = team ? teamLayout(state, team).rooms.find((candidate) => candidate.id === actor.currentRoomId) : undefined;
  if (!team || !room) return roomTargetPoint(state, team ?? ENEMY_TEAM, actor.homeRoomId);
  const current = actorFixed(state, actor.id);
  const threatPoint = actorFixed(state, threat.id);
  const awayX = current.x - threatPoint.x;
  const awayY = current.y - threatPoint.y;
  const centerX = Math.floor((room.rect.x0 + room.rect.x1 - 1) / 2);
  const centerY = Math.floor((room.rect.y0 + room.rect.y1 - 1) / 2);
  const targetCell = {
    x: awayX === 0 ? centerX : awayX > 0 ? room.rect.x1 - 1 : room.rect.x0,
    y: awayY === 0 ? centerY : awayY > 0 ? room.rect.y1 - 1 : room.rect.y0,
  };
  const target = { x: cellCenter(targetCell.x), y: cellCenter(targetCell.y) };
  return canOccupy(state, team, target) ? target : roomTargetPoint(state, team, actor.currentRoomId);
}

function startEnemyDash(state: BattleState, actor: ActorState, target: FixedPoint): boolean {
  if (!actor.alive || actorIsProtected(state, actor) || state.dashes[actor.id]) return false;
  if (state.tick < (state.dashCooldownUntilTick[actor.id] ?? 0)) return false;
  const current = actorFixed(state, actor.id);
  const direction = {
    x: target.x === current.x ? 0 : target.x > current.x ? 1 : -1,
    y: target.y === current.y ? 0 : target.y > current.y ? 1 : -1,
  } as BattleDirection;
  if (direction.x === 0 && direction.y === 0) return false;
  state.dashes[actor.id] = { direction, remainingTicks: state.rules.dashDurationTicks, start: copyPoint(current) };
  state.dashCooldownUntilTick[actor.id] = state.tick + state.rules.dashCooldownTicks;
  return true;
}

function enemyDecisionUsesPhysicalMover(actor: ActorState, intent: PhysicalEnemyIntent): boolean {
  if (intent.kind === "defend" || intent.kind === "retreat") return true;
  if (intent.kind !== "move_goal") return false;
  if (actor.role === "internal_soldier") return true;
  // Return goals are movement responsibilities for the non-combat roles.
  // Shooter operation and carrier delivery remain with their role-specific
  // handlers so they cannot skip equipment or cargo validation.
  return intent.purpose === "return" && actor.role !== "ammo_carrier";
}

function processInternalSoldierAI(state: BattleState, suppressNpcMovement: boolean): void {
  // A public dash or an explicit bridge is a player-authored physical
  // snapshot.  Keep NPCs from moving the target before that snapshot is
  // validated, otherwise a legitimate contact would become stale mid-tick.
  if (suppressNpcMovement) return;
  let pathPlansRemaining = INTERNAL_PATH_PLANS_PER_TICK;
  for (const actor of Object.values(state.actors)
    .filter((candidate) => candidate.team === ENEMY_TEAM && candidate.role !== "player" && candidate.role !== "support" && candidate.alive)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    const decision = state.enemyDecisions[actor.id];
    if (!decision || decision.generation !== actor.generation || state.dashes[actor.id] || !enemyDecisionUsesPhysicalMover(actor, decision.intent)) continue;
    const assignment = state.crew.assignments[actor.id] ?? { actorId: actor.id, task: "idle" as CrewTask, path: [], pathIndex: 0 };
    // Keep the bounded BFS budget for the internal-soldier patrol network.
    // Shooter guards and carriers use the same collision-safe fixed-step
    // fallback for their return/defense goals; their normal equipment/cargo
    // paths remain owned by the role-specific handlers.
    const canPlanAuthoredPath = actor.role === "internal_soldier";
    if (decision.intent.kind === "move_goal") {
      if (decision.intent.purpose === "plaza" || decision.intent.purpose === "assault") {
        const crossArea = processInternalCrossAreaGoal(
          state,
          actor,
          assignment,
          decision.intent.roomId,
          decision.intent.purpose,
          canPlanAuthoredPath && pathPlansRemaining > 0,
        );
        if (crossArea.handled) {
          if (crossArea.pathPlanned) pathPlansRemaining -= 1;
          state.crew.assignments[actor.id] = assignment;
          continue;
        }
      }
      const targetChanged = assignment.targetRoomId !== decision.intent.roomId || !assignment.targetPosition;
      const target = targetChanged
        ? roomTargetPoint(state, actor.location.castleTeam ?? ENEMY_TEAM, decision.intent.roomId)
        : assignment.targetPosition;
      if (!target) continue;
      assignment.task = decision.intent.purpose === "patrol" ? "patrol" : "idle";
      if (targetChanged) {
        assignment.targetRoomId = decision.intent.roomId;
        assignment.targetActorId = undefined;
        assignment.targetPosition = copyPoint(target);
        assignment.path = [];
        assignment.pathIndex = 0;
        assignment.stuckTicks = 0;
      }
      if (canPlanAuthoredPath && assignment.path.length === 0 && pathPlansRemaining > 0) {
        assignment.path = actorTargetPath(state, actor, target);
        pathPlansRemaining -= 1;
      }
      if (assignment.path.length > 0) moveAIAlongPath(state, actor, assignment, target);
      else moveDirectlyToward(state, actor, target, decision.intent.purpose === "plaza" || decision.intent.purpose === "assault");
    } else if (decision.intent.kind === "defend") {
      const targetActor = state.actors[decision.intent.targetId];
      if (!targetActor?.alive || targetActor.location.castleTeam !== actor.location.castleTeam || targetActor.currentRoomId !== actor.currentRoomId) continue;
      const target = actorFixed(state, targetActor.id);
      assignment.task = "defend";
      assignment.targetActorId = targetActor.id;
      assignment.targetRoomId = undefined;
      if (hasPhysicalLineOfSight(state, actor, actorFixed(state, actor.id), target) &&
          distanceSquared(actorFixed(state, actor.id), target) <= (state.rules.dashDistanceSubunits + ACTOR_RADIUS_SUBUNITS * 2) ** 2 &&
          startEnemyDash(state, actor, target)) continue;
      if (canPlanAuthoredPath && assignment.path.length === 0 && pathPlansRemaining > 0) {
        assignment.path = actorTargetPath(state, actor, target);
        assignment.pathIndex = 0;
        pathPlansRemaining -= 1;
      }
      if (assignment.path.length > 0) moveAIAlongPath(state, actor, assignment, target);
      else moveDirectlyToward(state, actor, target);
    } else if (decision.intent.kind === "retreat") {
      const threat = state.actors[decision.intent.awayFromId];
      if (!threat?.alive) continue;
      const target = retreatTargetPoint(state, actor, threat);
      if (!target) continue;
      assignment.task = "retreat";
      assignment.targetActorId = threat.id;
      assignment.targetRoomId = undefined;
      if (canPlanAuthoredPath && assignment.path.length === 0 && pathPlansRemaining > 0) {
        assignment.path = actorTargetPath(state, actor, target);
        assignment.pathIndex = 0;
        assignment.stuckTicks = 0;
        pathPlansRemaining -= 1;
      }
      if (assignment.path.length > 0) moveAIAlongPath(state, actor, assignment, target);
      else moveDirectlyToward(state, actor, target, true);
    }
    state.crew.assignments[actor.id] = assignment;
  }
}

function caseRoomPosition(state: BattleState, caseState: BattleCaseState): void {
  if (!caseState.position) return;
  const room = roomForCell(state, caseState.currentTeam, readCell(caseState.position), caseState.roomId);
  if (room) caseState.roomId = room;
}

function reservationForCase(state: BattleState, objectId: string): Reservation | undefined {
  return Object.values(state.reservations).find((reservation) => reservation.objectIds.includes(objectId));
}

function deliveryReservationForCase(state: BattleState, objectId: string): Reservation | undefined {
  return Object.values(state.reservations).find((reservation) =>
    reservation.kind === "delivery" && reservation.objectIds.includes(objectId),
  );
}

function deliveryReservationForSlot(state: BattleState, turret: BattleTurretState, stagingSlot: 0 | 1): Reservation | undefined {
  return Object.values(state.reservations).find((reservation) =>
    reservation.kind === "delivery" && reservation.targetTurretId === turret.id &&
      state.actors[reservation.ownerActorId]?.team === turret.team && reservation.targetStagingSlot === stagingSlot,
  );
}

function releaseReservation(state: BattleState, reservationId: string): void {
  const reservation = state.reservations[reservationId];
  if (!reservation) return;
  const owner = state.actors[reservation.ownerActorId];
  if (owner) owner.reservationIds = owner.reservationIds.filter((id) => id !== reservationId);
  delete state.reservations[reservationId];
}

function syncWorldObject(state: BattleState, caseState: BattleCaseState): void {
  const object: WorldObject = state.objects[caseState.id] ?? {
    id: caseState.id,
    weaponId: caseState.type,
    sourceTeam: caseState.sourceTeam,
    weight: caseState.weight,
    location: { kind: "consumed", reason: "initializing", tick: state.tick },
    originGroupId: caseState.originGroupId,
  };
  // The physical R2a case catalog is the four-case subset of the common
  // weapon catalog. Keep the catalog identity on the common projection so a
  // later common-world transition can validate the same generated object
  // without trusting a caller-provided weapon id.
  object.weaponId = caseState.type;
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
    const reservation = reservationForCase(state, caseState.id);
    object.location = reservation
      ? { kind: "reserved-carried", actorId: caseState.ownerActorId, slot: Math.max(0, slot), reservationId: reservation.id }
      : { kind: "carried", actorId: caseState.ownerActorId, slot: Math.max(0, slot) };
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

function applyActorKnockback(state: BattleState, attackerId: ActorId, targetId: ActorId): void {
  const attacker = state.actors[attackerId];
  const target = state.actors[targetId];
  if (!attacker || !target || !attacker.alive || !target.alive || attacker.location.area !== target.location.area) return;
  const attackerPosition = actorFixed(state, attacker.id);
  const targetPosition = actorFixed(state, target.id);
  const dx = targetPosition.x - attackerPosition.x;
  const dy = targetPosition.y - attackerPosition.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return;
  const desired = {
    x: Math.round(targetPosition.x + (dx / distance) * state.rules.dashKnockbackSubunits),
    y: Math.round(targetPosition.y + (dy / distance) * state.rules.dashKnockbackSubunits),
  };
  const destination = target.location.area === "plaza"
    ? plazaPointCanOccupy(state, desired)
      ? desired
      : furthestPlazaPoint(state, targetPosition, desired)
    : target.location.castleTeam && canOccupy(state, target.location.castleTeam, desired)
      ? desired
      : target.location.castleTeam
        ? furthestWalkablePoint(state, target.location.castleTeam, targetPosition, desired)
        : targetPosition;
  setActorFixed(state, target, destination);
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

function activeRepairTask(state: BattleState, actorId: ActorId): BattleRepairTask | undefined {
  return state.repairs.tasks[actorId];
}

function activeEquipmentRepairTask(state: BattleState, actorId: ActorId): BattleEquipmentRepairTask | undefined {
  return state.repairs.equipmentTasks[actorId];
}

function activeAnyRepair(state: BattleState, actorId: ActorId): BattleRepairTask | BattleEquipmentRepairTask | undefined {
  return activeRepairTask(state, actorId) ?? activeEquipmentRepairTask(state, actorId);
}

function releaseRepairReservation(state: BattleState, task: { actorId: ActorId; objectId: string }): void {
  const actor = state.actors[task.actorId];
  for (const [reservationId, reservation] of Object.entries(state.reservations)) {
    if (reservation.kind !== "repair" || !reservation.objectIds.includes(task.objectId)) continue;
    delete state.reservations[reservationId];
    if (actor) actor.reservationIds = actor.reservationIds.filter((id) => id !== reservationId);
  }
  const caseState = state.battleCases[task.objectId];
  if (caseState) syncWorldObject(state, caseState);
}

function cancelRepair(state: BattleState, task: BattleRepairTask, reason: Extract<WorldEvent, { type: "repair_cancelled" }>["reason"], events: WorldEvent[]): void {
  releaseRepairReservation(state, task);
  delete state.repairs.tasks[task.actorId];
  events.push(event("repair_cancelled", {
    actorId: task.actorId,
    objectId: task.objectId,
    team: task.team,
    partId: task.partId,
    reason,
  }));
}

function cancelEquipmentRepair(
  state: BattleState,
  task: BattleEquipmentRepairTask,
  reason: Extract<WorldEvent, { type: "equipment_repair_cancelled" }>["reason"],
  events: WorldEvent[],
): void {
  releaseRepairReservation(state, task);
  delete state.repairs.equipmentTasks[task.actorId];
  events.push(event("equipment_repair_cancelled", {
    actorId: task.actorId,
    objectId: task.objectId,
    team: task.team,
    equipmentId: task.equipmentId,
    equipmentKind: task.equipmentKind,
    reason,
  }));
}

function equipmentForRepair(
  state: BattleState,
  team: TeamId,
  kind: BattleEquipmentKind,
  id: string,
): BattleEquipmentRuntime | undefined {
  const equipment = kind === "turret"
    ? state.artillery.turrets[turretKey(team, id)]
    : state.logistics.ports[portKey(team, id)];
  return equipment?.team === team ? equipment : undefined;
}

function chooseRepairPart(state: BattleState, team: TeamId, requested?: PartId): PartId | undefined {
  const castle = state.castles[team];
  const reserved = new Set(Object.values(state.repairs.tasks)
    .filter((task) => task.team === team)
    .map((task) => task.partId));
  const valid = (partId: PartId): boolean => {
    const part = castle.exterior[partId];
    return !part.destroyed && part.health < part.maxHealth && !reserved.has(partId);
  };
  if (requested !== undefined) return valid(requested) ? requested : undefined;
  return PART_IDS
    .filter(valid)
    .sort((left, right) => {
      const a = castle.exterior[left];
      const b = castle.exterior[right];
      const leftDamage = a.maxHealth - a.health;
      const rightDamage = b.maxHealth - b.health;
      return rightDamage * a.maxHealth - leftDamage * b.maxHealth || left.localeCompare(right);
    })[0];
}

function startRepair(
  state: BattleState,
  actor: ActorState,
  caseState: BattleCaseState,
  requestedPart: PartId | undefined,
  events: WorldEvent[],
): boolean {
  if (actor.location.area !== "castle" || actor.location.castleTeam !== actor.team || actor.currentRoomId !== "repair") return false;
  if (caseState.location !== "carried" || caseState.ownerActorId !== actor.id || caseState.ownerGeneration !== actor.generation) return false;
  if (reservationForCase(state, caseState.id) || activeAnyRepair(state, actor.id)) return false;
  if (state.repairs.budgetUsed[actor.team] >= state.rules.repairBudget) return false;
  const partId = chooseRepairPart(state, actor.team, requestedPart);
  if (!partId) return false;
  const reservationId = `repair:${actor.id}:${actor.generation}:${state.tick}:${caseState.id}`;
  state.reservations[reservationId] = {
    id: reservationId,
    kind: "repair",
    ownerActorId: actor.id,
    objectIds: [caseState.id],
    createdTick: state.tick,
  };
  actor.reservationIds = [...actor.reservationIds, reservationId];
  const task: BattleRepairTask = {
    actorId: actor.id,
    generation: actor.generation,
    objectId: caseState.id,
    team: actor.team,
    partId,
    startedTick: state.tick,
    completesAtTick: state.tick + state.rules.repairWorkTicks,
  };
  state.repairs.tasks[actor.id] = task;
  syncWorldObject(state, caseState);
  events.push(event("repair_started", {
    actorId: actor.id,
    objectId: caseState.id,
    team: actor.team,
    partId,
    completesAtTick: task.completesAtTick,
  }));
  return true;
}

function startEquipmentRepair(
  state: BattleState,
  actor: ActorState,
  caseState: BattleCaseState,
  equipmentKind: BattleEquipmentKind,
  equipmentId: string,
  events: WorldEvent[],
): boolean {
  if (actor.location.area !== "castle" || actor.location.castleTeam !== actor.team || actor.currentRoomId !== "repair") return false;
  if (caseState.location !== "carried" || caseState.ownerActorId !== actor.id || caseState.ownerGeneration !== actor.generation) return false;
  if (reservationForCase(state, caseState.id) || activeAnyRepair(state, actor.id)) return false;
  const equipment = equipmentForRepair(state, actor.team, equipmentKind, equipmentId);
  if (!equipment || (equipment.health >= state.rules.equipmentRepairHealth && equipment.disabledUntilTick === null)) return false;
  if (Object.values(state.repairs.equipmentTasks).some((task) =>
    task.team === actor.team && task.equipmentKind === equipmentKind && task.equipmentId === equipmentId)) return false;
  const reservationId = `equipment-repair:${actor.id}:${actor.generation}:${state.tick}:${caseState.id}`;
  state.reservations[reservationId] = {
    id: reservationId,
    kind: "repair",
    ownerActorId: actor.id,
    objectIds: [caseState.id],
    createdTick: state.tick,
  };
  actor.reservationIds = [...actor.reservationIds, reservationId];
  const task: BattleEquipmentRepairTask = {
    actorId: actor.id,
    generation: actor.generation,
    objectId: caseState.id,
    team: actor.team,
    equipmentKind,
    equipmentId,
    startedTick: state.tick,
    completesAtTick: state.tick + state.rules.equipmentRepairWorkTicks,
  };
  state.repairs.equipmentTasks[actor.id] = task;
  syncWorldObject(state, caseState);
  events.push(event("equipment_repair_started", {
    actorId: actor.id,
    objectId: caseState.id,
    team: actor.team,
    equipmentId,
    equipmentKind,
    completesAtTick: task.completesAtTick,
  }));
  return true;
}

function processEquipmentRepairs(state: BattleState, events: WorldEvent[]): void {
  const damagedActors = new Set(events
    .filter((candidate): candidate is Extract<WorldEvent, { type: "actor_damaged" }> => candidate.type === "actor_damaged")
    .map((candidate) => candidate.actorId));
  for (const task of Object.values(state.repairs.equipmentTasks).sort((left, right) => left.actorId.localeCompare(right.actorId))) {
    const actor = state.actors[task.actorId];
    if (!actor?.alive) {
      cancelEquipmentRepair(state, task, "dead", events);
      continue;
    }
    if (actor.generation !== task.generation) {
      cancelEquipmentRepair(state, task, "stale_generation", events);
      continue;
    }
    if (damagedActors.has(actor.id)) {
      cancelEquipmentRepair(state, task, "damaged", events);
      continue;
    }
    if (actor.location.area !== "castle" || actor.location.castleTeam !== actor.team || actor.currentRoomId !== "repair") {
      cancelEquipmentRepair(state, task, "interrupted", events);
      continue;
    }
    if (state.tick < task.completesAtTick) continue;
    const equipment = equipmentForRepair(state, task.team, task.equipmentKind, task.equipmentId);
    if (!equipment || (equipment.health >= state.rules.equipmentRepairHealth && equipment.disabledUntilTick === null)) {
      cancelEquipmentRepair(state, task, "invalid_target", events);
      continue;
    }
    const caseState = state.battleCases[task.objectId];
    if (!caseState || !actor.cargoIds.includes(task.objectId)) {
      cancelEquipmentRepair(state, task, "invalid_target", events);
      continue;
    }
    equipment.health = Math.min(state.rules.equipmentHealth, state.rules.equipmentRepairHealth);
    equipment.disabledUntilTick = null;
    actor.cargoIds = actor.cargoIds.filter((id) => id !== task.objectId);
    clearCargoSlot(state, actor.id, task.objectId);
    releaseRepairReservation(state, task);
    setCaseConsumed(state, caseState, "equipment_repair");
    delete state.repairs.equipmentTasks[task.actorId];
    events.push(event("equipment_repair_completed", {
      actorId: actor.id,
      objectId: task.objectId,
      team: task.team,
      equipmentId: task.equipmentId,
      equipmentKind: task.equipmentKind,
    }));
  }
}

function processRepairs(state: BattleState, events: WorldEvent[]): void {
  const damagedActors = new Set(events
    .filter((candidate): candidate is Extract<WorldEvent, { type: "actor_damaged" }> => candidate.type === "actor_damaged")
    .map((candidate) => candidate.actorId));
  for (const task of Object.values(state.repairs.tasks).sort((left, right) => left.actorId.localeCompare(right.actorId))) {
    const actor = state.actors[task.actorId];
    if (!actor?.alive) {
      cancelRepair(state, task, "dead", events);
      continue;
    }
    if (actor.generation !== task.generation) {
      cancelRepair(state, task, "stale_generation", events);
      continue;
    }
    if (damagedActors.has(actor.id)) {
      cancelRepair(state, task, "damaged", events);
      continue;
    }
    if (actor.location.area !== "castle" || actor.location.castleTeam !== actor.team || actor.currentRoomId !== "repair") {
      cancelRepair(state, task, "interrupted", events);
      continue;
    }
    if (state.tick < task.completesAtTick) continue;
    const part = state.castles[task.team].exterior[task.partId];
    const remainingBudget = state.rules.repairBudget - state.repairs.budgetUsed[task.team];
    if (part.destroyed || part.health >= part.maxHealth || remainingBudget <= 0) {
      cancelRepair(state, task, "invalid_target", events);
      continue;
    }
    const amount = Math.min(state.rules.repairPerCase, part.maxHealth - part.health, remainingBudget);
    if (amount <= 0) {
      cancelRepair(state, task, "invalid_target", events);
      continue;
    }
    const caseState = state.battleCases[task.objectId];
    if (!caseState || !actor.cargoIds.includes(task.objectId)) {
      cancelRepair(state, task, "invalid_target", events);
      continue;
    }
    part.health += amount;
    state.repairs.budgetUsed[task.team] += amount;
    actor.cargoIds = actor.cargoIds.filter((id) => id !== task.objectId);
    clearCargoSlot(state, actor.id, task.objectId);
    releaseRepairReservation(state, task);
    setCaseConsumed(state, caseState, "repair");
    delete state.repairs.tasks[task.actorId];
    events.push(event("repair_completed", {
      actorId: actor.id,
      objectId: task.objectId,
      team: task.team,
      partId: task.partId,
      amount,
      budgetUsed: state.repairs.budgetUsed[task.team],
    }));
  }
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

function turretCanReceiveDelivery(state: BattleState, turret: BattleTurretState, caseIds: readonly string[]): boolean {
  if (!equipmentReady(state, turret)) return false;
  return caseIds.length === 0
    ? availableDeliverySlot(state, turret) !== undefined
    : caseIds.some((caseId) => availableDeliverySlot(state, turret, caseId) !== undefined);
}

function chooseDeliveryTurret(
  state: BattleState,
  actor: ActorState,
  carried: readonly BattleCaseState[],
  preferredTurretId?: string,
): BattleTurretState | undefined {
  const caseIds = carried.map((item) => item.id);
  const reservedTurretIds = new Set(
    carried
      .map((item) => deliveryReservationForCase(state, item.id)?.targetTurretId)
      .filter((id): id is string => id !== undefined),
  );
  const sourceTurretId = carried[0] ? turretForPort(state, actor.team, carried[0].sourcePortId)?.id : undefined;
  const priority = (turret: BattleTurretState): number => {
    if (reservedTurretIds.has(turret.id)) return 0;
    if (turret.id === preferredTurretId) return 1;
    if (turret.id === sourceTurretId) return 2;
    return 3;
  };
  return Object.values(state.artillery.turrets)
    .filter((turret) => turret.team === actor.team)
    .sort((left, right) => priority(left) - priority(right) || left.id.localeCompare(right.id))
    .find((turret) => turretCanReceiveDelivery(state, turret, caseIds));
}

function releaseStaleDeliveryReservations(
  state: BattleState,
  actor: ActorState,
  carried: readonly BattleCaseState[],
  events: WorldEvent[],
): void {
  for (const caseState of carried) {
    const reservation = deliveryReservationForCase(state, caseState.id);
    if (!reservation) continue;
    const turret = reservation.targetTurretId
      ? state.artillery.turrets[turretKey(actor.team, reservation.targetTurretId)]
      : undefined;
    if (turret && turretCanReceiveDelivery(state, turret, [caseState.id])) continue;

    releaseReservation(state, reservation.id);
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
    caseState.roomId = actor.currentRoomId;
    syncWorldObject(state, caseState);
    events.push(event("object_moved", { objectId: caseState.id, location: state.objects[caseState.id].location }));
  }
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
    const supplyStop = state.logistics.supplyStops[port.team];
    if (!equipmentReady(state, port) || state.tick < port.nextSpawnTick ||
      (port.stoppedUntilTick !== null && state.tick < port.stoppedUntilTick) ||
      (supplyStop !== undefined && state.tick < supplyStop.disruptedUntilTick)) continue;
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
    const groupId = `group-${port.team}-${port.id}-g${String(groupIndex + 1).padStart(2, "0")}`;
    const caseId = makeCaseId(port.team, port.id, groupIndex);
    // Supply creation crosses the common-world boundary before the physical
    // scheduler consumes its bag entry or advances the port sequence.  A
    // rejected common transition therefore cannot create a second physical
    // case, consume a stopped supply order, or leave a ghost group behind.
    syncAllWorldObjects(state);
    const common = stepWorld(state, {
      kind: "spawn_supply",
      objectId: caseId,
      team: port.team,
      portId: port.id,
      weaponId: type,
      weight: definition.weight,
      originGroupId: groupId,
      roomId: port.roomId,
      position: readCell(spawnPosition),
      matchId: state.matchId,
    });
    if (common.lastStep.rejected.length > 0 || !common.lastStep.advanced || !common.objects[caseId]) continue;
    state.objects = common.objects;
    port.groupSequence += 1;
    port.groupCount += 1;
    state.logistics.bagIndices[port.team] += 1;
    if (state.logistics.bagIndices[port.team] >= state.logistics.bags[port.team].length) {
      state.logistics.bagCycles[port.team] += 1;
      state.logistics.bags[port.team] = seededSupplyBag(state.seed, port.team, state.logistics.bagCycles[port.team]);
      state.logistics.bagIndices[port.team] = 0;
    }
    port.nextSpawnTick = state.tick + SUPPLY_PERIOD_TICKS;
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
    events.push(...common.lastStep.events.filter((item) => item.type === "case_spawned" || item.type === "object_moved"));
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
  for (const reservationId of actor.reservationIds) delete state.reservations[reservationId];
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

function availableStagingSlot(
  state: BattleState,
  actor: ActorState,
  turret: BattleTurretState,
  caseId?: string,
): 0 | 1 | undefined {
  if (!equipmentReady(state, turret)) return undefined;
  const actorPosition = actorFixed(state, actor.id);
  for (const slot of [0, 1] as const) {
    if (turret.stagingSlots[slot] !== null) continue;
    const reservation = deliveryReservationForSlot(state, turret, slot);
    if (reservation && (!caseId || !reservation.objectIds.includes(caseId))) continue;
    const stagingPosition = turret.stagingPositions[slot];
    if (withinActionRange(actorPosition, stagingPosition) && hasFloorLineOfSight(state, actor.team, actorPosition, stagingPosition)) return slot;
  }
  return undefined;
}

function availableDeliverySlot(state: BattleState, turret: BattleTurretState, caseId?: string): 0 | 1 | undefined {
  const existing = caseId ? deliveryReservationForCase(state, caseId) : undefined;
  if (existing?.targetTurretId !== undefined && existing.targetTurretId !== turret.id) return undefined;
  for (const slot of [0, 1] as const) {
    if (existing?.targetStagingSlot !== undefined && existing.targetStagingSlot !== slot) continue;
    if (turret.stagingSlots[slot] !== null) continue;
    const reservation = deliveryReservationForSlot(state, turret, slot);
    if (reservation && (!caseId || !reservation.objectIds.includes(caseId))) continue;
    return slot;
  }
  return undefined;
}

function reserveDeliveryThroughCommon(
  state: BattleState,
  actor: ActorState,
  caseState: BattleCaseState,
  turret: BattleTurretState,
  stagingSlot: 0 | 1 | undefined,
  events: WorldEvent[],
): string | undefined {
  const existing = deliveryReservationForCase(state, caseState.id);
  if (existing) {
    if (existing.ownerActorId === actor.id && existing.targetTurretId === turret.id &&
        (stagingSlot === undefined || existing.targetStagingSlot === stagingSlot)) return existing.id;
    return undefined;
  }
  if (reservationForCase(state, caseState.id)) return undefined;
  const reservationId = `delivery:${state.matchId}:${state.tick}:${actor.id}:${actor.generation}:${caseState.id}`;
  // The common transition must see the same cargo ownership that the
  // physical coordinator is about to stage.  It owns reservation identity;
  // fixed-point range and staging occupancy remain physical checks.
  syncAllWorldObjects(state);
  const common = stepWorld(state, {
    kind: "reserve_delivery",
    objectId: caseState.id,
    actorId: actor.id,
    generation: actor.generation,
    team: actor.team,
    turretId: turret.id,
    stagingSlot,
    reservationId,
    matchId: state.matchId,
  });
  const commonObject = common.objects[caseState.id];
  const commonReservation = common.reservations[reservationId];
  if (common.lastStep.rejected.length > 0 || !common.lastStep.advanced ||
      commonObject?.location.kind !== "reserved-carried" ||
      commonObject.location.actorId !== actor.id || commonObject.location.reservationId !== reservationId ||
      commonReservation?.targetTurretId !== turret.id ||
      (stagingSlot !== undefined && commonReservation.targetStagingSlot !== stagingSlot)) return undefined;
  state.objects = common.objects;
  state.reservations = common.reservations;
  const commonActor = common.actors[actor.id];
  if (commonActor) actor.reservationIds = [...commonActor.reservationIds];
  events.push(...common.lastStep.events.filter((item) => item.type === "object_moved"));
  return reservationId;
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

function deliverCase(
  state: BattleState,
  actor: ActorState,
  caseState: BattleCaseState,
  route: BattleRoute | undefined,
  part: PartId | undefined,
  events: WorldEvent[],
  requestedTurret?: BattleTurretState,
): boolean {
  if (!actor.cargoIds.includes(caseState.id)) return false;
  if (route !== undefined && !isBattleRoute(route)) return false;
  if (part !== undefined && !isPartId(part)) return false;
  const turret = requestedTurret ?? turretAtActor(state, actor);
  if (!turret || turret.team !== actor.team || !equipmentReady(state, turret)) return false;
  const existingReservation = deliveryReservationForCase(state, caseState.id);
  if (existingReservation && (existingReservation.ownerActorId !== actor.id || existingReservation.targetTurretId !== turret.id)) return false;
  const reservedSlot = existingReservation?.targetTurretId === turret.id ? existingReservation.targetStagingSlot : undefined;
  const actorPosition = actorFixed(state, actor.id);
  let stagingSlot: 0 | 1 | undefined;
  if (reservedSlot !== undefined) {
    const slotAvailable = turret.stagingSlots[reservedSlot] === null &&
      withinActionRange(actorPosition, turret.stagingPositions[reservedSlot]) &&
      hasFloorLineOfSight(state, actor.team, actorPosition, turret.stagingPositions[reservedSlot]);
    stagingSlot = slotAvailable ? reservedSlot : undefined;
  } else {
    stagingSlot = availableStagingSlot(state, actor, turret, caseState.id);
  }
  if (stagingSlot === undefined) return false;
  const reservationId = reserveDeliveryThroughCommon(state, actor, caseState, turret, stagingSlot, events);
  if (!reservationId) return false;
  // Route/aim selection is held separately while the case waits on the floor;
  // route/targetPart themselves are captured only when load enqueues it.
  caseState.pendingRoute = route;
  caseState.pendingTargetPart = part;
  caseState.pendingSelectionActorId = actor.id;
  removeFromArray(actor.cargoIds, caseState.id);
  clearCargoSlot(state, actor.id, caseState.id);
  releaseReservation(state, reservationId);
  turret.handoffIds.push(caseState.id);
  setCaseHandoff(state, caseState, turret, stagingSlot);
  events.push(event("object_moved", { objectId: caseState.id, location: state.objects[caseState.id].location }));
  return true;
}

function loadHandoff(state: BattleState, actor: ActorState, turret: BattleTurretState, route: BattleRoute | undefined, part: PartId | undefined, events: WorldEvent[]): boolean {
  if (turret.team !== actor.team || !equipmentReady(state, turret) || turret.queueIds.length >= QUEUE_CAPACITY_PER_TURRET) return false;
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
  // Fixtures and physical AI update the case registry before the denormalized
  // R1 object projection. Normalize it before taking the rollback snapshot so
  // a rejected common transition leaves every object unchanged.
  syncAllWorldObjects(state);
  const eventStart = events.length;
  const caseBefore = structuredClone(caseState);
  const objectBefore = state.objects[caseId] ? structuredClone(state.objects[caseId]) : undefined;
  const cargoBefore = [...actor.cargoIds];
  const slotsBefore = [...(state.cargoSlots[actor.id] ?? [null, null])] as [string | null, string | null];
  const handoffIdsBefore = [...turret.handoffIds];
  const stagingSlotsBefore = [...turret.stagingSlots] as [string | null, string | null];
  if (!pickCase(state, actor, caseState, events)) return false;
  // The common rules own the queue transition. Physical staging and fixed
  // coordinates remain authoritative, but the same object must first pass
  // the common actor/ownership/capacity checks on the tick snapshot.
  const common = stepWorld(state, {
    kind: "enqueue_object",
    objectId: caseId,
    actorId: actor.id,
    generation: actor.generation,
    team: actor.team,
    turretId: turret.id,
    matchId: state.matchId,
  });
  const commonObject = common.objects[caseId];
  const expectedQueueIndex = turret.queueIds.length;
  const commonQueueAccepted = common.lastStep.rejected.length === 0 && common.lastStep.advanced &&
    commonObject?.location.kind === "queue" && commonObject.location.team === actor.team &&
    commonObject.location.turretId === turret.id && commonObject.location.index === expectedQueueIndex;
  if (!commonQueueAccepted) {
    // A rejected common transition must not consume the physical handoff or
    // leave the actor with a case that disappeared from its staging slot.
    Object.assign(caseState, caseBefore);
    actor.cargoIds = cargoBefore;
    state.cargoSlots[actor.id] = slotsBefore;
    turret.handoffIds = handoffIdsBefore;
    turret.stagingSlots = stagingSlotsBefore;
    if (objectBefore) state.objects[caseId] = objectBefore;
    else delete state.objects[caseId];
    events.splice(eventStart);
    return false;
  }
  state.objects = common.objects;
  events.push(...common.lastStep.events);
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
  if (activeAnyRepair(state, actor.id) && intent.handle !== "repair") {
    addRejection(report, 0, "invalid_object_transition", "actor is already repairing");
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
  if (intent.equipmentKind !== undefined && !isBattleEquipmentKind(intent.equipmentKind)) {
    addRejection(report, 0, "invalid_transition", "unknown equipment kind");
    return;
  }
  if ((intent.equipmentKind === undefined) !== (intent.equipmentId === undefined)) {
    addRejection(report, 0, "invalid_transition", "equipment repair requires kind and id");
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
  } else if (intent.handle === "repair") {
    const selectedId = state.cargoSlots[actor.id]?.[slot] ?? null;
    candidate = selectedId ? state.battleCases[selectedId] : undefined;
    const started = candidate && intent.equipmentKind !== undefined && intent.equipmentId !== undefined
      ? startEquipmentRepair(state, actor, candidate, intent.equipmentKind, intent.equipmentId, events)
      : candidate && intent.equipmentKind === undefined && intent.equipmentId === undefined
        ? startRepair(state, actor, candidate, intent.part, events)
        : false;
    if (!started) {
      addRejection(report, 0, "invalid_object_transition", "repair room, case, target, or repair budget unavailable");
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
  if (!equipmentReady(state, turret)) return false;
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
    splitAttempted: false,
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
    if (!equipmentReady(state, turret)) continue;
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

function impactDamage(flight: BattleFlightState, caseState: BattleCaseState): number {
  return flight.damageOverride ?? caseDefinition(caseState.type)?.partDamage ?? 0;
}

function applyImpactEffect(state: BattleState, flight: BattleFlightState, caseState: BattleCaseState, events: WorldEvent[]): void {
  const effect = caseDefinition(caseState.type)?.effect;
  if (!effect || effect.kind === "none" || effect.kind === "split") return;
  if (effect.kind === "disrupt") {
    const stop = state.logistics.supplyStops[flight.targetTeam];
    if (stop && state.tick >= stop.immuneUntilTick) {
      stop.disruptedUntilTick = state.tick + effect.durationTicks;
      stop.immuneUntilTick = stop.disruptedUntilTick + effect.immunityTicks;
      events.push(event("supply_disrupted", {
        sourceProjectileId: flight.id,
        team: flight.targetTeam,
        disruptedUntilTick: stop.disruptedUntilTick,
        immuneUntilTick: stop.immuneUntilTick,
      }));
    }
    return;
  }
  const zone: BattleSlowZone = {
    sourceTeam: flight.team,
    targetTeam: flight.targetTeam,
    center: frontEntryCenter(state, flight.targetTeam),
    radiusSubunits: Math.round(effect.radiusFloorUnits * 1000),
    multiplier: effect.multiplier,
    expiresAtTick: state.tick + effect.durationTicks,
  };
  state.logistics.slowZones[flight.targetTeam] = zone;
  events.push(event("slow_zone_created", {
    sourceProjectileId: flight.id,
    sourceTeam: zone.sourceTeam,
    targetTeam: zone.targetTeam,
    center: zone.center,
    radiusSubunits: zone.radiusSubunits,
    multiplier: zone.multiplier,
    expiresAtTick: zone.expiresAtTick,
  }));
}

function splitFlight(state: BattleState, flight: BattleFlightState, events: WorldEvent[]): void {
  const caseState = state.battleCases[flight.objectId];
  const definition = caseState ? caseDefinition(caseState.type) : undefined;
  const effect = definition?.effect;
  if (!caseState || !effect || effect.kind !== "split" || flight.splitAttempted || flight.progress < 0.5) return;
  // A parent gets one split decision.  If the global projectile limit is full,
  // it continues as the authored parent instead of retrying every tick.
  flight.splitAttempted = true;
  if (Object.keys(state.artillery.flights).length - 1 + effect.children > MAX_FLIGHT_COUNT) {
    events.push(event("projectile_split_blocked", { parentProjectileId: flight.id }));
    return;
  }
  const group = state.logistics.groups[caseState.originGroupId];
  if (!group || group.retired) return;
  const childFlightIds: string[] = [];
  for (let index = 0; index < effect.children; index += 1) {
    const childFlightId = `${flight.id}-split-${index + 1}`;
    const childObjectId = `${caseState.id}-child-${index + 1}`;
    childFlightIds.push(childFlightId);
    const childCase: BattleCaseState = {
      id: childObjectId,
      type: caseState.type,
      sourceTeam: caseState.sourceTeam,
      currentTeam: flight.team,
      weight: caseState.weight,
      location: "flying",
      originGroupId: caseState.originGroupId,
      sourcePortId: caseState.sourcePortId,
      createdTick: state.tick,
      roomId: caseState.roomId,
      flightId: childFlightId,
      route: flight.route,
      targetPart: flight.targetPart,
      interceptRemaining: effect.childInterceptHits,
    };
    state.battleCases[childObjectId] = childCase;
    group.caseIds.push(childObjectId);
    state.objects[childObjectId] = {
      id: childObjectId,
      weaponId: childCase.type,
      sourceTeam: childCase.sourceTeam,
      weight: childCase.weight,
      originGroupId: childCase.originGroupId,
      parentObjectId: caseState.id,
      location: { kind: "flying", projectileId: childFlightId },
    };
    state.projectiles[childFlightId] = {
      id: childFlightId,
      objectId: childObjectId,
      team: flight.team,
      sourceActorId: flight.sourceActorId,
      sourceGeneration: flight.sourceGeneration,
      targetTeam: flight.targetTeam,
      targetPartId: flight.targetPart,
    };
    state.artillery.flights[childFlightId] = {
      id: childFlightId,
      objectId: childObjectId,
      team: flight.team,
      sourceActorId: flight.sourceActorId,
      sourceGeneration: flight.sourceGeneration,
      targetTeam: flight.targetTeam,
      route: flight.route,
      progress: Math.max(0, flight.progress - (index * effect.spacingRouteUnits) / flight.distanceUnits),
      targetPart: flight.targetPart,
      interceptRemaining: effect.childInterceptHits,
      createdTick: state.tick,
      distanceUnits: flight.distanceUnits,
      speedUnitsPerSecond: effect.childSpeedUnitsPerSecond,
      previousProgress: Math.max(0, flight.progress - (index * effect.spacingRouteUnits) / flight.distanceUnits),
      damageOverride: effect.childPartDamage,
      splitAttempted: true,
    };
    syncWorldObject(state, childCase);
  }
  consumeFlight(state, flight, "split", events);
  events.push(event("projectile_split", { parentProjectileId: flight.id, childProjectileIds: childFlightIds }));
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
  for (const flight of current) {
    if (state.artillery.flights[flight.id]) splitFlight(state, state.artillery.flights[flight.id], events);
  }
  const impactGroups = new Map<string, Array<{ flight: BattleFlightState; caseState: BattleCaseState; targetPart?: PartId }>>();
  for (const flight of Object.values(state.artillery.flights).sort((left, right) => left.id.localeCompare(right.id))) {
    if (flight.progress < 1 || flight.createdTick === state.tick) continue;
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
      const amount = impacts.reduce((sum, impact) => sum + impactDamage(impact.flight, impact.caseState), 0);
      const part = state.castles[targetTeam].exterior[partId];
      const oldHealth = part.health;
      part.health = Math.max(0, part.health - amount);
      if (oldHealth !== part.health) events.push(event("part_damaged", { team: targetTeam, partId, amount: oldHealth - part.health }));
      if (part.health === 0) part.destroyed = true;
    }
    for (const impact of impacts) {
      applyImpactEffect(state, impact.flight, impact.caseState, events);
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
  const direct = readCell(target);
  // Room goals are authored walkable points. Try their direct cell before the
  // 32-point approach ring; most internal patrol/return routes therefore need
  // only one BFS instead of exploring every approach candidate.
  const directPath = nearestCellPath(state, team, from, direct);
  if (directPath.length > 0) return directPath;
  const candidates = walkableApproachCells(state, team, target)
    .filter((cell) => cell.x !== direct.x || cell.y !== direct.y);
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
  releaseStaleDeliveryReservations(state, actor, carried, events);
  const turret = chooseDeliveryTurret(state, actor, carried, assignment.targetTurretId);
  if (!turret) {
    assignment.task = "idle";
    assignment.path = [];
    assignment.pathIndex = 0;
    assignment.targetTurretId = undefined;
    assignment.stuckTicks = 0;
    state.crew.assignments[actor.id] = assignment;
    return;
  }
  assignment.task = "deliver";
  if (assignment.targetTurretId !== turret.id || assignment.path.length === 0) {
    assignment.targetTurretId = turret.id;
    assignment.path = actorTargetPath(state, actor, turret.operatorPosition);
    assignment.pathIndex = 0;
    assignment.stuckTicks = 0;
  }
  // The public player flow owns its two visible handoff slots. Player-side
  // support actors still pass through the common reservation immediately
  // before handoff, but do not pre-claim slots while P1 is navigating. Enemy
  // carriers use the persistent departure reservation below.
  if (!actorIsProtected(state, actor) && actor.team !== PLAYER_TEAM) {
    for (const item of carried) {
      if (deliveryReservationForCase(state, item.id)) continue;
      const stagingSlot = availableDeliverySlot(state, turret);
      if (stagingSlot === undefined) break;
      reserveDeliveryThroughCommon(state, actor, item, turret, stagingSlot, events);
    }
  }
  moveAIAlongPath(state, actor, assignment, turret.operatorPosition);
  if (!actorIsProtected(state, actor)) {
    let delivered = false;
    for (const item of [...carried]) {
      if (turret.handoffIds.length >= STAGING_SLOTS_PER_TURRET) break;
      delivered = deliverCase(state, actor, item, undefined, undefined, events, turret) || delivered;
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
    const decision = state.enemyDecisions[actor.id];
    if (decision && enemyDecisionUsesPhysicalMover(actor, decision.intent)) continue;
    if (actor.role === "ammo_carrier" || actor.role === "support") processCarrierAI(state, actor, events);
    else if (actor.role === "shooter") processShooterAI(state, actor);
  }
}

function markDeathIfNeeded(state: BattleState, events: WorldEvent[]): void {
  for (const actor of Object.values(state.actors)) {
    if (!actor.alive || actor.health > 0 || actor.respawnAtTick !== null) continue;
    state.dashes[actor.id] = undefined;
    const repair = activeAnyRepair(state, actor.id);
    if (repair) {
      if ("partId" in repair) cancelRepair(state, repair, "dead", events);
      else cancelEquipmentRepair(state, repair, "dead", events);
    }
    dropActorCargo(state, actor, events);
    actor.alive = false;
    actor.health = 0;
    actor.deathCount += 1;
    actor.lastDeathTick = state.tick;
    actor.respawnAtTick = state.tick + (actor.team === PLAYER_TEAM ? state.rules.playerRespawnTicks : state.rules.enemyRespawnTicks);
    actor.damageImmuneUntilTick = null;
    actor.turretControlIds = [];
    resetAssignment(state, actor.id);
    if (actor.team === ENEMY_TEAM) delete state.enemyDecisions[actor.id];
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
    actor.damageImmuneUntilTick = null;
    state.dashes[actor.id] = undefined;
    state.dashCooldownUntilTick[actor.id] = state.tick;
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
        health: state.rules.equipmentHealth,
        disabledUntilTick: null,
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
        health: state.rules.equipmentHealth,
        disabledUntilTick: null,
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
    dashes: Object.fromEntries(Object.keys(world.actors).map((actorId) => [actorId, undefined])) as BattleState["dashes"],
    dashCooldownUntilTick: Object.fromEntries(Object.keys(world.actors).map((actorId) => [actorId, 0])) as BattleState["dashCooldownUntilTick"],
    cargoSlots: Object.fromEntries(Object.keys(world.actors).map((actorId) => [actorId, [null, null]])) as BattleState["cargoSlots"],
    battleCases: {},
    logistics: {
      ports: {},
      groups: {},
      bags: { player: seededSupplyBag(world.seed, PLAYER_TEAM, 0), enemy: seededSupplyBag(world.seed, ENEMY_TEAM, 0) },
      bagIndices: { player: 0, enemy: 0 },
      bagCycles: { player: 0, enemy: 0 },
      supplyStops: {
        player: { disruptedUntilTick: 0, immuneUntilTick: 0 },
        enemy: { disruptedUntilTick: 0, immuneUntilTick: 0 },
      },
      slowZones: {},
    },
    artillery: { turrets: {}, flights: {}, nextLaunchTick: { player: 0, enemy: 0 }, roundRobinTurretIndex: { player: 0, enemy: 0 }, contactPairs: {} },
    crew: { assignments: {} },
    repairs: { tasks: {}, equipmentTasks: {}, budgetUsed: { player: 0, enemy: 0 } },
    enemyDecisions: {},
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
  const repair = activeAnyRepair(state, actor.id);
  const movementRequested = (intent.direction !== undefined && isFiniteDirection(intent.direction) && (intent.direction.x !== 0 || intent.direction.y !== 0)) || intent.dash !== undefined;
  if (repair && movementRequested) {
    if ("partId" in repair) cancelRepair(state, repair, "interrupted", events);
    else cancelEquipmentRepair(state, repair, "interrupted", events);
  }
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
  const startedRepair = activeAnyRepair(state, actor.id);
  if (startedRepair && movementRequested) {
    if ("partId" in startedRepair) cancelRepair(state, startedRepair, "interrupted", events);
    else cancelEquipmentRepair(state, startedRepair, "interrupted", events);
  }
  const rejectionCountBeforeDash = report.rejected.length;
  if (intent.dash !== undefined) startDash(state, actor, intent.dash, report);
  if (report.rejected.length > rejectionCountBeforeDash) return;
  if (intent.direction !== undefined) {
    if (intent.direction.x === 0 && intent.direction.y === 0) {
      // A held movement pad commonly reports its neutral vector each tick.
    } else if (!isFiniteDirection(intent.direction)) addRejection(report, 0, "invalid_transition", "direction must be a unit vector");
    else if (!state.dashes[actor.id]) {
      moveFixed(state, actor, intent.direction);
      report.acceptedInputKinds.push("direction");
    }
  }
}

function bridgeRejectionReason(kind: R2bBridgeRequest["kind"], reason: string): RejectedInput["reason"] {
  if (reason === "wrong_match") return "wrong_match";
  if (reason === "missing_generation") return "missing_generation";
  if (reason === "stale_generation") return "stale_generation";
  if (reason === "unknown_actor") return "unknown_actor";
  if (reason === "dead_actor") return "dead_actor";
  if (kind === "core_contact" && ["invalid_target", "invalid_contact", "closed_route"].includes(reason)) {
    return "invalid_core_attack";
  }
  return "invalid_transition";
}

/**
 * Consume one validated R2b boundary in the current physical tick.
 *
 * `stepWorld` is intentionally called on a snapshot and its clock fields are
 * not copied back.  The physical coordinator owns the one shared tick and
 * advances it once below, before the remaining logistics and artillery work.
 * Only the world-owned fields and events produced by the bridge input are
 * merged.
 */
function applyR2bBridge(
  state: BattleState,
  intent: BattleIntent | undefined,
  report: StepReport,
  events: WorldEvent[],
): void {
  const request = intent?.bridge;
  if (!request) return;
  // The bridge is part of the same public intent. If its match, actor, or
  // ordinary physical fields were rejected above, do not let a separately
  // valid-looking evidence envelope bypass that rejection.
  if (report.rejected.length > 0) return;
  if (request.evidence.actorId !== intent.actorId || request.evidence.generation !== intent.generation) {
    addRejection(report, 0, "stale_generation", "bridge evidence is not bound to the public actor snapshot");
    return;
  }

  const prepared = prepareR2bWorldInput(state, request);
  if (!prepared.ok) {
    addRejection(report, 0, bridgeRejectionReason(request.kind, prepared.reason), `bridge:${request.kind}: ${prepared.detail ?? prepared.reason}`);
    return;
  }

  const contactEvidence: PhysicalActorContactEvidence | undefined = request.kind === "actor_contact" ? request.evidence : undefined;
  const contactTarget = contactEvidence ? state.actors[contactEvidence.targetActorId] : undefined;
  const contactTargetPosition = contactEvidence ? copyPoint(actorFixed(state, contactEvidence.targetActorId)) : undefined;
  const contactCargoBefore = contactTarget ? new Set(contactTarget.cargoIds) : undefined;
  const contactSlotsBefore = contactTarget ? [...(state.cargoSlots[contactTarget.id] ?? [null, null])] as [string | null, string | null] : undefined;
  const bridged = stepWorld(prepared.value.state, prepared.value.input);
  const bridgedReport = bridged.lastStep;
  if (bridgedReport.rejected.length > 0 || !bridgedReport.advanced) {
    for (const rejection of bridgedReport.rejected) {
      addRejection(report, 0, rejection.reason, `bridge:${request.kind}: ${rejection.detail ?? rejection.reason}`);
    }
    if (bridgedReport.rejected.length === 0) {
      addRejection(report, 0, "invalid_transition", `bridge:${request.kind}: common world did not advance`);
    }
    return;
  }

  events.push(...bridgedReport.events);
  report.acceptedInputKinds.push(`bridge:${request.kind}`);

  // The physical state extends WorldState. Merge only common-world authority;
  // tick, randomState, lastStep, and eventLog remain owned by this coordinator.
  state.rulesetId = bridged.rulesetId;
  state.rules = bridged.rules;
  state.phase = bridged.phase;
  state.pauseReasons = bridged.pauseReasons;
  state.visibility = bridged.visibility;
  state.outcome = bridged.outcome;
  state.castles = bridged.castles;
  state.actors = bridged.actors;
  state.objects = bridged.objects;
  state.projectiles = bridged.projectiles;
  state.reservations = bridged.reservations;
  state.plaza = bridged.plaza;
  if (contactEvidence && contactTargetPosition && contactCargoBefore) {
    const mergedTarget = state.actors[contactEvidence.targetActorId];
    if (mergedTarget && contactSlotsBefore) {
      state.cargoSlots[mergedTarget.id] = contactSlotsBefore.map((objectId) =>
        objectId !== null && mergedTarget.cargoIds.includes(objectId) ? objectId : null,
      ) as [string | null, string | null];
    }
    for (const bridgedEvent of bridgedReport.events) {
      if (bridgedEvent.type !== "object_moved" || !contactCargoBefore.has(bridgedEvent.objectId)) continue;
      const caseState = state.battleCases[bridgedEvent.objectId];
      if (!caseState || bridgedEvent.location.kind !== "floor") continue;
      clearCargoSlot(state, contactEvidence.targetActorId, bridgedEvent.objectId);
      setCaseFloor(state, caseState, contactTargetPosition, bridgedEvent.location.team);
    }
    applyActorKnockback(state, contactEvidence.actorId, contactEvidence.targetActorId);
  }
  for (const bridgedEvent of bridgedReport.events) {
    if (bridgedEvent.type !== "actor_respawned") continue;
    const actor = state.actors[bridgedEvent.actorId];
    if (!actor) continue;
    // Common respawn uses the authored cell pad. Keep the physical projection
    // aligned without replaying a route-crossing side effect in this tick.
    state.fixedActors[actor.id] = {
      position: { x: cellCenter(actor.position.x), y: cellCenter(actor.position.y) },
      remainder: { x: 0, y: 0 },
    };
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
  for (const [team, zone] of Object.entries(next.logistics.slowZones)) {
    if (zone && currentTick >= zone.expiresAtTick) delete next.logistics.slowZones[team as TeamId];
  }
  const startActors = structuredClone(next.actors);
  applyIntent(next, intent, report, events);
  markDeathIfNeeded(next, events);
  updatePhysicalEnemyDecisions(next);
  processCrewAI(next, events);
  processInternalSoldierAI(next, intent?.dash !== undefined || intent?.bridge !== undefined);
  updateCaseCarriedPositions(next);
  const dashResult = advanceDashes(next, events);
  if (dashResult.equipmentContact) report.acceptedInputKinds.push("equipment_contact");
  const generatedBridge = dashResult.bridge;
  const bridgeIntent = intent?.bridge ? intent : generatedBridge
    ? (intent && intent.actorId === generatedBridge.evidence.actorId && intent.generation === generatedBridge.evidence.generation ? { ...intent, bridge: generatedBridge } : {
      matchId: next.matchId,
      actorId: generatedBridge.evidence.actorId,
      generation: generatedBridge.evidence.generation,
      bridge: generatedBridge,
    })
    : intent;
  applyR2bBridge(next, bridgeIntent, report, events);
  // A validated actor hit must be visible to the common world before launch
  // selection.  A terminal core contact ends the tick without creating new
  // logistics/artillery side effects.
  if ((next.phase as string) !== "ended") {
    // Manual equipment repair wins over the automatic deadline in the same
    // tick.  Restore any remaining disabled equipment only after the manual
    // completion/cancellation boundary has been resolved.
    processRepairs(next, events);
    processEquipmentRepairs(next, events);
    restoreDisabledEquipment(next, events);
    autoLoadAtTurrets(next, events);
    autoLaunch(next, startActors, events);
    resolveFlights(next, events);
    spawnSupply(next, events);
    markDeathIfNeeded(next, events);
  }

  let finalOutcome: BattleState["outcome"] = next.outcome;
  if (finalOutcome === "ongoing" && currentTick >= next.matchLimitTicks - 1) finalOutcome = "draw";
  if (finalOutcome !== "ongoing") {
    next.outcome = finalOutcome;
    next.phase = "ended";
    for (const actor of Object.values(next.actors)) if (!actor.alive) actor.respawnAtTick = null;
    if (!events.some((candidate) => candidate.type === "outcome")) {
      events.push(event("outcome", { outcome: finalOutcome, tick: currentTick }));
    }
  } else finishRespawns(next, events);

  // A terminal core contact or timeout cannot leave a live repair reservation
  // behind in the final snapshot. No repair work is completed after the match
  // ends; the held case is returned by the cancellation boundary below.
  if ((next.phase as string) === "ended") {
    for (const task of Object.values(next.repairs.tasks)) cancelRepair(next, task, "interrupted", events);
    for (const task of Object.values(next.repairs.equipmentTasks)) cancelEquipmentRepair(next, task, "interrupted", events);
  }

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
  const selectedOwned = !!selectedCase && selectedCase.location === "carried" && selectedCase.ownerActorId === actorId && selectedCase.ownerGeneration === actor?.generation && !reservationForCase(state, selectedCase.id);
  const repairRoom = actor?.location.area === "castle" && actor.location.castleTeam === actor.team && actor.currentRoomId === "repair";
  const equipmentRepairTargets = actor && repairRoom
    ? [
      ...Object.values(state.artillery.turrets)
        .filter((equipment) => equipment.team === actor.team && (equipment.health < state.rules.equipmentRepairHealth || equipment.disabledUntilTick !== null))
        .map((equipment) => ({ kind: "turret" as const, id: equipment.id, health: equipment.health, disabledUntilTick: equipment.disabledUntilTick })),
      ...Object.values(state.logistics.ports)
        .filter((equipment) => equipment.team === actor.team && (equipment.health < state.rules.equipmentRepairHealth || equipment.disabledUntilTick !== null))
        .map((equipment) => ({ kind: "supply_port" as const, id: equipment.id, health: equipment.health, disabledUntilTick: equipment.disabledUntilTick })),
    ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
    : [];
  if (actionable && selectedOwned && repairRoom && !activeAnyRepair(state, actor!.id) &&
      (equipmentRepairTargets.length > 0 || PART_IDS.some((partId) => {
        const part = state.castles[actor!.team].exterior[partId];
        return !part.destroyed && part.health < part.maxHealth;
      }))) handles.push("repair");
  if (actionable && selectedOwned && turret && availableStagingSlot(state, actor!, turret, selectedCase?.id) !== undefined) handles.push("deliver");
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
    equipmentRepairTargets,
    contextToken,
    selectedSlot,
  };
}

export { CASE_TYPES, ARTILLERY_ROUTES };
