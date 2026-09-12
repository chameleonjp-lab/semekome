import { cloneWorld } from "../../src/simulation/world.ts";
import type { PartId, TeamId, WorldState } from "../../src/domain/types.ts";

export function placeActorInCore(world: WorldState, actorId: string, targetTeam: TeamId): WorldState {
  const next = cloneWorld(world);
  const actor = next.actors[actorId];
  if (!actor) throw new Error(`unknown actor ${actorId}`);
  const layout = targetTeam === "player" ? next.layout.home : next.layout.enemy;
  const room = layout.rooms.find((candidate) => candidate.id === "core");
  if (!room) throw new Error("core room missing");
  actor.location = {
    area: "castle",
    castleTeam: targetTeam,
    roomId: "core",
    pathRooms: [...layout.coreRouteRooms],
    pathGates: [...layout.coreRouteGates],
  };
  actor.currentRoomId = "core";
  actor.position = {
    x: Math.floor((room.rect.x0 + room.rect.x1 - 1) / 2),
    y: Math.floor((room.rect.y0 + room.rect.y1 - 1) / 2),
  };
  return next;
}

export function openAllGates(world: WorldState, team: TeamId): WorldState {
  const next = cloneWorld(world);
  const castle = next.castles[team];
  const destroyed: PartId[] = ["P1", "P2", "P3", "P4", "P5", "P6", "P7"];
  for (const partId of destroyed) {
    castle.exterior[partId].health = 0;
    castle.exterior[partId].destroyed = true;
  }
  castle.destroyedPartIds = [...destroyed];
  castle.openGateIds = ["G1", "G2", "G3", "G4", "G5", "G6", "G7"];
  for (const gateId of castle.openGateIds) castle.gates[gateId].open = true;
  return next;
}
