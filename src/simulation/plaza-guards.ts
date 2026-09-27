import type { ActorId, ActorState, TeamId, WorldState } from "../domain/types.ts";

/** Current physical occupants block an opposing crossing, regardless of role.
 * Returning to the actor's own castle never requires defeating allies.
 * This snapshot does not yet represent the full departure-time clearance
 * lifecycle (dispatched guards and retained clearance are separate work).
 */
export function plazaGuardCandidates(world: WorldState, targetTeam: TeamId, actorId: ActorId): ActorState[] {
  if (world.actors[actorId]?.team === targetTeam) return [];
  return Object.values(world.actors)
    .filter(actor => actor.id !== actorId && actor.team === targetTeam && actor.location.area === "plaza")
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function plazaGuardGenerations(world: WorldState, targetTeam: TeamId, actorId: ActorId): Record<string, number> {
  return Object.fromEntries(plazaGuardCandidates(world, targetTeam, actorId)
    .map(actor => [String(actor.id), actor.generation]));
}
