import { canOccupyFixed, hasFloorLineOfSight } from "../actors/geometry.ts";
import { ACTOR_RADIUS_SUBUNITS, FLOOR_SUBUNITS, floorCell } from "../actors/movement.ts";
import { roomContainsPoint, routeHasAllGates } from "../domain/layout.ts";
import type {
  ActorId,
  CoreAttackInput,
  DamageActorInput,
  MoveActorInput,
  PlazaCrossingState,
  TeamId,
  WorldState,
} from "../domain/types.ts";
import type { BattleState, FixedPoint } from "./physical-battle.ts";
import { cloneWorld } from "./world.ts";

/**
 * R2b's first connection boundary.  The physical simulation owns fixed-point
 * movement; the common world owns outcomes.  Only this module may turn a
 * physical first-contact snapshot into the R1 collision envelope.
 */

export type PhysicalFirstContact = "actor" | "wall" | "gate" | "core";

export interface PhysicalFirstContactEvidence {
  matchId: string;
  tick: number;
  actorId: ActorId;
  generation: number;
  targetTeam: TeamId;
  attackType: "dash" | "normal_contact";
  firstContact: PhysicalFirstContact;
  from: FixedPoint;
  to: FixedPoint;
}

export interface PlazaEntryEvidence {
  matchId: string;
  tick: number;
  actorId: ActorId;
  generation: number;
  /** Castle side the actor is trying to enter from the plaza. */
  targetTeam: TeamId;
  /** Generations observed for every authored plaza guard in the snapshot. */
  guardGenerations: Readonly<Record<string, number>>;
}

export interface PhysicalActorContactEvidence {
  matchId: string;
  tick: number;
  /** The actor whose physical dash produced this envelope. */
  actorId: ActorId;
  generation: number;
  targetActorId: ActorId;
  targetGeneration: number;
  attackType: "dash";
  firstContact: "actor";
  /** Fixed-point positions captured after the physical dash stopped. */
  from: FixedPoint;
  to: FixedPoint;
  targetPosition: FixedPoint;
  /** The target's selected carried case, if one was selected at contact. */
  targetCargoId?: string;
}

/**
 * A renderer or physical simulation may submit one of these two evidence
 * envelopes.  The envelope is deliberately separate from `CoreAttackInput`
 * and `MoveActorInput`: those are the common-world commands produced only
 * after this module has checked the physical snapshot.
 */
export type R2bBridgeRequest =
  | { kind: "core_contact"; evidence: PhysicalFirstContactEvidence }
  | { kind: "actor_contact"; evidence: PhysicalActorContactEvidence }
  | { kind: "plaza_entry"; evidence: PlazaEntryEvidence };

export interface PreparedR2bWorldInput {
  kind: R2bBridgeRequest["kind"];
  /** The validated command to consume in the current world tick. */
  input: CoreAttackInput | DamageActorInput | MoveActorInput;
  /**
   * A prepared snapshot is returned for plaza entry because the crossing
   * permission is generation-bound.  Core contact can reuse the caller's
   * snapshot because it has no extra permission state to install.
   */
  state: WorldState;
}

export type R2bBridgeReason =
  | "wrong_match"
  | "stale_snapshot"
  | "unknown_actor"
  | "missing_generation"
  | "stale_generation"
  | "dead_actor"
  | "invalid_target"
  | "invalid_contact"
  | "closed_route"
  | "guards_remaining";

export interface R2bBridgeFailure {
  ok: false;
  reason: R2bBridgeReason;
  detail?: string;
}

export interface R2bBridgeSuccess<T> {
  ok: true;
  value: T;
}

export type R2bBridgeResult<T> = R2bBridgeSuccess<T> | R2bBridgeFailure;

function failure(reason: R2bBridgeReason, detail?: string): R2bBridgeFailure {
  return detail ? { ok: false, reason, detail } : { ok: false, reason };
}

function finitePoint(point: FixedPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function samePoint(left: FixedPoint, right: FixedPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function hasContinuousClearance(state: BattleState, team: TeamId, from: FixedPoint, to: FixedPoint): boolean {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / 50));
  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps;
    const point = {
      x: Math.round(from.x + (to.x - from.x) * progress),
      y: Math.round(from.y + (to.y - from.y) * progress),
    };
    if (!canOccupyFixed(state, team, point)) return false;
  }
  return true;
}

function plazaPointCanOccupy(state: BattleState, point: FixedPoint): boolean {
  if (!finitePoint(point)) return false;
  const rect = state.layout.plaza;
  return point.x - ACTOR_RADIUS_SUBUNITS >= rect.x0 * FLOOR_SUBUNITS &&
    point.x + ACTOR_RADIUS_SUBUNITS <= rect.x1 * FLOOR_SUBUNITS &&
    point.y - ACTOR_RADIUS_SUBUNITS >= rect.y0 * FLOOR_SUBUNITS &&
    point.y + ACTOR_RADIUS_SUBUNITS <= rect.y1 * FLOOR_SUBUNITS;
}

function validTeam(team: unknown): team is TeamId {
  return team === "player" || team === "enemy";
}

function actorAtSnapshot(
  state: WorldState,
  matchId: string,
  actorId: ActorId,
  generation: number,
  tick: number,
): R2bBridgeResult<WorldState["actors"][string]> {
  if (matchId !== state.matchId) return failure("wrong_match", `${matchId} != ${state.matchId}`);
  if (!Number.isInteger(tick) || tick !== state.tick) return failure("stale_snapshot", "physical snapshot tick is not current");
  const actor = state.actors[actorId];
  if (!actor) return failure("unknown_actor", String(actorId));
  if (!Number.isInteger(generation)) return failure("missing_generation", `${actorId} generation is required`);
  if (generation !== actor.generation) return failure("stale_generation", `${generation} != ${actor.generation}`);
  if (!actor.alive) return failure("dead_actor", String(actorId));
  return { ok: true, value: actor };
}

function guardCandidates(world: WorldState, targetTeam: TeamId, actorId: ActorId): WorldState["actors"][string][] {
  return Object.values(world.actors)
    .filter((actor) => actor.id !== actorId && actor.team === targetTeam && actor.canGuardPlaza === true && actor.location.area === "plaza")
    .sort((left, right) => left.id.localeCompare(right.id));
}

function exactGuardSnapshot(
  candidates: readonly WorldState["actors"][string][],
  observed: Readonly<Record<string, number>>,
): R2bBridgeFailure | undefined {
  const expected = new Set(candidates.map((candidate) => String(candidate.id)));
  for (const candidate of candidates) {
    const generation = observed[candidate.id];
    if (!Number.isInteger(generation)) return failure("stale_generation", `${candidate.id} generation is missing`);
    if (generation !== candidate.generation) return failure("stale_generation", `${candidate.id} generation ${generation} != ${candidate.generation}`);
  }
  for (const id of Object.keys(observed)) {
    if (!expected.has(id)) return failure("invalid_contact", `unexpected plaza guard ${id}`);
  }
  return undefined;
}

/**
 * Convert a physical dash that reached the core into a common-world input.
 * The returned input is still consumed by the caller's single world tick; this
 * function never advances a clock or mutates either state.
 */
export function bridgeCoreFirstContact(
  state: BattleState,
  evidence: PhysicalFirstContactEvidence,
): R2bBridgeResult<CoreAttackInput> {
  const actorResult = actorAtSnapshot(state, evidence.matchId, evidence.actorId, evidence.generation, evidence.tick);
  if (!actorResult.ok) return actorResult;
  const actor = actorResult.value;
  if (!validTeam(evidence.targetTeam) || actor.team === evidence.targetTeam) {
    return failure("invalid_target", "core target must be the opposing castle");
  }
  if (evidence.attackType !== "dash" || evidence.firstContact !== "core") {
    return failure("invalid_contact", "only a dash whose first contact is the core can end a match");
  }
  if (!finitePoint(evidence.from) || !finitePoint(evidence.to)) {
    return failure("invalid_contact", "fixed-point contact is not finite");
  }
  const fixed = state.fixedActors[evidence.actorId]?.position;
  if (!fixed || !samePoint(fixed, evidence.from) ||
      actor.position.x !== floorCell(evidence.from.x) || actor.position.y !== floorCell(evidence.from.y)) {
    return failure("stale_snapshot", "physical position no longer matches the actor snapshot");
  }
  const location = actor.location;
  if (location.area !== "castle" || location.castleTeam !== evidence.targetTeam ||
      location.roomId !== "core" || actor.currentRoomId !== "core") {
    return failure("invalid_contact", "actor is not in the target core room");
  }
  const targetLayout = evidence.targetTeam === "player" ? state.layout.home : state.layout.enemy;
  const coreRoom = targetLayout.rooms.find((room) => room.id === "core");
  if (!coreRoom || !roomContainsPoint(coreRoom, { x: floorCell(evidence.to.x), y: floorCell(evidence.to.y) })) {
    return failure("invalid_contact", "contact endpoint is outside the authored core room");
  }
  if (!targetLayout.coreRouteGates.every((gate) => state.castles[evidence.targetTeam].gates[gate].open) ||
      !routeHasAllGates(targetLayout, location.pathRooms) ||
      location.pathGates.length !== targetLayout.coreRouteGates.length ||
      location.pathGates.some((gate, index) => gate !== targetLayout.coreRouteGates[index])) {
    return failure("closed_route", "the physical route does not prove all seven gates");
  }
  if (!hasContinuousClearance(state, evidence.targetTeam, evidence.from, evidence.to) ||
      !hasFloorLineOfSight(state, evidence.targetTeam, evidence.from, evidence.to)) {
    return failure("invalid_contact", "wall, gate, or equipment blocks the first-contact segment");
  }
  return {
    ok: true,
    value: {
      kind: "core_attack",
      matchId: evidence.matchId,
      actorId: evidence.actorId,
      targetTeam: evidence.targetTeam,
      attackType: "dash",
      generation: evidence.generation,
      collision: "core",
    },
  };
}

/**
 * Convert a physical actor-to-actor dash contact into one common-world damage
 * input.  The physical adapter proves the contact geometry; the common world
 * remains the authority for health, invulnerability, cargo, and respawn.
 */
export function bridgeActorFirstContact(
  state: BattleState,
  evidence: PhysicalActorContactEvidence,
): R2bBridgeResult<DamageActorInput> {
  const attackerResult = actorAtSnapshot(state, evidence.matchId, evidence.actorId, evidence.generation, evidence.tick);
  if (!attackerResult.ok) return attackerResult;
  const targetResult = actorAtSnapshot(state, evidence.matchId, evidence.targetActorId, evidence.targetGeneration, evidence.tick);
  if (!targetResult.ok) return targetResult;
  const attacker = attackerResult.value;
  const target = targetResult.value;
  if (attacker.id === target.id || attacker.team === target.team) {
    return failure("invalid_target", "actor contact must target a live opposing actor");
  }
  if (evidence.attackType !== "dash" || evidence.firstContact !== "actor") {
    return failure("invalid_contact", "only a dash whose first contact is an actor may deal actor damage");
  }
  if (!finitePoint(evidence.from) || !finitePoint(evidence.to) || !finitePoint(evidence.targetPosition)) {
    return failure("invalid_contact", "fixed-point actor contact is not finite");
  }
  const attackerFixed = state.fixedActors[evidence.actorId]?.position;
  const targetFixed = state.fixedActors[evidence.targetActorId]?.position;
  if (!attackerFixed || !targetFixed || !samePoint(attackerFixed, evidence.from) ||
      !samePoint(targetFixed, evidence.targetPosition) || !samePoint(evidence.to, evidence.targetPosition) ||
      attacker.position.x !== floorCell(evidence.from.x) || attacker.position.y !== floorCell(evidence.from.y) ||
      target.position.x !== floorCell(evidence.targetPosition.x) || target.position.y !== floorCell(evidence.targetPosition.y)) {
    return failure("stale_snapshot", "physical actor positions no longer match the actor snapshot");
  }
  const sharedPlaza = attacker.location.area === "plaza" && target.location.area === "plaza" &&
    attacker.currentRoomId === "plaza" && target.currentRoomId === "plaza";
  const sharedCastle = attacker.location.area === "castle" && target.location.area === "castle" &&
    !!attacker.location.castleTeam && attacker.location.castleTeam === target.location.castleTeam &&
    attacker.location.roomId === target.location.roomId && attacker.currentRoomId === target.currentRoomId;
  if (!sharedPlaza && !sharedCastle) {
    return failure("invalid_contact", "actors must share one plaza or castle room for contact damage");
  }
  if ((attacker.protectedUntilTick !== null && evidence.tick < attacker.protectedUntilTick) ||
      (target.protectedUntilTick !== null && evidence.tick < target.protectedUntilTick)) {
    return failure("invalid_contact", "spawn-protected actors cannot participate in contact damage");
  }
  if (target.damageImmuneUntilTick !== null && evidence.tick < target.damageImmuneUntilTick) {
    return failure("invalid_contact", "target is temporarily immune to additional damage");
  }
  const contactDistance = Math.hypot(targetFixed.x - attackerFixed.x, targetFixed.y - attackerFixed.y);
  const contactClear = sharedPlaza
    ? plazaPointCanOccupy(state, attackerFixed) && plazaPointCanOccupy(state, targetFixed)
    : hasFloorLineOfSight(state, attacker.location.castleTeam!, attackerFixed, targetFixed);
  if (contactDistance > ACTOR_RADIUS_SUBUNITS * 2 || !contactClear) {
    return failure("invalid_contact", "actor circles do not overlap or a wall blocks contact");
  }
  if (evidence.targetCargoId !== undefined) {
    const object = state.objects[evidence.targetCargoId];
    const carriedByActor = object !== undefined &&
      (object.location.kind === "carried" || object.location.kind === "reserved-carried") &&
      object.location.actorId === target.id;
    if (!target.cargoIds.includes(evidence.targetCargoId) || !carriedByActor) {
      return failure("invalid_contact", "selected target cargo is not currently carried by the target");
    }
  }
  return {
    ok: true,
    value: {
      kind: "damage_actor",
      matchId: evidence.matchId,
      actorId: target.id,
      generation: target.generation,
      amount: state.rules.dashActorDamage,
      ...(evidence.targetCargoId === undefined ? {} : { dropObjectId: evidence.targetCargoId }),
    },
  };
}

export interface PreparedPlazaEntry {
  state: WorldState;
  input: MoveActorInput;
  crossing: PlazaCrossingState;
}

/**
 * Record a generation-bound plaza clearance and prepare the one move command
 * that consumes it.  This is intentionally clock-neutral: the caller applies
 * `input` in the same authoritative world tick after the physical guard
 * result has been collected.
 */
export function preparePlazaEntry(
  world: WorldState,
  evidence: PlazaEntryEvidence,
): R2bBridgeResult<PreparedPlazaEntry> {
  const actorResult = actorAtSnapshot(world, evidence.matchId, evidence.actorId, evidence.generation, evidence.tick);
  if (!actorResult.ok) return actorResult;
  const actor = actorResult.value;
  if (!validTeam(evidence.targetTeam)) return failure("invalid_target", "unknown castle side");
  if (actor.location.area !== "plaza") return failure("invalid_contact", "actor must be in the plaza");

  const candidates = guardCandidates(world, evidence.targetTeam, evidence.actorId);
  const snapshotError = exactGuardSnapshot(candidates, evidence.guardGenerations);
  if (snapshotError) return snapshotError;
  if (candidates.some((candidate) => candidate.alive)) {
    return failure("guards_remaining", "every live plaza guard must be defeated before entry");
  }

  const guardGenerations = Object.fromEntries(candidates.map((candidate) => [String(candidate.id), candidate.generation]));
  const crossing: PlazaCrossingState = {
    actorIds: [actor.id],
    capturedAtTick: world.tick,
    guardGenerations,
    allowed: true,
  };
  const next = cloneWorld(world);
  const crossings = evidence.targetTeam === "player" ? next.plaza.playerCrossings : next.plaza.enemyCrossings;
  crossings[`${actor.id}:${actor.generation}`] = crossing;
  for (const candidate of candidates) next.plaza.defeatedGuardGenerations[String(candidate.id)] = candidate.generation;
  return {
    ok: true,
    value: {
      state: next,
      crossing,
      input: {
        kind: "move_actor",
        matchId: world.matchId,
        actorId: actor.id,
        generation: actor.generation,
        castleTeam: evidence.targetTeam,
        toRoomId: "entry",
      },
    },
  };
}

/**
 * Convert one physical evidence envelope into exactly one common-world input.
 * No clock is advanced and no caller-owned state is mutated here.  The caller
 * must consume the returned input once in its authoritative tick.
 */
export function prepareR2bWorldInput(
  state: BattleState,
  request: R2bBridgeRequest,
): R2bBridgeResult<PreparedR2bWorldInput> {
  if (request.kind === "core_contact") {
    const result = bridgeCoreFirstContact(state, request.evidence);
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        kind: request.kind,
        input: result.value,
        state,
      },
    };
  }

  if (request.kind === "actor_contact") {
    const result = bridgeActorFirstContact(state, request.evidence);
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        kind: request.kind,
        input: result.value,
        state,
      },
    };
  }

  const result = preparePlazaEntry(state, request.evidence);
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      kind: request.kind,
      input: result.value.input,
      state: result.value.state,
    },
  };
}
