import type { ActorId, ActorState, PlazaGuardDeployment, TeamId, WorldState } from "../domain/types.ts";

function isOwnCastleOrPlaza(actor: ActorState, team: TeamId): boolean {
  return (actor.location.area === "castle" && actor.location.castleTeam === team) ||
    actor.location.area === "plaza";
}

/**
 * Start or extend the generation-bound deployment for one side's plaza
 * guards. The first dispatch captures every currently living guard already on
 * its own side or in the plaza. Respawn alone does not redeploy a guard; a
 * later generation joins only when an explicit dispatch calls this function.
 */
export function registerPlazaGuardDispatch(
  world: WorldState,
  team: TeamId,
  actorId: ActorId,
): PlazaGuardDeployment | undefined {
  const actor = world.actors[actorId];
  if (!actor || actor.team !== team || actor.canGuardPlaza !== true || !actor.alive) {
    return world.plaza.guardDeployments[team] ?? undefined;
  }

  const current = world.plaza.guardDeployments[team];
  const guardGenerations: Record<string, number> = current
    ? { ...current.guardGenerations }
    : {};
  if (!current) {
    for (const candidate of Object.values(world.actors)
      .filter((candidate) => candidate.team === team && candidate.canGuardPlaza === true &&
        candidate.alive && isOwnCastleOrPlaza(candidate, team))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
      guardGenerations[String(candidate.id)] = candidate.generation;
    }
  } else {
    // Only the actor that actually starts a new dispatch may replace its old
    // generation.  Other guards keep their earlier defeat/dispatch state.
    guardGenerations[String(actor.id)] = actor.generation;
  }

  const deployment: PlazaGuardDeployment = {
    dispatchedAtTick: current?.dispatchedAtTick ?? world.tick,
    guardGenerations,
  };
  world.plaza.guardDeployments[team] = deployment;
  return deployment;
}

/** Current occupants and generation-bound dispatched guards block an opposing crossing.
 * Returning to the actor's own castle never requires defeating allies.
 */
export function plazaGuardCandidates(world: WorldState, targetTeam: TeamId, actorId: ActorId): ActorState[] {
  if (world.actors[actorId]?.team === targetTeam) return [];
  const candidates = new Map<string, ActorState>();
  const deployment = world.plaza.guardDeployments[targetTeam];
  for (const [guardId, generation] of Object.entries(deployment?.guardGenerations ?? {})) {
    const actor = world.actors[guardId];
    // A respawned generation is not part of the old deployment until it is
    // dispatched again.  Existing crossing records still become stale from
    // the generation mismatch checked by the common world.
    if (actor && actor.id !== actorId && actor.team === targetTeam &&
        actor.canGuardPlaza === true && actor.generation === generation) {
      candidates.set(String(actor.id), actor);
    }
  }
  for (const actor of Object.values(world.actors)) {
    if (actor.id !== actorId && actor.team === targetTeam && actor.location.area === "plaza") {
      candidates.set(String(actor.id), actor);
    }
  }
  return [...candidates.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function plazaGuardGenerations(world: WorldState, targetTeam: TeamId, actorId: ActorId): Record<string, number> {
  return Object.fromEntries(plazaGuardCandidates(world, targetTeam, actorId)
    .map(actor => [String(actor.id), actor.generation]));
}
