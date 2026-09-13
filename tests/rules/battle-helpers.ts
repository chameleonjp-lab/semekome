import type { BattleState, RouteId } from "../../src/domain/battle.ts";
import type { PartId, TeamId } from "../../src/domain/types.ts";
import { createFloorObject } from "../../src/domain/objects.ts";
import { executeActorCommand, turretDefinition } from "../../src/simulation/battle-actions.ts";

// Trusted fixture placement, not game input or evidence of continuous movement.
export function atTurret(b: BattleState, actorId: string, turretId = "T1"): void {
  const actor = b.world.actors[actorId];
  const turret = turretDefinition(b, actor.team, turretId)!;
  actor.currentRoomId = turret.roomId;
  actor.location = { area: "castle", castleTeam: actor.team, roomId: turret.roomId, pathRooms: [turret.roomId], pathGates: [] };
  actor.position = { ...turret.cell };
}
export function caseAtActor(b: BattleState, id: string, weaponId: string, actorId = "P1"): void {
  const actor = b.world.actors[actorId];
  b.world = createFloorObject(b.world, { id, weaponId, weight: b.catalog[weaponId].weight, sourceTeam: actor.team, roomId: actor.currentRoomId, position: actor.position, originGroupId: id });
}
export function command(b: BattleState, kind: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const actorId = String(fields.actorId ?? "P1");
  return { kind, matchId: b.world.matchId, actorId, generation: b.world.actors[actorId]?.generation, ...fields };
}
export function readyShot(b: BattleState, id: string, actorId = "P1", turretId = "T1", weaponId = "standard_slug"): void {
  atTurret(b, actorId, turretId);
  caseAtActor(b, id, weaponId, actorId);
  for (const kind of ["pickup", "load", "operate"]) {
    const error = executeActorCommand(b, command(b, kind, { actorId, objectId: id, turretId }));
    if (error) throw new Error(error);
  }
}
export function flight(b: BattleState, id: string, weaponId: string, team: TeamId, progress = 3590, route: RouteId = "direct", partId: PartId = "P1"): void {
  const weapon = b.catalog[weaponId];
  b.world.objects[id] = { id, weaponId, weight: weapon.weight, sourceTeam: team, originGroupId: id, location: { kind: "flying", projectileId: id } };
  b.world.projectiles[id] = { id, objectId: id, team, sourceActorId: team === "player" ? "P1" : "E01", sourceGeneration: 0, targetTeam: team === "player" ? "enemy" : "player", targetPartId: partId };
  b.flights[id] = { id, route, partId, bornTick: -1, progress, speed: weapon.speed, durability: weapon.durability, damage: weapon.damage, effects: structuredClone(weapon.effects), splitAttempted: false };
}
