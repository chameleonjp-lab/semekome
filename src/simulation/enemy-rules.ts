import type { BattleState, EnemyIntent } from "../domain/battle.ts";
import type { ActorState } from "../domain/types.ts";
import { actorCanAct, atTurret, executeActorCommand, near, ordered, queueFor, releaseOperator, turretDefinition } from "./battle-actions.ts";

export interface EnemyObservation {
  role: ActorState["role"];
  health: number;
  homeRoomId: string;
  currentRoomId: string;
  inHomeCastle: boolean;
  threats: string[];
  cargo: string[];
  nearbyCases: string[];
  turret?: { id: string; roomId: string; atPosition: boolean; hasCapacity: boolean };
  canAssault: boolean;
  canGuardPlaza: boolean;
}

/** Local same-room knowledge only. No camera, player inputs or hidden supply data. */
export function observeEnemy(battle: BattleState, actor: ActorState): EnemyObservation {
  const local = (other: ActorState): boolean => other.location.area === actor.location.area &&
    other.location.castleTeam === actor.location.castleTeam && other.location.roomId === actor.location.roomId;
  const threats = Object.values(battle.world.actors).filter(other => other.team !== actor.team && other.alive && local(other))
    .sort((a, b) => (a.position.x - actor.position.x) ** 2 + (a.position.y - actor.position.y) ** 2 -
      (b.position.x - actor.position.x) ** 2 - (b.position.y - actor.position.y) ** 2 || ordered(a.id, b.id)).map(other => other.id);
  const turret = actor.turretId ? turretDefinition(battle, actor.team, actor.turretId) : undefined;
  return {
    role: actor.role, health: actor.health, homeRoomId: actor.homeRoomId, currentRoomId: actor.currentRoomId,
    inHomeCastle: actor.location.area === "castle" && actor.location.castleTeam === actor.team,
    threats,
    cargo: actor.cargoIds.filter(id => {
      const location = battle.world.objects[id].location.kind;
      return location === "carried" || location === "reserved-carried";
    }),
    nearbyCases: Object.values(battle.world.objects).filter(o => o.weaponId && Object.hasOwn(battle.catalog, o.weaponId) && o.location.kind === "floor" &&
      actor.location.area === "castle" && o.location.team === actor.location.castleTeam && o.location.roomId === actor.location.roomId && near(actor.position, o.location.position))
      .map(o => o.id).sort(ordered),
    turret: turret ? { id: turret.id, roomId: turret.roomId, atPosition: atTurret(actor, turret), hasCapacity: queueFor(battle, actor.team, turret.id).length < turret.queueCapacity } : undefined,
    canAssault: actor.canAssaultOtherVehicle === true, canGuardPlaza: actor.canGuardPlaza === true,
  };
}

/** Ordered role rules choose intentions; collision/movement execution is R2b. */
export function chooseEnemyIntent(observation: EnemyObservation): EnemyIntent {
  const o = observation;
  const threat = o.threats[0];
  if (threat && o.health <= 2) return { kind: "retreat", awayFromId: threat };
  switch (o.role) {
    case "shooter":
      if (!o.inHomeCastle || o.currentRoomId !== o.homeRoomId) return { kind: "move_goal", roomId: o.homeRoomId, purpose: "return" };
      if (threat) return { kind: "defend", targetId: threat };
      if (!o.turret) return { kind: "wait", reason: "no_assigned_turret" };
      if (!o.turret.atPosition) return { kind: "move_goal", roomId: o.turret.roomId, purpose: "operate" };
      if (o.cargo[0] && o.turret.hasCapacity) return { kind: "load", objectId: o.cargo[0], turretId: o.turret.id };
      if (o.nearbyCases[0] && o.cargo.length < 2 && o.turret.hasCapacity) return { kind: "pickup", objectId: o.nearbyCases[0] };
      return { kind: "operate", turretId: o.turret.id };
    case "shooter_guard":
      if (!o.inHomeCastle || o.currentRoomId !== o.homeRoomId) return { kind: "move_goal", roomId: o.homeRoomId, purpose: "return" };
      return threat ? { kind: "defend", targetId: threat } : { kind: "wait", reason: "guard_assigned_room" };
    case "ammo_carrier":
      if (threat) return { kind: "retreat", awayFromId: threat };
      if (o.cargo[0]) return { kind: "wait", reason: "delivery_reservation_required" };
      if (o.nearbyCases[0]) return { kind: "pickup", objectId: o.nearbyCases[0] };
      return { kind: "move_goal", roomId: o.homeRoomId, purpose: "return" };
    case "internal_soldier":
      if (threat) return { kind: "defend", targetId: threat };
      if (o.canGuardPlaza) return { kind: "move_goal", roomId: "central_corridor", purpose: "plaza" };
      if (o.canAssault) return { kind: "move_goal", roomId: "central_corridor", purpose: "assault" };
      return { kind: "move_goal", roomId: o.homeRoomId, purpose: "patrol" };
    default: return { kind: "wait", reason: "not_enemy_role" };
  }
}

export function updateEnemyDecisions(battle: BattleState): void {
  for (const actor of Object.values(battle.world.actors).filter(a => a.team === "enemy").sort((a, b) => ordered(a.id, b.id))) {
    if (!actorCanAct(battle, actor)) { delete battle.enemyDecisions[actor.id]; continue; }
    const previous = battle.enemyDecisions[actor.id];
    if (previous?.generation === actor.generation && battle.world.tick < previous.nextDecisionTick) continue;
    const intent = chooseEnemyIntent(observeEnemy(battle, actor));
    battle.enemyDecisions[actor.id] = { generation: actor.generation, nextDecisionTick: battle.world.tick + battle.enemyDecisionInterval, intent };
    if (["defend", "retreat", "move_goal"].includes(intent.kind)) releaseOperator(battle, actor.id);
    if (["pickup", "load", "operate"].includes(intent.kind)) {
      executeActorCommand(battle, { ...intent, actorId: actor.id, generation: actor.generation, matchId: battle.world.matchId });
    }
    // Goals are retained for the R2b path/dash executor, never teleported or
    // converted directly into damage. Reservation/delivery execution is R3.
  }
}
