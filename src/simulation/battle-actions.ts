import { COMBAT_RULES } from "../content/weapons.ts";
import type { BattleState, TurretRuntime } from "../domain/battle.ts";
import { PART_IDS } from "../domain/types.ts";
import type { ActorState, Point, TeamId, TurretDefinition, WorldObject } from "../domain/types.ts";

export const ordered = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const near = (a: Point, b: Point): boolean => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= COMBAT_RULES.actionRange ** 2;
export function actorCanAct(battle: BattleState, actor: ActorState): boolean {
  return actor.alive && (actor.protectedUntilTick === null || battle.world.tick >= actor.protectedUntilTick);
}
export function turretDefinition(battle: BattleState, team: TeamId, id: string): TurretDefinition | undefined {
  return (team === "player" ? battle.world.layout.home : battle.world.layout.enemy).turrets.find(t => t.id === id);
}
export function atTurret(actor: ActorState, turret: TurretDefinition): boolean {
  return actor.location.area === "castle" && actor.location.castleTeam === actor.team &&
    actor.location.roomId === turret.roomId && near(actor.position, turret.cell);
}
export function allowedOperator(actor: ActorState, turret: TurretDefinition): boolean {
  return actor.team === "player" ? ["P1", "P2", "P3"].includes(actor.id) : turret.operatorActorId === actor.id && actor.role === "shooter";
}
export function equipmentReady(battle: BattleState, turret: TurretRuntime): boolean {
  return turret.disabledUntilTick === null || battle.world.tick > turret.disabledUntilTick;
}
export function validOperator(battle: BattleState, team: TeamId, id: string): ActorState | undefined {
  const runtime = battle.turrets[team][id];
  const definition = turretDefinition(battle, team, id);
  const actor = runtime?.operator && battle.world.actors[runtime.operator.actorId];
  return actor && definition && actor.team === team && actor.generation === runtime.operator?.generation &&
    actorCanAct(battle, actor) && allowedOperator(actor, definition) && atTurret(actor, definition) ? actor : undefined;
}
export function queueFor(battle: BattleState, team: TeamId, turretId: string): WorldObject[] {
  return Object.values(battle.world.objects).filter(o => o.location.kind === "queue" && o.location.team === team && o.location.turretId === turretId)
    .sort((a, b) => (a.location.kind === "queue" ? a.location.index : 0) - (b.location.kind === "queue" ? b.location.index : 0) || ordered(a.id, b.id));
}
export function releaseOperator(battle: BattleState, actorId: string): void {
  for (const team of ["player", "enemy"] as const) {
    for (const turret of Object.values(battle.turrets[team])) if (turret.operator?.actorId === actorId) turret.operator = null;
  }
  const actor = battle.world.actors[actorId];
  if (actor) actor.turretControlIds = [];
}
export function refreshOperators(battle: BattleState): void {
  for (const team of ["player", "enemy"] as const) {
    for (const [id, turret] of Object.entries(battle.turrets[team])) {
      if (turret.operator && !validOperator(battle, team, id)) releaseOperator(battle, turret.operator.actorId);
    }
  }
}

/** Shared by player commands and AI. No command accepts damage, hits, or positions. */
export function executeActorCommand(battle: BattleState, command: Record<string, unknown>): string | null {
  if (command.matchId !== battle.world.matchId) return "wrong_match";
  if (typeof command.actorId !== "string" || !Object.hasOwn(battle.world.actors, command.actorId)) return "unknown_actor";
  const actor = battle.world.actors[command.actorId];
  if (command.generation !== actor.generation) return "stale_generation";
  if (!actorCanAct(battle, actor)) return actor.alive ? "protected_actor" : "dead_actor";
  if (command.kind === "release") { releaseOperator(battle, actor.id); return null; }
  const object = typeof command.objectId === "string" && Object.hasOwn(battle.world.objects, command.objectId) ? battle.world.objects[command.objectId] : undefined;
  if (command.kind === "pickup") {
    if (!object || !object.weaponId || !Object.hasOwn(battle.catalog, object.weaponId) || object.location.kind !== "floor") return "not_floor_case";
    const location = object.location;
    if (actor.location.area !== "castle" || actor.location.castleTeam !== location.team || actor.location.roomId !== location.roomId || !near(actor.position, location.position)) return "out_of_range";
    const weight = actor.cargoIds.reduce((sum, id) => sum + battle.world.objects[id].weight, 0);
    if (actor.cargoIds.length >= battle.world.rules.maxCarrySlots || weight + object.weight > COMBAT_RULES.carryWeight) return "carry_limit";
    const slots = new Set(actor.cargoIds.map(id => {
      const loc = battle.world.objects[id].location;
      return loc.kind === "carried" || loc.kind === "reserved-carried" ? loc.slot : -1;
    }));
    let slot = 0;
    while (slots.has(slot)) slot++;
    object.location = { kind: "carried", actorId: actor.id, slot };
    actor.cargoIds.push(object.id);
    return null;
  }
  const definition = typeof command.turretId === "string" ? turretDefinition(battle, actor.team, command.turretId) : undefined;
  if (!definition) return "unknown_turret";
  if (!atTurret(actor, definition)) return "out_of_range";
  const turret = battle.turrets[actor.team][definition.id];
  if (command.kind === "aim") {
    if (!allowedOperator(actor, definition)) return "not_operator";
    if (command.route !== "direct" && command.route !== "detour") return "invalid_route";
    if (!PART_IDS.includes(command.partId as never)) return "invalid_part";
    turret.settings = { route: command.route, partId: command.partId as typeof PART_IDS[number] };
    return null;
  }
  if (command.kind === "operate") {
    if (!allowedOperator(actor, definition)) return "not_operator";
    if (!equipmentReady(battle, turret)) return "equipment_disabled";
    if (turret.operator && validOperator(battle, actor.team, definition.id)?.id !== actor.id) return "operator_occupied";
    releaseOperator(battle, actor.id);
    turret.operator = { actorId: actor.id, generation: actor.generation };
    actor.turretControlIds = [definition.id];
    return null;
  }
  if (command.kind === "load") {
    if (!object || !object.weaponId || !Object.hasOwn(battle.catalog, object.weaponId) || object.location.kind !== "carried" || object.location.actorId !== actor.id) return "not_unreserved_cargo";
    const queue = queueFor(battle, actor.team, definition.id);
    if (queue.length >= definition.queueCapacity) return "queue_full";
    object.location = { kind: "queue", team: actor.team, turretId: definition.id, index: queue.length };
    actor.cargoIds = actor.cargoIds.filter(id => id !== object.id);
    battle.queued[object.id] = { ...turret.settings };
    return null;
  }
  return "unsupported_command";
}
