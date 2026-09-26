/**
 * The domain model deliberately contains data only.  It has no reference to
 * Phaser, DOM objects, timers, or a renderer.  A render layer may project this
 * state into whatever view is appropriate for the current screen.
 */

export const PART_IDS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7"] as const;
export type PartId = (typeof PART_IDS)[number];

export const GATE_IDS = ["G1", "G2", "G3", "G4", "G5", "G6", "G7"] as const;
export type GateId = (typeof GATE_IDS)[number];

export const PLAYER_ACTOR_IDS = ["P1", "P2", "P3"] as const;
export type PlayerActorId = (typeof PLAYER_ACTOR_IDS)[number];
export type EnemyActorId = `E${string}`;
export type ActorId = PlayerActorId | EnemyActorId | string;

export type TeamId = "player" | "enemy";
export type AreaId = "castle" | "plaza";
export type MatchPhase = "running" | "paused" | "ended";
export type PauseReason = "explicit" | "visibility";
export type Outcome = "ongoing" | "player_win" | "enemy_win" | "draw";

export type ActorRole =
  | "player"
  | "support"
  | "shooter"
  | "shooter_guard"
  | "ammo_carrier"
  | "internal_soldier";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RecoveryPad {
  id: string;
  actorId: string;
  roomId: string;
  cell: Point;
  walkable: boolean;
}

export type RoomKind =
  | "core"
  | "respawn"
  | "corridor"
  | "repair"
  | "command"
  | "supply"
  | "battery"
  | "security";

export interface RoomDefinition {
  id: string;
  label: string;
  kind: RoomKind;
  rect: Rect;
  recoveryPads: RecoveryPad[];
}

export interface LayoutLink {
  a: string;
  b: string;
  gateId?: GateId;
  passageId?: string;
}

export interface CastleLayout {
  side: TeamId;
  widthCells: number;
  heightCells: number;
  frontDirection: 1 | -1;
  rooms: RoomDefinition[];
  links: LayoutLink[];
  /** Floor cells including explicit room rectangles and link passages. */
  floorCells: Point[];
  /** Cells occupied by each gate passage when that gate is closed. */
  gateCells: Record<GateId, Point[]>;
  /** Authored non-room passage cells, retained for deterministic room projection. */
  passageCells?: Record<string, Point[]>;
  coreRouteRooms: string[];
  coreRouteGates: GateId[];
  turrets: TurretDefinition[];
  supplyPorts: SupplyPortDefinition[];
}

export interface WorldLayout {
  widthCells: number;
  heightCells: number;
  home: CastleLayout;
  enemy: CastleLayout;
  /** The region between the two castle entrances. */
  plaza: Rect;
  mirrorRule: {
    point: "125-x,y";
    rect: "126-x1,y0,126-x0,y1";
    direction: "-dx,dy";
    textAndControlsMirrored: false;
  };
}

export interface TurretDefinition {
  id: string;
  label: string;
  roomId: string;
  /** The operator belongs to the castle's own team. */
  operatorActorId: ActorId | null;
  queueCapacity: number;
  stagingFloorSlots: number;
  cell: Point;
}

export interface SupplyPortDefinition {
  id: string;
  roomId: string;
  cell: Point;
}

export interface ExteriorPartState {
  id: PartId;
  maxHealth: number;
  health: number;
  destroyed: boolean;
}

export interface GateState {
  id: GateId;
  open: boolean;
}

export interface CoreState {
  roomId: "core";
  hit: boolean;
}

export interface CastleState {
  team: TeamId;
  exterior: Record<PartId, ExteriorPartState>;
  gates: Record<GateId, GateState>;
  destroyedPartIds: PartId[];
  openGateIds: GateId[];
  core: CoreState;
}

export interface ActorLocation {
  area: AreaId;
  castleTeam?: TeamId;
  roomId?: string;
  /** Rooms traversed since entering the current castle. */
  pathRooms: string[];
  /** Gates traversed since entering the current castle. */
  pathGates: GateId[];
}

export interface Reservation {
  id: string;
  kind: "work" | "delivery" | "turret" | "repair";
  ownerActorId: ActorId;
  objectIds: string[];
  createdTick: number;
  /** Destination captured when a delivery reservation is made. */
  targetTurretId?: string;
  /** Physical handoff slot captured before a carrier leaves for the turret. */
  targetStagingSlot?: 0 | 1;
}

export interface ActorState {
  id: ActorId;
  team: TeamId;
  role: ActorRole;
  homeRoomId: string;
  initialRoomId: string;
  respawnRoomId: string;
  respawnPadId: string;
  currentRoomId: string;
  location: ActorLocation;
  position: Point;
  maxHealth: number;
  health: number;
  alive: boolean;
  generation: number;
  protectedUntilTick: number | null;
  /** The first damage tick after a hit is exclusive; null means vulnerable. */
  damageImmuneUntilTick: number | null;
  respawnAtTick: number | null;
  cargoIds: string[];
  reservationIds: string[];
  turretControlIds: string[];
  turretId?: string;
  guardedActorId?: EnemyActorId;
  canAssaultOtherVehicle?: boolean;
  canGuardPlaza?: boolean;
  deathCount: number;
  lastDeathTick: number | null;
}

export type ObjectLocation =
  | { kind: "floor"; team: TeamId; roomId: string; position: Point }
  | { kind: "carried"; actorId: ActorId; slot: number }
  | {
      kind: "reserved-carried";
      actorId: ActorId;
      slot: number;
      reservationId: string;
    }
  | { kind: "queue"; team: TeamId; turretId: string; index: number }
  | { kind: "flying"; projectileId: string }
  | { kind: "consumed"; reason: string; tick: number };

export interface WorldObject {
  id: string;
  /** R2 cases require a catalog ID; legacy R1 fixtures may omit it. */
  weaponId?: string;
  sourceTeam: TeamId;
  weight: number;
  location: ObjectLocation;
  originGroupId?: string;
  parentObjectId?: string;
}

export interface ProjectileState {
  id: string;
  objectId: string;
  team: TeamId;
  sourceActorId: ActorId;
  sourceGeneration: number;
  targetTeam: TeamId;
  targetPartId?: PartId;
}

export interface PlazaState {
  /** R1 only records the state needed to make R2 entry checks safe. */
  playerCrossings: Record<string, PlazaCrossingState>;
  enemyCrossings: Record<string, PlazaCrossingState>;
  defeatedGuardGenerations: Record<string, number>;
}

export interface PlazaCrossingState {
  actorIds: ActorId[];
  capturedAtTick: number;
  guardGenerations: Record<string, number>;
  allowed: boolean;
}

export interface RejectedInput {
  inputIndex: number;
  reason:
    | "wrong_match"
    | "missing_match"
    | "missing_generation"
    | "stale_generation"
    | "unknown_actor"
    | "dead_actor"
    | "protected_actor"
    | "invulnerable_actor"
    | "paused"
    | "ended"
    | "invalid_transition"
    | "invalid_core_attack"
    | "invalid_object_transition"
    | "unsupported_in_r1";
  detail?: string;
}

export type WorldEvent =
  | { type: "part_damaged"; team: TeamId; partId: PartId; amount: number }
  | { type: "part_destroyed"; team: TeamId; partId: PartId; gateId: GateId }
  | {
      type: "equipment_damaged";
      team: TeamId;
      equipmentId: string;
      equipmentKind: "turret" | "supply_port";
      amount: number;
      remainingHealth: number;
      disabledUntilTick: number | null;
    }
  | {
      type: "equipment_restored";
      team: TeamId;
      equipmentId: string;
      equipmentKind: "turret" | "supply_port";
    }
  | { type: "actor_damaged"; actorId: ActorId; amount: number }
  | {
      type: "actor_died";
      actorId: ActorId;
      generation: number;
      respawnAtTick: number;
    }
  | {
      type: "actor_respawned";
      actorId: ActorId;
      generation: number;
      tick: number;
    }
  | { type: "core_hit_candidate"; attackerId: ActorId; targetTeam: TeamId }
  | { type: "outcome"; outcome: Exclude<Outcome, "ongoing">; tick: number }
  | { type: "object_moved"; objectId: string; location: ObjectLocation }
  | {
      type: "delivery_retargeted";
      reservationId: string;
      objectId: string;
      actorId: ActorId;
      team: TeamId;
      fromTurretId: string | undefined;
      toTurretId: string;
      stagingSlot: 0 | 1;
    }
  | { type: "object_consumed"; objectId: string; reason: string }
  | {
      type: "repair_started";
      actorId: ActorId;
      objectId: string;
      team: TeamId;
      partId: PartId;
      completesAtTick: number;
    }
  | {
      type: "repair_cancelled";
      actorId: ActorId;
      objectId: string;
      team: TeamId;
      partId: PartId;
      reason: "interrupted" | "damaged" | "dead" | "stale_generation" | "invalid_target";
    }
  | {
      type: "repair_completed";
      actorId: ActorId;
      objectId: string;
      team: TeamId;
      partId: PartId;
      amount: number;
      budgetUsed: number;
    }
  | {
      type: "equipment_repair_started";
      actorId: ActorId;
      objectId: string;
      team: TeamId;
      equipmentId: string;
      equipmentKind: "turret" | "supply_port";
      completesAtTick: number;
    }
  | {
      type: "equipment_repair_cancelled";
      actorId: ActorId;
      objectId: string;
      team: TeamId;
      equipmentId: string;
      equipmentKind: "turret" | "supply_port";
      reason: "interrupted" | "damaged" | "dead" | "stale_generation" | "invalid_target";
    }
  | {
      type: "equipment_repair_completed";
      actorId: ActorId;
      objectId: string;
      team: TeamId;
      equipmentId: string;
      equipmentKind: "turret" | "supply_port";
    }
  | { type: "case_spawned"; objectId: string; team: TeamId; portId: string; caseType: string }
  | {
      type: "projectile_split";
      parentProjectileId: string;
      childProjectileIds: string[];
    }
  | { type: "projectile_split_blocked"; parentProjectileId: string }
  | {
      type: "supply_disrupted";
      sourceProjectileId: string;
      team: TeamId;
      disruptedUntilTick: number;
      immuneUntilTick: number;
    }
  | {
      type: "slow_zone_created";
      sourceProjectileId: string;
      sourceTeam: TeamId;
      targetTeam: TeamId;
      center: { x: number; y: number };
      radiusSubunits: number;
      multiplier: number;
      expiresAtTick: number;
    }
  | {
    type: "projectile_launched";
    projectileId: string;
    objectId: string;
    sourceActorId: ActorId;
    sourceGeneration: number;
    team: TeamId;
    turretId: string;
    route: "direct" | "detour";
    targetPart?: PartId;
  }
  | { type: "projectile_intercepted"; firstProjectileId: string; secondProjectileId: string }
  | { type: "projectile_impacted"; projectileId: string; objectId: string; targetTeam: TeamId; targetPart?: PartId };

export interface StepReport {
  processedTick: number | null;
  advanced: boolean;
  acceptedInputKinds: string[];
  rejected: RejectedInput[];
  events: WorldEvent[];
}

export interface WorldState {
  rulesetId: string;
  rules: RulesConfig;
  matchId: string;
  seed: number;
  randomState: number;
  tick: number;
  phase: MatchPhase;
  pauseReasons: PauseReason[];
  visibility: "visible" | "hidden";
  matchLimitTicks: number;
  outcome: Outcome;
  layout: WorldLayout;
  castles: Record<TeamId, CastleState>;
  actors: Record<string, ActorState>;
  objects: Record<string, WorldObject>;
  projectiles: Record<string, ProjectileState>;
  reservations: Record<string, Reservation>;
  plaza: PlazaState;
  lastStep: StepReport;
  eventLog: WorldEvent[];
}

export interface RulesConfig {
  rulesetId: string;
  ticksPerSecond: number;
  matchLimitTicks: number;
  actorHealth: number;
  dashDistanceSubunits: number;
  dashDurationTicks: number;
  dashCooldownTicks: number;
  dashActorDamage: number;
  dashEquipmentDamage: number;
  dashKnockbackSubunits: number;
  equipmentHealth: number;
  equipmentDisabledTicks: number;
  /** Fixed ticks required to complete a manual equipment repair. */
  equipmentRepairWorkTicks: number;
  /** Health assigned by a completed manual equipment repair. */
  equipmentRepairHealth: number;
  playerRespawnTicks: number;
  enemyRespawnTicks: number;
  spawnProtectionTicks: number;
  damageInvulnerabilityTicks: number;
  exteriorPartHealth: number;
  /** Maximum cumulative exterior repair per team in one match. */
  repairBudget: number;
  /** Exterior health restored by one completed repair case. */
  repairPerCase: number;
  /** Fixed ticks required to complete an exterior repair. */
  repairWorkTicks: number;
  maxCarrySlots: number;
}

export interface CreateWorldOptions {
  seed?: number;
  matchId?: string;
  rules?: Partial<RulesConfig>;
  layout?: WorldLayout;
  nowVisible?: boolean;
}

/** Inputs are intentionally plain data so a replay can serialize them. */
export interface PauseInput {
  kind: "pause";
  matchId: string;
}
export interface ResumeInput {
  kind: "resume";
  matchId: string;
}
export interface VisibilityInput {
  kind: "visibility";
  visible: boolean;
  matchId: string;
}
export interface DamagePartInput {
  kind: "damage_part";
  team: TeamId;
  partId?: PartId;
  amount: number;
  /** R1 accepts only a trusted collision/projectile boundary. */
  source: "trusted_collision" | "projectile";
  matchId: string;
}
export interface DamageActorInput {
  kind: "damage_actor";
  actorId: ActorId;
  amount: number;
  generation: number;
  matchId: string;
  /** Only a validated physical hit may select one carried object to drop. */
  dropObjectId?: string;
}
export interface MoveActorInput {
  kind: "move_actor";
  actorId: ActorId;
  toRoomId: string;
  /** The castle side is separate from the room id to prevent mirrored input. */
  castleTeam?: TeamId;
  generation: number;
  matchId: string;
}
export interface CoreAttackInput {
  kind: "core_attack";
  actorId: ActorId;
  targetTeam: TeamId;
  attackType: "dash" | "normal_contact" | "projectile" | "friendly";
  generation: number;
  matchId: string;
  /** Accepted only as a collision envelope; its boolean value is never trusted. */
  collision: "core" | "wall" | "gate" | "none";
  /** Deliberately ignored by validation. */
  hit?: boolean;
}
export interface TrustedCollisionInput {
  kind: "trusted_collision";
  collision: "core" | "wall" | "gate";
  actorId: ActorId;
  targetTeam?: TeamId;
  attackType?: "dash" | "normal_contact";
  generation: number;
  matchId: string;
}
export interface ObjectTransitionInput {
  kind:
    | "pickup_object"
    | "reserve_object"
    | "reserve_delivery"
    | "retarget_delivery"
    | "spawn_supply"
    | "enqueue_object"
    | "fly_object"
    | "consume_object"
    | "drop_object";
  objectId: string;
  actorId?: ActorId;
  generation?: number;
  reservationId?: string;
  turretId?: string;
  /** Handoff slot claimed by a delivery reservation. */
  stagingSlot?: 0 | 1;
  portId?: string;
  weaponId?: string;
  originGroupId?: string;
  weight?: number;
  projectileId?: string;
  team?: TeamId;
  targetTeam?: TeamId;
  targetPartId?: PartId;
  roomId?: string;
  position?: Point;
  reason?: string;
  matchId: string;
}

export type WorldCommand =
  | PauseInput
  | ResumeInput
  | VisibilityInput
  | DamagePartInput
  | DamageActorInput
  | MoveActorInput
  | CoreAttackInput
  | TrustedCollisionInput
  | ObjectTransitionInput;

/** Runtime validation also rejects unknown or incomplete external inputs. */
export type WorldInput = WorldCommand | (Readonly<Record<string, unknown>> & { kind?: string; type?: string });
