import type { WeaponDefinition, WeaponEffect } from "../content/weapons.ts";
import type { CaseType } from "../content/cases.ts";
import type { SupplySchedule } from "../logistics/supply-schedule.ts";
import type { ActorId, PartId, Point, TeamId, WorldState } from "./types.ts";

export type RouteId = "direct" | "detour";
export interface ShotSettings { route: RouteId; partId: PartId }
export interface Operator { actorId: ActorId; generation: number }
export interface TurretRuntime {
  settings: ShotSettings;
  operator: Operator | null;
  /** Equipment completes restoration at this tick; no shot on that tick. */
  disabledUntilTick: number | null;
}
export interface Flight extends ShotSettings {
  id: string;
  bornTick: number;
  /** Integer numerator: route units * ticksPerSecond, not floor coordinates. */
  progress: number;
  speed: number;
  durability: number;
  damage: number;
  effects: WeaponEffect[];
  splitAttempted: boolean;
}
export interface SupplyStop {
  disruptedUntil: number;
  immuneUntil: number;
  equipmentDisabledUntil: number | null;
}
export interface SlowZone {
  sourceTeam: TeamId;
  targetTeam: TeamId;
  expiresAt: number;
  radius: number;
  multiplier: number;
}
export type EnemyIntent =
  | { kind: "wait"; reason: string }
  | { kind: "move_goal"; roomId: string; purpose: "operate" | "return" | "deliver" | "patrol" | "assault" | "plaza" }
  | { kind: "defend"; targetId: ActorId }
  | { kind: "retreat"; awayFromId: ActorId }
  | { kind: "pickup"; objectId: string }
  | { kind: "load"; objectId: string; turretId: string }
  | { kind: "operate"; turretId: string };
export interface EnemyDecision {
  generation: number;
  nextDecisionTick: number;
  intent: EnemyIntent;
}

/** Runtime state for the common-world supply producer. */
export interface CommonSupplyPort {
  id: string;
  team: TeamId;
  roomId: string;
  nextSpawnTick: number;
  /** Monotonic source-local sequence used to keep object IDs unique. */
  groupSequence: number;
}

export interface CommonSupplyState {
  ports: Record<string, CommonSupplyPort>;
  schedules: Record<TeamId, SupplySchedule>;
  /** The allocation is retained in the schedule type for explicit validation. */
  allocation: readonly CaseType[];
}

export interface BattleState {
  world: WorldState;
  catalog: Record<string, WeaponDefinition>;
  turrets: Record<TeamId, Record<string, TurretRuntime>>;
  queued: Record<string, ShotSettings>;
  flights: Record<string, Flight>;
  nextLaunchTick: Record<TeamId, number>;
  nextTurretIndex: Record<TeamId, number>;
  supplyStops: Record<TeamId, SupplyStop>;
  /** Common-world floor generation. Physical battle owns a separate producer. */
  supply: CommonSupplyState;
  slowZones: Partial<Record<TeamId, SlowZone>>;
  enemyDecisions: Record<string, EnemyDecision>;
  enemyDecisionInterval: number;
  /** Active pairs only; removed when either projectile ends. */
  interceptedPairs: string[];
  nextId: number;
  lastCombatStep: { rejected: Array<{ index: number; reason: string }>; events: CombatEvent[] };
}
export type CombatEvent =
  | { kind: "launch"; tick: number; team: TeamId; turretId: string; projectileId: string }
  | { kind: "intercept"; tick: number; a: string; b: string }
  | { kind: "impact"; tick: number; projectileId: string; partId: PartId | null; damage: number }
  | { kind: "split"; tick: number; parentId: string; childIds: string[] }
  | { kind: "split_blocked"; tick: number; parentId: string };

type ActorCommand = { matchId: string; actorId: ActorId; generation: number };
export type BattleCommand =
  | ({ kind: "pickup"; objectId: string } & ActorCommand)
  | ({ kind: "load"; objectId: string; turretId: string } & ActorCommand)
  | ({ kind: "operate"; turretId: string } & ActorCommand)
  | ({ kind: "release" } & ActorCommand)
  | ({ kind: "aim"; turretId: string } & ShotSettings & ActorCommand)
  | { kind: "pause" | "resume"; matchId: string }
  | { kind: "visibility"; matchId: string; visible: boolean };

/** Explicit location; a zone affects either team only inside its target castle. */
export interface FloorSample { castleTeam: TeamId; roomId: string; position: Point }
