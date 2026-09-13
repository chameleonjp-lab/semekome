import type { ActorId, WorldObject, WorldState } from "./types.ts";

/**
 * A location is represented once on the object itself. This validator also
 * checks the denormalized actor cargo lists and projectile references so a
 * drop, reservation, queue, or split cannot leave a second copy behind.
 */
export function objectLocations(world: WorldState): Map<string, string[]> {
  const references = new Map<string, string[]>();
  const add = (objectId: string, reference: string): void => {
    const list = references.get(objectId) ?? [];
    list.push(reference);
    references.set(objectId, list);
  };
  for (const [actorId, actor] of Object.entries(world.actors)) {
    for (const objectId of actor.cargoIds) add(objectId, `actor:${actorId}:cargo`);
  }
  for (const [projectileId, projectile] of Object.entries(world.projectiles)) {
    add(projectile.objectId, `projectile:${projectileId}`);
  }
  return references;
}

export function assertObjectLocationsUnique(world: WorldState): void {
  const references = objectLocations(world);
  const cargoReferences = new Map<string, string[]>();
  for (const [actorId, actor] of Object.entries(world.actors)) {
    const seenCargo = new Set<string>();
    for (const objectId of actor.cargoIds) {
      if (seenCargo.has(objectId)) throw new Error(`actor ${actorId} lists cargo ${objectId} twice`);
      seenCargo.add(objectId);
      const refs = cargoReferences.get(objectId) ?? [];
      refs.push(actorId);
      cargoReferences.set(objectId, refs);
    }
  }
  const projectileReferences = new Map<string, string[]>();
  const queueIndexes = new Map<string, Set<number>>();
  for (const [projectileId, projectile] of Object.entries(world.projectiles)) {
    if (projectile.id !== projectileId) throw new Error(`projectile key ${projectileId} does not match id ${projectile.id}`);
    const refs = projectileReferences.get(projectile.objectId) ?? [];
    refs.push(projectileId);
    projectileReferences.set(projectile.objectId, refs);
    const object = world.objects[projectile.objectId];
    if (!object) throw new Error(`projectile ${projectileId} points to missing object ${projectile.objectId}`);
    if (object.location.kind !== "flying" || object.location.projectileId !== projectileId) {
      throw new Error(`projectile ${projectileId} is not the object's flying location`);
    }
  }
  for (const [objectId, refs] of references) {
    const object = world.objects[objectId];
    if (!object) throw new Error(`object ${objectId} is referenced but not present`);
    // A projectile reference is allowed only for a flying object. A cargo
    // reference is allowed only for a carried/reserved-carried object.
    for (const reference of refs) {
      if (reference.startsWith("projectile:") && object.location.kind !== "flying") {
        throw new Error(`object ${objectId} has a projectile reference without flying location`);
      }
      if (reference.includes(":cargo") && object.location.kind !== "carried" && object.location.kind !== "reserved-carried") {
        throw new Error(`object ${objectId} has a cargo reference without carried location`);
      }
      if (reference.includes(":cargo")) {
        const owner = object.location.kind === "carried" || object.location.kind === "reserved-carried"
          ? object.location.actorId
          : undefined;
        if (owner !== reference.split(":")[1]) throw new Error(`object ${objectId} cargo owner does not match location`);
      }
    }
    if (refs.length > 1) {
      // A flying projectile is intentionally a single location reference; a
      // cargo list and projectile list together would duplicate ownership.
      throw new Error(`object ${objectId} has multiple ownership references: ${refs.join(", ")}`);
    }
  }
  for (const [objectId, object] of Object.entries(world.objects)) {
    const cargoOwners = cargoReferences.get(objectId) ?? [];
    const projectileIds = projectileReferences.get(objectId) ?? [];
    if (object.location.kind === "flying") {
      if (projectileIds.length !== 1 || projectileIds[0] !== object.location.projectileId) {
        throw new Error(`flying object ${objectId} must have exactly one matching projectile`);
      }
      if (cargoOwners.length > 0) throw new Error(`flying object ${objectId} is still listed in actor cargo`);
    } else if (projectileIds.length > 0) {
      throw new Error(`non-flying object ${objectId} has projectile references`);
    }
    if (object.location.kind === "carried" || object.location.kind === "reserved-carried") {
      if (cargoOwners.length !== 1 || cargoOwners[0] !== object.location.actorId) {
        throw new Error(`carried object ${objectId} is not listed by its owner exactly once`);
      }
    } else if (cargoOwners.length > 0) {
      throw new Error(`non-carried object ${objectId} is listed in actor cargo`);
    }
    if (object.location.kind === "reserved-carried") {
      const reservation = world.reservations[object.location.reservationId];
      if (!reservation) throw new Error(`reserved object ${objectId} has missing reservation`);
      if (reservation.ownerActorId !== object.location.actorId || !reservation.objectIds.includes(objectId)) {
        throw new Error(`reservation ${reservation.id} does not own object ${objectId}`);
      }
      const actor = world.actors[object.location.actorId];
      if (!actor || !actor.reservationIds.includes(reservation.id)) {
        throw new Error(`reservation ${reservation.id} is not listed by its owner`);
      }
    }
    if (object.location.kind === "queue") {
      if (!Number.isInteger(object.location.index) || object.location.index < 0) {
        throw new Error(`queued object ${objectId} has invalid queue index`);
      }
      const queueKey = `${object.location.team}:${object.location.turretId}`;
      const indexes = queueIndexes.get(queueKey) ?? new Set<number>();
      if (indexes.has(object.location.index)) throw new Error(`queue ${queueKey} has duplicate index ${object.location.index}`);
      indexes.add(object.location.index);
      queueIndexes.set(queueKey, indexes);
    }
  }
  for (const [queueKey, indexes] of queueIndexes) {
    const ordered = [...indexes].sort((left, right) => left - right);
    if (ordered.some((index, position) => index !== position)) throw new Error(`queue ${queueKey} has a gap in indexes`);
  }
  for (const [reservationId, reservation] of Object.entries(world.reservations)) {
    if (reservation.id !== reservationId) throw new Error(`reservation key ${reservationId} does not match id ${reservation.id}`);
    const owner = world.actors[reservation.ownerActorId];
    if (!owner || !owner.reservationIds.includes(reservationId)) {
      throw new Error(`reservation ${reservationId} is not listed by its owner`);
    }
    const seen = new Set<string>();
    for (const objectId of reservation.objectIds) {
      if (seen.has(objectId)) throw new Error(`reservation ${reservationId} lists object ${objectId} twice`);
      seen.add(objectId);
      const object = world.objects[objectId];
      if (!object || object.location.kind !== "reserved-carried" || object.location.reservationId !== reservationId || object.location.actorId !== owner.id) {
        throw new Error(`reservation ${reservationId} has object ${objectId} without matching reserved location`);
      }
    }
  }
  for (const [actorId, actor] of Object.entries(world.actors)) {
    const seenReservations = new Set<string>();
    for (const reservationId of actor.reservationIds) {
      if (seenReservations.has(reservationId)) throw new Error(`actor ${actorId} lists reservation ${reservationId} twice`);
      seenReservations.add(reservationId);
      const reservation = world.reservations[reservationId];
      if (!reservation || reservation.ownerActorId !== actor.id) throw new Error(`actor ${actorId} has invalid reservation ${reservationId}`);
    }
  }
}

export function objectIdsHeldBy(world: WorldState, actorId: ActorId): string[] {
  return Object.values(world.objects)
    .filter((object) =>
      (object.location.kind === "carried" || object.location.kind === "reserved-carried") && object.location.actorId === actorId,
    )
    .map((object) => object.id)
    .sort();
}

export function createFloorObject(
  world: WorldState,
  object: Omit<WorldObject, "location"> & { roomId: string; position: { x: number; y: number } },
): WorldState {
  const next = structuredClone(world);
  if (next.objects[object.id]) throw new Error(`object ${object.id} already exists`);
  next.objects[object.id] = {
    id: object.id,
    weaponId: object.weaponId,
    sourceTeam: object.sourceTeam,
    weight: object.weight,
    originGroupId: object.originGroupId,
    parentObjectId: object.parentObjectId,
    location: { kind: "floor", team: object.sourceTeam, roomId: object.roomId, position: { ...object.position } },
  };
  return next;
}
