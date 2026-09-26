import type { BattleState } from "../domain/battle.ts";
import { canTraverse } from "../domain/layout.ts";
import type { MoveActorInput, ObjectTransitionInput, TeamId, WorldInput } from "../domain/types.ts";
import { ordered } from "./battle-actions.ts";

/**
 * A common-world delivery plan stops at the pre-departure reservation.
 * Movement to the turret and the final handoff are separate responsibilities.
 */
export interface CommonDeliveryPlan {
  actorId: string;
  objectId: string;
  turretId: string;
  stagingSlot: 0 | 1;
  reservationId: string;
  inputs: readonly [ObjectTransitionInput, ObjectTransitionInput];
}

export interface CommonDeliveryRetargetPlan {
  actorId: string;
  objectId: string;
  turretId: string;
  stagingSlot: 0 | 1;
  reservationId: string;
  input: ObjectTransitionInput;
}

const DELIVERY_TEAMS = ["enemy"] as const satisfies readonly TeamId[];

function reservationKey(team: TeamId, turretId: string, slot: 0 | 1): string {
  return `${team}:${turretId}:${slot}`;
}

function deliveryReservationId(battle: BattleState, actorId: string, objectId: string): string {
  return `common-delivery:${battle.world.matchId}:${actorId}:${objectId}`;
}

function preferredTurretIds(battle: BattleState, team: TeamId, roomId: string): string[] {
  const layout = team === "player" ? battle.world.layout.home : battle.world.layout.enemy;
  const portIndex = layout.supplyPorts.findIndex((port) => port.roomId === roomId);
  const preferred = portIndex >= 0 ? layout.turrets[portIndex]?.id : undefined;
  return layout.turrets
    .map((turret) => turret.id)
    .sort((left, right) => (left === preferred ? -1 : right === preferred ? 1 : 0) || ordered(left, right));
}

function reservedStagingSlots(battle: BattleState): Set<string> {
  return new Set(Object.values(battle.world.reservations)
    .filter((reservation) => reservation.kind === "delivery" && reservation.targetTurretId && reservation.targetStagingSlot !== undefined)
    .map((reservation) => {
      const owner = battle.world.actors[reservation.ownerActorId];
      return owner ? reservationKey(owner.team, reservation.targetTurretId!, reservation.targetStagingSlot!) : undefined;
    })
    .filter((key): key is string => key !== undefined));
}

function readyTurretSlots(battle: BattleState, team: TeamId, roomId: string, occupied: ReadonlySet<string>): Array<{ turretId: string; stagingSlot: 0 | 1 }> {
  const layout = team === "player" ? battle.world.layout.home : battle.world.layout.enemy;
  const slots: Array<{ turretId: string; stagingSlot: 0 | 1 }> = [];
  for (const turretId of preferredTurretIds(battle, team, roomId)) {
    const turret = layout.turrets.find((candidate) => candidate.id === turretId);
    const runtime = battle.turrets[team][turretId];
    if (!turret || !runtime || runtime.disabledUntilTick !== null && battle.world.tick <= runtime.disabledUntilTick) continue;
    const count = Math.min(turret.stagingFloorSlots, 2);
    for (let slot = 0; slot < count; slot += 1) {
      const stagingSlot = slot as 0 | 1;
      if (!occupied.has(reservationKey(team, turret.id, stagingSlot))) slots.push({ turretId: turret.id, stagingSlot });
    }
  }
  return slots;
}

/**
 * Choose one same-room floor case for each free common ammo carrier. The
 * planner does not move an actor or advance the clock; it only prepares the
 * validated pickup + delivery-reservation pair for the next world step.
 */
export function prepareCommonDeliveryPlans(battle: BattleState): CommonDeliveryPlan[] {
  const plans: CommonDeliveryPlan[] = [];
  const occupied = reservedStagingSlots(battle);
  const usedActors = new Set<string>();
  const usedObjects = new Set<string>();

  for (const team of DELIVERY_TEAMS) {
    const carriers = Object.values(battle.world.actors)
      .filter((actor) => actor.team === team && actor.role === "ammo_carrier" && actor.alive &&
        actor.location.area === "castle" && actor.location.castleTeam === team && actor.cargoIds.length === 0)
      .sort((left, right) => ordered(left.id, right.id));
    for (const actor of carriers) {
      if (usedActors.has(actor.id)) continue;
      const object = Object.values(battle.world.objects)
        .filter((candidate) => candidate.location.kind === "floor" && candidate.sourceTeam === team && candidate.weaponId &&
          Object.hasOwn(battle.catalog, candidate.weaponId) && candidate.location.roomId === actor.currentRoomId && !usedObjects.has(candidate.id))
        .sort((left, right) => ordered(left.id, right.id))[0];
      if (!object || object.location.kind !== "floor") continue;
      const target = readyTurretSlots(battle, team, object.location.roomId, occupied)[0];
      if (!target) continue;
      const reservationId = deliveryReservationId(battle, actor.id, object.id);
      plans.push({
        actorId: actor.id,
        objectId: object.id,
        turretId: target.turretId,
        stagingSlot: target.stagingSlot,
        reservationId,
        inputs: [
          {
            kind: "pickup_object",
            objectId: object.id,
            actorId: actor.id,
            generation: actor.generation,
            matchId: battle.world.matchId,
          },
          {
            kind: "reserve_delivery",
            objectId: object.id,
            actorId: actor.id,
            generation: actor.generation,
            team,
            turretId: target.turretId,
            stagingSlot: target.stagingSlot,
            reservationId,
            matchId: battle.world.matchId,
          },
        ],
      });
      occupied.add(reservationKey(team, target.turretId, target.stagingSlot));
      usedActors.add(actor.id);
      usedObjects.add(object.id);
    }
  }
  return plans;
}

export function commonDeliveryInputs(plans: readonly CommonDeliveryPlan[]): WorldInput[] {
  return plans.flatMap((plan) => plan.inputs);
}

function deliveryTurretReady(battle: BattleState, team: TeamId, turretId: string): boolean {
  const runtime = battle.turrets[team][turretId];
  return runtime !== undefined && (runtime.disabledUntilTick === null || battle.world.tick > runtime.disabledUntilTick);
}

/**
 * Reassign an existing common delivery reservation when its target cannot
 * accept the reserved handoff anymore. Reservations with no available
 * destination remain intact; the carrier keeps its case and will be checked
 * again on the next step.
 */
export function prepareCommonDeliveryRetargets(
  battle: BattleState,
  plannedDeliveries: readonly CommonDeliveryPlan[] = [],
): CommonDeliveryRetargetPlan[] {
  const reservations = Object.values(battle.world.reservations)
    .filter((reservation) => reservation.kind === "delivery")
    .sort((left, right) => ordered(left.ownerActorId, right.ownerActorId) || ordered(left.id, right.id));
  const candidates = reservations.flatMap((reservation) => {
    const actor = battle.world.actors[reservation.ownerActorId];
    const objectId = reservation.objectIds.length === 1 ? reservation.objectIds[0] : undefined;
    const object = objectId ? battle.world.objects[objectId] : undefined;
    if (!actor || actor.role !== "ammo_carrier" || !actor.alive || actor.location.area !== "castle" ||
        actor.location.castleTeam !== actor.team || !object || object.sourceTeam !== actor.team ||
        object.location.kind !== "reserved-carried" || object.location.actorId !== actor.id ||
        object.location.reservationId !== reservation.id || !actor.cargoIds.includes(object.id) ||
        !actor.reservationIds.includes(reservation.id)) return [];

    const layout = actor.team === "player" ? battle.world.layout.home : battle.world.layout.enemy;
    const turretId = reservation.targetTurretId;
    const turret = turretId ? layout.turrets.find((candidate) => candidate.id === turretId) : undefined;
    const stagingSlot = reservation.targetStagingSlot;
    const slotIsAuthored = turret !== undefined && (stagingSlot === 0 || stagingSlot === 1) && stagingSlot < turret.stagingFloorSlots;
    const slotIsCompeted = turret !== undefined && slotIsAuthored && reservations.some((other) =>
      other.id !== reservation.id && other.kind === "delivery" && other.targetTurretId === turret.id &&
        battle.world.actors[other.ownerActorId]?.team === actor.team && other.targetStagingSlot === stagingSlot,
    );
    if (turret && slotIsAuthored && !slotIsCompeted && deliveryTurretReady(battle, actor.team, turret.id)) return [];
    return [{ reservation, actor, object }];
  });

  const occupied = reservedStagingSlots(battle);
  for (const { reservation } of candidates) {
    if (reservation.targetTurretId && reservation.targetStagingSlot !== undefined) {
      const actor = battle.world.actors[reservation.ownerActorId];
      if (actor) occupied.delete(reservationKey(actor.team, reservation.targetTurretId, reservation.targetStagingSlot));
    }
  }
  for (const plan of plannedDeliveries) {
    const actor = battle.world.actors[plan.actorId];
    if (actor) occupied.add(reservationKey(actor.team, plan.turretId, plan.stagingSlot));
  }

  const plans: CommonDeliveryRetargetPlan[] = [];
  for (const { reservation, actor, object } of candidates) {
    const target = readyTurretSlots(battle, actor.team, actor.currentRoomId, occupied)[0];
    if (!target) continue;
    plans.push({
      actorId: actor.id,
      objectId: object.id,
      turretId: target.turretId,
      stagingSlot: target.stagingSlot,
      reservationId: reservation.id,
      input: {
        kind: "retarget_delivery",
        objectId: object.id,
        actorId: actor.id,
        generation: actor.generation,
        team: actor.team,
        turretId: target.turretId,
        stagingSlot: target.stagingSlot,
        reservationId: reservation.id,
        matchId: battle.world.matchId,
      },
    });
    occupied.add(reservationKey(actor.team, target.turretId, target.stagingSlot));
  }
  return plans;
}

export function commonDeliveryRetargetInputs(plans: readonly CommonDeliveryRetargetPlan[]): ObjectTransitionInput[] {
  return plans.map((plan) => plan.input);
}

function plannedRetargetsByReservation(plans: readonly CommonDeliveryRetargetPlan[]): Map<string, string> {
  return new Map(plans.map((plan) => [plan.reservationId, plan.turretId]));
}

function nextDeliveryRoom(battle: BattleState, actor: BattleState["world"]["actors"][string], targetRoomId: string): string | undefined {
  if (actor.location.area !== "castle" || actor.location.castleTeam !== actor.team) return undefined;
  const layout = actor.team === "player" ? battle.world.layout.home : battle.world.layout.enemy;
  if (!layout.rooms.some((room) => room.id === targetRoomId) || actor.currentRoomId === targetRoomId) return undefined;

  const openGates = new Set(battle.world.castles[actor.team].openGateIds);
  const parent = new Map<string, string | null>([[actor.currentRoomId, null]]);
  const queue = [actor.currentRoomId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === targetRoomId) break;
    const neighbors = layout.links
      .filter((link) => link.a === current || link.b === current)
      .map((link) => ({
        roomId: link.a === current ? link.b : link.a,
        gateId: link.gateId,
      }))
      .filter((neighbor) => canTraverse(layout, current, neighbor.roomId, openGates))
      .sort((left, right) => ordered(left.roomId, right.roomId));
    for (const neighbor of neighbors) {
      if (parent.has(neighbor.roomId)) continue;
      parent.set(neighbor.roomId, current);
      queue.push(neighbor.roomId);
    }
  }
  if (!parent.has(targetRoomId)) return undefined;

  const path: string[] = [];
  let cursor: string | null = targetRoomId;
  while (cursor !== null) {
    path.push(cursor);
    cursor = parent.get(cursor) ?? null;
  }
  path.reverse();
  return path[1];
}

/**
 * Advance reserved common carriers by one authored room link per world step.
 * The reservation and cargo ownership are checked again before preparing the
 * move, so a stale, dead, or already delivered carrier is left untouched.
 */
export function commonDeliveryMovementInputs(
  battle: BattleState,
  retargets: readonly CommonDeliveryRetargetPlan[] = [],
): MoveActorInput[] {
  const inputs: MoveActorInput[] = [];
  const usedActors = new Set<string>();
  const retargetedTurrets = plannedRetargetsByReservation(retargets);
  const reservations = Object.values(battle.world.reservations)
    .filter((reservation) => reservation.kind === "delivery")
    .sort((left, right) => ordered(left.ownerActorId, right.ownerActorId) || ordered(left.id, right.id));

  for (const reservation of reservations) {
    const actor = battle.world.actors[reservation.ownerActorId];
    const objectId = reservation.objectIds.length === 1 ? reservation.objectIds[0] : undefined;
    const object = objectId ? battle.world.objects[objectId] : undefined;
    if (!actor || usedActors.has(actor.id) || actor.role !== "ammo_carrier" || !actor.alive ||
        !object || object.location.kind !== "reserved-carried" || object.location.actorId !== actor.id ||
        object.location.reservationId !== reservation.id || !actor.cargoIds.includes(object.id) ||
        !(retargetedTurrets.get(reservation.id) ?? reservation.targetTurretId)) continue;
    const layout = actor.team === "player" ? battle.world.layout.home : battle.world.layout.enemy;
    const turretId = retargetedTurrets.get(reservation.id) ?? reservation.targetTurretId!;
    const turret = layout.turrets.find((candidate) => candidate.id === turretId);
    if (!turret || !deliveryTurretReady(battle, actor.team, turret.id)) continue;
    const nextRoom = nextDeliveryRoom(battle, actor, turret.roomId);
    if (!nextRoom) continue;
    inputs.push({
      kind: "move_actor",
      actorId: actor.id,
      toRoomId: nextRoom,
      castleTeam: actor.team,
      generation: actor.generation,
      matchId: battle.world.matchId,
    });
    usedActors.add(actor.id);
  }
  return inputs.sort((left, right) => ordered(left.actorId, right.actorId));
}

function queueKey(team: TeamId, turretId: string): string {
  return `${team}:${turretId}`;
}

function queuedCounts(battle: BattleState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const object of Object.values(battle.world.objects)) {
    if (object.location.kind !== "queue") continue;
    const key = queueKey(object.location.team, object.location.turretId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Enqueue a reserved case once its carrier is in the target turret room.
 *
 * The common model has no physical handoff-floor location. Arrival at the
 * authored turret room is therefore the common handoff boundary: the case is
 * either accepted into the turret queue, or remains reserved-carried while
 * the carrier waits for capacity or equipment recovery.
 */
export function commonDeliveryHandoffInputs(
  battle: BattleState,
  retargets: readonly CommonDeliveryRetargetPlan[] = [],
): ObjectTransitionInput[] {
  const inputs: ObjectTransitionInput[] = [];
  const counts = queuedCounts(battle);
  const retargetedTurrets = plannedRetargetsByReservation(retargets);
  const reservations = Object.values(battle.world.reservations)
    .filter((reservation) => reservation.kind === "delivery")
    .sort((left, right) => ordered(left.ownerActorId, right.ownerActorId) || ordered(left.id, right.id));

  for (const reservation of reservations) {
    const actor = battle.world.actors[reservation.ownerActorId];
    const objectId = reservation.objectIds.length === 1 ? reservation.objectIds[0] : undefined;
    const object = objectId ? battle.world.objects[objectId] : undefined;
    if (!actor || actor.role !== "ammo_carrier" || !actor.alive || actor.location.area !== "castle" ||
        actor.location.castleTeam !== actor.team || !object || !object.weaponId ||
        !Object.hasOwn(battle.catalog, object.weaponId) || object.location.kind !== "reserved-carried" ||
        object.location.actorId !== actor.id || object.location.reservationId !== reservation.id ||
        !actor.cargoIds.includes(object.id)) continue;

    const layout = actor.team === "player" ? battle.world.layout.home : battle.world.layout.enemy;
    const turretId = retargetedTurrets.get(reservation.id) ?? reservation.targetTurretId;
    const turret = turretId ? layout.turrets.find((candidate) => candidate.id === turretId) : undefined;
    if (!turret || actor.currentRoomId !== turret.roomId) continue;
    const runtime = turret ? battle.turrets[actor.team][turret.id] : undefined;
    if (!turret || !runtime || runtime.disabledUntilTick !== null && battle.world.tick <= runtime.disabledUntilTick) continue;

    const key = queueKey(actor.team, turret.id);
    const count = counts.get(key) ?? 0;
    if (count >= turret.queueCapacity) continue;

    inputs.push({
      kind: "enqueue_object",
      objectId: object.id,
      actorId: actor.id,
      generation: actor.generation,
      team: actor.team,
      turretId: turret.id,
      matchId: battle.world.matchId,
    });
    counts.set(key, count + 1);
  }
  return inputs;
}
