import type { BattleState } from "../domain/battle.ts";
import type { ObjectTransitionInput, TeamId, WorldInput } from "../domain/types.ts";
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
