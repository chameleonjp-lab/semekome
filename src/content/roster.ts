import rawRoster from "../../docs/plans/current/ENEMY_ROSTER.json" with { type: "json" };
import { PLAYER_RESPAWN_PAD_IDS } from "./layouts.ts";
import type { ActorRole, EnemyActorId, PlayerActorId, Point, TeamId } from "../domain/types.ts";

export interface ActorDefinition {
  id: string;
  team: TeamId;
  role: ActorRole;
  homeRoomId: string;
  initialRoomId: string;
  respawnRoomId: string;
  respawnPadId: string;
  initialPosition?: Point;
  turretId?: string;
  guardedActorId?: EnemyActorId;
  canAssaultOtherVehicle?: boolean;
  canGuardPlaza?: boolean;
}

interface RawRosterMember {
  id: string;
  role: string;
  home_room_id: string;
  initial_room_id: string;
  respawn_room_id: string;
  respawn_pad_id: string;
  turret_id?: string;
  guarded_npc_id?: string;
  can_assault_other_vehicle?: boolean;
  can_guard_plaza?: boolean;
}

interface RawRoster {
  enemy_npc_slots?: number;
  members?: RawRosterMember[];
}

const raw = rawRoster as RawRoster;
const roles = new Set<ActorRole>([
  "player",
  "support",
  "shooter",
  "shooter_guard",
  "ammo_carrier",
  "internal_soldier",
]);

function actorRole(rawRole: string): ActorRole {
  if (!roles.has(rawRole as ActorRole) || rawRole === "player" || rawRole === "support") {
    throw new Error(`unsupported enemy role in ENEMY_ROSTER.json: ${rawRole}`);
  }
  return rawRole as ActorRole;
}

export const ENEMY_ROSTER: readonly ActorDefinition[] = (raw.members ?? []).map((member) => ({
  id: member.id as EnemyActorId,
  team: "enemy",
  role: actorRole(member.role),
  homeRoomId: member.home_room_id,
  initialRoomId: member.initial_room_id,
  respawnRoomId: member.respawn_room_id,
  respawnPadId: member.respawn_pad_id,
  turretId: member.turret_id,
  guardedActorId: member.guarded_npc_id as EnemyActorId | undefined,
  canAssaultOtherVehicle: member.can_assault_other_vehicle,
  canGuardPlaza: member.can_guard_plaza,
}));

if (ENEMY_ROSTER.length !== 30 || ENEMY_ROSTER.some((entry, index) => entry.id !== `E${String(index + 1).padStart(2, "0")}`)) {
  throw new Error("ENEMY_ROSTER.json must contain fixed enemy IDs E01 through E30");
}

export const PLAYER_ROSTER: readonly ActorDefinition[] = [
  {
    id: "P1" as PlayerActorId,
    team: "player",
    role: "player",
    homeRoomId: "central_corridor",
    initialRoomId: "central_corridor",
    respawnRoomId: "respawn",
    respawnPadId: PLAYER_RESPAWN_PAD_IDS.P1,
    initialPosition: { x: 92, y: 33 },
  },
  {
    id: "P2" as PlayerActorId,
    team: "player",
    role: "support",
    homeRoomId: "central_corridor",
    initialRoomId: "central_corridor",
    respawnRoomId: "respawn",
    respawnPadId: PLAYER_RESPAWN_PAD_IDS.P2,
    initialPosition: { x: 94, y: 34 },
  },
  {
    id: "P3" as PlayerActorId,
    team: "player",
    role: "support",
    homeRoomId: "central_corridor",
    initialRoomId: "central_corridor",
    respawnRoomId: "respawn",
    respawnPadId: PLAYER_RESPAWN_PAD_IDS.P3,
    initialPosition: { x: 96, y: 35 },
  },
];

export function actorDefinitions(): readonly ActorDefinition[] {
  return [...PLAYER_ROSTER, ...ENEMY_ROSTER];
}
