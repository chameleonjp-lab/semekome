import { actorDefinitions, type ActorDefinition } from "../content/roster.ts";
import { DEFAULT_LAYOUT } from "../content/layouts.ts";
import { makeRules } from "../content/rules.ts";
import {
  actorInitialPosition,
  assertValidWorldLayout,
  canTraverse,
  createCastleState,
  linkedRoom,
  padById,
  roomContainsPoint,
  routeHasAllGates,
} from "../domain/layout.ts";
import { assertObjectLocationsUnique } from "../domain/objects.ts";
import type {
  ActorId,
  ActorLocation,
  ActorState,
  CastleState,
  CoreAttackInput,
  CreateWorldOptions,
  DamageActorInput,
  DamagePartInput,
  GateId,
  MoveActorInput,
  ObjectLocation,
  ObjectTransitionInput,
  PartId,
  PauseReason,
  RejectedInput,
  StepReport,
  TeamId,
  TrustedCollisionInput,
  WorldCommand,
  WorldEvent,
  WorldInput,
  WorldObject,
  WorldState,
} from "../domain/types.ts";
import { GATE_IDS, PART_IDS } from "../domain/types.ts";

const PLAYER_TEAM: TeamId = "player";
const ENEMY_TEAM: TeamId = "enemy";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function xorshift32(value: number): number {
  let next = value >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function normaliseSeed(seed: number | undefined): number {
  if (!Number.isFinite(seed)) return 1;
  const value = Math.trunc(seed as number) >>> 0;
  return value === 0 ? 1 : value;
}

function initialActor(definition: ActorDefinition, worldLayout: WorldState["layout"], rules: ReturnType<typeof makeRules>): ActorState {
  const castle = definition.team === PLAYER_TEAM ? worldLayout.home : worldLayout.enemy;
  const position = actorInitialPosition(castle, definition);
  const location: ActorLocation = {
    area: "castle",
    castleTeam: definition.team,
    roomId: definition.initialRoomId,
    pathRooms: [definition.initialRoomId],
    pathGates: [],
  };
  return {
    id: definition.id,
    team: definition.team,
    role: definition.role,
    homeRoomId: definition.homeRoomId,
    initialRoomId: definition.initialRoomId,
    respawnRoomId: definition.respawnRoomId,
    respawnPadId: definition.respawnPadId,
    currentRoomId: definition.initialRoomId,
    location,
    position,
    maxHealth: rules.actorHealth,
    health: rules.actorHealth,
    alive: true,
    generation: 0,
    protectedUntilTick: null,
    respawnAtTick: null,
    cargoIds: [],
    reservationIds: [],
    turretControlIds: definition.turretId ? [definition.turretId] : [],
    turretId: definition.turretId,
    guardedActorId: definition.guardedActorId,
    canAssaultOtherVehicle: definition.canAssaultOtherVehicle,
    canGuardPlaza: definition.canGuardPlaza,
    deathCount: 0,
    lastDeathTick: null,
  };
}

function emptyStepReport(): StepReport {
  return { processedTick: null, advanced: false, acceptedInputKinds: [], rejected: [], events: [] };
}

function emptyPlaza(): WorldState["plaza"] {
  return { playerCrossings: {}, enemyCrossings: {}, defeatedGuardGenerations: {} };
}

export function createWorld(options: CreateWorldOptions = {}): WorldState {
  const rules = makeRules(options.rules);
  const layout = options.layout ? clone(options.layout) : clone(DEFAULT_LAYOUT);
  assertValidWorldLayout(layout);
  const seed = normaliseSeed(options.seed);
  const matchId = options.matchId ?? `match-${seed}`;
  const world: WorldState = {
    rulesetId: rules.rulesetId,
    rules,
    matchId,
    seed,
    randomState: seed,
    tick: 0,
    phase: "running" as const,
    pauseReasons: [] as PauseReason[],
    visibility: options.nowVisible === false ? "hidden" as const : "visible" as const,
    matchLimitTicks: rules.matchLimitTicks,
    outcome: "ongoing" as const,
    layout,
    castles: {
      player: createCastleState(PLAYER_TEAM, rules.exteriorPartHealth),
      enemy: createCastleState(ENEMY_TEAM, rules.exteriorPartHealth),
    },
    actors: {} as Record<string, ActorState>,
    objects: {} as Record<string, WorldObject>,
    projectiles: {},
    reservations: {},
    plaza: emptyPlaza(),
    lastStep: emptyStepReport(),
    eventLog: [] as WorldEvent[],
  };
  for (const definition of actorDefinitions()) {
    world.actors[definition.id] = initialActor(definition, world.layout, rules);
  }
  // A visibility-hidden world is paused before its first simulation tick. No
  // elapsed wall-clock time is recorded, so showing it again cannot catch up.
  if (options.nowVisible === false) {
    world.phase = "paused";
    world.pauseReasons = ["visibility"];
  }
  assertObjectLocationsUnique(world);
  return world;
}

export function cloneWorld(world: WorldState): WorldState {
  // The layout is immutable design data. Keep that reference shared while
  // cloning only mutable simulation state; otherwise every 60 Hz tick would
  // clone thousands of floor cells.
  const { layout, ...mutable } = world;
  const next = structuredClone(mutable) as Omit<WorldState, "layout">;
  return { ...next, layout };
}

function inputKind(input: WorldInput): string {
  const raw = typeof input.kind === "string" ? input.kind : typeof input.type === "string" ? input.type : "";
  const aliases: Record<string, string> = {
    pause: "pause",
    resume: "resume",
    visibility: "visibility",
    setVisibility: "visibility",
    damage_part: "damage_part",
    damagePart: "damage_part",
    damage_actor: "damage_actor",
    damageActor: "damage_actor",
    move_actor: "move_actor",
    moveActor: "move_actor",
    move: "move_actor",
    core_attack: "core_attack",
    coreAttack: "core_attack",
    trusted_collision: "trusted_collision",
    trustedCollision: "trusted_collision",
    pickup_object: "pickup_object",
    reserve_object: "reserve_object",
    enqueue_object: "enqueue_object",
    fly_object: "fly_object",
    consume_object: "consume_object",
    drop_object: "drop_object",
    advance: "advance",
    tick: "advance",
  };
  return aliases[raw] ?? raw;
}

function inputMatchId(input: WorldInput): string | undefined {
  return typeof input.matchId === "string" ? input.matchId : undefined;
}

function reject(report: StepReport, inputIndex: number, reason: RejectedInput["reason"], detail?: string): void {
  report.rejected.push({ inputIndex, reason, detail });
}

function actorFromInput(world: WorldState, input: WorldInput, report: StepReport, inputIndex: number): ActorState | undefined {
  const candidate = input as { actorId?: unknown; generation?: unknown };
  const id = typeof candidate.actorId === "string" ? candidate.actorId : undefined;
  if (!id || !world.actors[id]) {
    reject(report, inputIndex, "unknown_actor");
    return undefined;
  }
  const actor = world.actors[id];
  if (!Number.isInteger(candidate.generation)) {
    reject(report, inputIndex, "missing_generation", `${id} generation is required`);
    return undefined;
  }
  if (candidate.generation !== actor.generation) {
    reject(report, inputIndex, "stale_generation", `${id} generation ${candidate.generation} != ${actor.generation}`);
    return undefined;
  }
  if (!actor.alive) {
    reject(report, inputIndex, "dead_actor");
    return undefined;
  }
  return actor;
}

function staleMatch(world: WorldState, input: WorldInput, report: StepReport, inputIndex: number): boolean {
  const kind = inputKind(input);
  const matchId = inputMatchId(input);
  // An empty input and the explicit one-tick command are the only inputs that
  // may omit match identity. Every command that can mutate state is scoped to
  // one match before any control effect is considered.
  if (kind !== "" && kind !== "advance" && matchId === undefined) {
    reject(report, inputIndex, "missing_match", "mutation input requires matchId");
    return true;
  }
  if (matchId !== undefined && matchId !== world.matchId) {
    reject(report, inputIndex, "wrong_match", `${matchId} != ${world.matchId}`);
    return true;
  }
  return false;
}

function castleForTeam(world: WorldState, team: TeamId): CastleState {
  return world.castles[team];
}

function layoutForTeam(world: WorldState, team: TeamId): typeof world.layout.home {
  return team === PLAYER_TEAM ? world.layout.home : world.layout.enemy;
}

function allGatesOpen(castle: CastleState): boolean {
  return GATE_IDS.every((id) => castle.gates[id].open);
}

function startCastleSnapshot(world: WorldState): WorldState["castles"] {
  return clone(world.castles);
}

function startActorSnapshot(world: WorldState): Record<string, ActorState> {
  return clone(world.actors);
}

function actorActionableAtStart(actor: ActorState, tick: number): boolean {
  return actor.alive && (actor.protectedUntilTick === null || tick >= actor.protectedUntilTick);
}

function coreCandidateIsValid(
  world: WorldState,
  actor: ActorState,
  input: CoreAttackInput | TrustedCollisionInput,
  startActors: Record<string, ActorState>,
  startCastles: WorldState["castles"],
  tick: number,
): boolean {
  const startActor = startActors[actor.id];
  if (!startActor || !startActor.alive || startActor.generation !== actor.generation) return false;
  if (!Number.isInteger(input.generation) || input.generation !== startActor.generation) return false;
  if (!actorActionableAtStart(startActor, tick)) return false;
  // R1 accepts a trusted collision envelope at this boundary. The envelope
  // must explicitly say that the first contact was the core; a caller's
  // optional `hit` boolean is never sufficient.
  if (input.collision !== "core") return false;
  if (input.kind === "core_attack" && input.attackType !== "dash") return false;
  if (input.kind === "trusted_collision" && input.attackType !== undefined && input.attackType !== "dash") return false;
  const targetTeam = input.targetTeam;
  if (targetTeam !== PLAYER_TEAM && targetTeam !== ENEMY_TEAM) return false;
  if (actor.team === targetTeam) return false;
  const location = startActor.location;
  if (location.area !== "castle" || location.castleTeam !== targetTeam || location.roomId !== "core") return false;
  if (startActor.currentRoomId !== "core") return false;
  const targetLayout = layoutForTeam(world, targetTeam);
  const coreRoom = targetLayout.rooms.find((room) => room.id === "core");
  if (!coreRoom || !roomContainsPoint(coreRoom, startActor.position)) return false;
  if (!allGatesOpen(startCastles[targetTeam])) return false;
  if (!routeHasAllGates(targetLayout, location.pathRooms)) return false;
  if (location.pathGates.length !== targetLayout.coreRouteGates.length ||
      location.pathGates.some((gate, index) => gate !== targetLayout.coreRouteGates[index])) return false;
  // `hit` is intentionally absent from this predicate. A caller cannot turn
  // a contact boolean into a win; the collision envelope and world location
  // above are the only trusted boundary in R1.
  return true;
}

function normalizePartId(value: unknown): PartId | undefined {
  return typeof value === "string" && PART_IDS.includes(value as PartId) ? value as PartId : undefined;
}

function destroyPartsAndOpenGates(world: WorldState, team: TeamId, events: WorldEvent[]): void {
  const castle = world.castles[team];
  const destroyed = PART_IDS.filter((id) => castle.exterior[id].destroyed);
  const oldDestroyed = new Set(castle.destroyedPartIds);
  castle.destroyedPartIds = destroyed;
  let newlyDestroyedIndex = 0;
  for (const partId of destroyed) {
    if (!oldDestroyed.has(partId)) {
      const gateId = GATE_IDS[oldDestroyed.size + newlyDestroyedIndex];
      newlyDestroyedIndex += 1;
      // This branch is only used for a part that became destroyed since the
      // previous step; each part adds exactly one prefix gate.
      if (gateId && !castle.gates[gateId].open) {
        castle.gates[gateId].open = true;
        castle.openGateIds = GATE_IDS.filter((id) => castle.gates[id].open);
        events.push({ type: "part_destroyed", team, partId, gateId });
      }
    }
  }
  // Recompute the prefix in case a test fixture starts with multiple damaged
  // parts or a caller submits multiple same-tick impacts.
  const count = destroyed.length;
  castle.openGateIds = GATE_IDS.slice(0, count);
  for (let index = 0; index < GATE_IDS.length; index += 1) {
    castle.gates[GATE_IDS[index]].open = index < count;
  }
  castle.openGateIds = GATE_IDS.slice(0, count);
}

function objectLocationFloor(world: WorldState, actor: ActorState): ObjectLocation {
  return {
    kind: "floor",
    team: actor.team,
    roomId: actor.currentRoomId,
    position: { ...actor.position },
  };
}

function compactQueue(world: WorldState, team: TeamId, turretId: string): void {
  const queue = Object.values(world.objects)
    .filter((candidate) => candidate.location.kind === "queue" && candidate.location.team === team && candidate.location.turretId === turretId)
    .sort((left, right) => {
      if (left.location.kind !== "queue" || right.location.kind !== "queue") return 0;
      return left.location.index - right.location.index || left.id.localeCompare(right.id);
    });
  queue.forEach((candidate, index) => {
    if (candidate.location.kind === "queue") candidate.location.index = index;
  });
}

function dropActorCargo(world: WorldState, actor: ActorState, events: WorldEvent[]): void {
  const cargoIds = [...actor.cargoIds];
  for (const objectId of cargoIds) {
    const object = world.objects[objectId];
    if (!object) continue;
    object.location = objectLocationFloor(world, actor);
    events.push({ type: "object_moved", objectId, location: clone(object.location) });
  }
  actor.cargoIds = [];
}

function clearActorReservations(world: WorldState, actor: ActorState): void {
  for (const reservationId of actor.reservationIds) {
    const reservation = world.reservations[reservationId];
    if (reservation) {
      for (const objectId of reservation.objectIds) {
        const object = world.objects[objectId];
        if (object?.location.kind === "reserved-carried" && object.location.actorId === actor.id) {
          object.location = objectLocationFloor(world, actor);
        }
      }
      delete world.reservations[reservationId];
    }
  }
  actor.reservationIds = [];
  actor.turretControlIds = [];
}

function applyActorDamage(
  world: WorldState,
  actor: ActorState,
  amount: number,
  currentTick: number,
  events: WorldEvent[],
): void {
  if (!actor.alive || amount <= 0) return;
  actor.health = Math.max(0, actor.health - amount);
  events.push({ type: "actor_damaged", actorId: actor.id, amount });
  if (actor.health > 0) return;
  // A dead actor is never processed a second time in the same or a later
  // input batch. This is the single reservation boundary for respawn.
  actor.alive = false;
  actor.health = 0;
  actor.lastDeathTick = currentTick;
  actor.deathCount += 1;
  actor.respawnAtTick = currentTick + (actor.team === PLAYER_TEAM ? world.rules.playerRespawnTicks : world.rules.enemyRespawnTicks);
  actor.protectedUntilTick = null;
  dropActorCargo(world, actor, events);
  clearActorReservations(world, actor);
  events.push({ type: "actor_died", actorId: actor.id, generation: actor.generation, respawnAtTick: actor.respawnAtTick });
}

function finishRespawns(world: WorldState, currentTick: number, events: WorldEvent[]): void {
  const actorIds = Object.keys(world.actors).sort();
  for (const actorId of actorIds) {
    const actor = world.actors[actorId];
    if (actor.alive || actor.respawnAtTick !== currentTick) continue;
    const castle = layoutForTeam(world, actor.team);
    const pad = padById(castle, actor.respawnPadId);
    const roomId = actor.respawnRoomId;
    actor.alive = true;
    actor.generation += 1;
    actor.health = actor.maxHealth;
    actor.respawnAtTick = null;
    actor.protectedUntilTick = currentTick + world.rules.spawnProtectionTicks;
    actor.currentRoomId = roomId;
    actor.location = {
      area: "castle",
      castleTeam: actor.team,
      roomId,
      pathRooms: [roomId],
      pathGates: [],
    };
    if (!pad || !pad.walkable) throw new Error(`respawn pad ${actor.respawnPadId} for ${actor.id} is missing or not walkable`);
    actor.position = { ...pad.cell };
    actor.cargoIds = [];
    actor.reservationIds = [];
    actor.turretControlIds = actor.turretId ? [actor.turretId] : [];
    events.push({ type: "actor_respawned", actorId, generation: actor.generation, tick: currentTick });
  }
}

function discardPendingRespawns(world: WorldState): void {
  for (const actor of Object.values(world.actors)) {
    if (!actor.alive) actor.respawnAtTick = null;
  }
}

function addCoreCandidate(
  world: WorldState,
  actor: ActorState,
  input: CoreAttackInput | TrustedCollisionInput,
  startActors: Record<string, ActorState>,
  startCastles: WorldState["castles"],
  currentTick: number,
  candidates: Array<{ attackerId: ActorId; targetTeam: TeamId }>,
  events: WorldEvent[],
): boolean {
  if (!coreCandidateIsValid(world, actor, input, startActors, startCastles, currentTick)) return false;
  const targetTeam = input.targetTeam;
  if (targetTeam !== PLAYER_TEAM && targetTeam !== ENEMY_TEAM) return false;
  candidates.push({ attackerId: actor.id, targetTeam });
  events.push({ type: "core_hit_candidate", attackerId: actor.id, targetTeam });
  return true;
}

function processMove(
  world: WorldState,
  input: MoveActorInput,
  startCastles: WorldState["castles"],
  report: StepReport,
  index: number,
): void {
  const actor = actorFromInput(world, input, report, index);
  if (!actor) return;
  const toRoomId = input.toRoomId;
  if (toRoomId === "plaza") {
    if (actor.location.area !== "castle") {
      reject(report, index, "invalid_transition", "actor is already outside a castle");
      return;
    }
    actor.location = { area: "plaza", pathRooms: [], pathGates: [] };
    actor.currentRoomId = "plaza";
    report.acceptedInputKinds.push("move_actor");
    return;
  }
  if (actor.location.area === "plaza") {
    const castleTeam = input.castleTeam;
    if (!castleTeam || toRoomId !== "entry") {
      reject(report, index, "invalid_transition", "plaza entry requires an explicit castle and entry room");
      return;
    }
    // The plaza crossing gate is intentionally not an unconditional R1
    // bypass. R2 will populate a crossing's `allowed` state after its guard
    // generation checks.
    const crossings = castleTeam === PLAYER_TEAM ? world.plaza.playerCrossings : world.plaza.enemyCrossings;
    const key = `${actor.id}:${actor.generation}`;
    if (!crossings[key]?.allowed) {
      reject(report, index, "invalid_transition", "plaza crossing has not been cleared");
      return;
    }
    actor.location = { area: "castle", castleTeam, roomId: toRoomId, pathRooms: [toRoomId], pathGates: [] };
    actor.currentRoomId = toRoomId;
    report.acceptedInputKinds.push("move_actor");
    return;
  }
  const castleTeam = actor.location.castleTeam;
  if (!castleTeam || actor.location.roomId === undefined) {
    reject(report, index, "invalid_transition", "actor has no castle location");
    return;
  }
  if (input.castleTeam !== undefined && input.castleTeam !== castleTeam) {
    reject(report, index, "invalid_transition", "castle side does not match actor location");
    return;
  }
  const castleLayout = layoutForTeam(world, castleTeam);
  const fromRoom = actor.location.roomId;
  if (!linkedRoom(castleLayout, fromRoom, toRoomId)) {
    reject(report, index, "invalid_transition", `${fromRoom} -> ${toRoomId} is not a layout link`);
    return;
  }
  const openGates = new Set(startCastles[castleTeam].openGateIds);
  if (!canTraverse(castleLayout, fromRoom, toRoomId, openGates)) {
    reject(report, index, "invalid_transition", "gate is closed at tick start");
    return;
  }
  const link = linkedRoom(castleLayout, fromRoom, toRoomId)!;
  actor.location.roomId = toRoomId;
  actor.location.pathRooms = [...actor.location.pathRooms, toRoomId];
  if (link.gateId) actor.location.pathGates = [...actor.location.pathGates, link.gateId];
  actor.currentRoomId = toRoomId;
  const room = castleLayout.rooms.find((candidate) => candidate.id === toRoomId);
  if (room) actor.position = {
    x: Math.floor((room.rect.x0 + room.rect.x1 - 1) / 2),
    y: Math.floor((room.rect.y0 + room.rect.y1 - 1) / 2),
  };
  report.acceptedInputKinds.push("move_actor");
}

function processDamagePart(
  world: WorldState,
  input: DamagePartInput,
  startCastles: WorldState["castles"],
  report: StepReport,
  index: number,
  events: WorldEvent[],
): void {
  const source = (input as unknown as { source?: unknown }).source;
  if (source !== "trusted_collision" && source !== "projectile") {
    reject(report, index, "invalid_transition", "damage source must be a trusted collision or projectile boundary");
    return;
  }
  if (input.team !== PLAYER_TEAM && input.team !== ENEMY_TEAM) {
    reject(report, index, "invalid_transition", "unknown castle team");
    return;
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    reject(report, index, "invalid_transition", "damage must be positive");
    return;
  }
  const castle = world.castles[input.team];
  const startCastle = startCastles[input.team];
  let partId = normalizePartId(input.partId);
  if (input.partId !== undefined && !partId) {
    reject(report, index, "invalid_transition", "unknown exterior part");
    return;
  }
  if (!partId) {
    partId = PART_IDS.find((id) => !startCastle.exterior[id].destroyed);
  }
  if (!partId || startCastle.exterior[partId].destroyed || castle.exterior[partId].destroyed) {
    report.acceptedInputKinds.push("damage_part");
    return;
  }
  const part = castle.exterior[partId];
  const oldHealth = part.health;
  part.health = Math.max(0, part.health - Math.trunc(input.amount));
  if (oldHealth !== part.health) events.push({ type: "part_damaged", team: input.team, partId, amount: oldHealth - part.health });
  if (part.health === 0) part.destroyed = true;
  report.acceptedInputKinds.push("damage_part");
}

function processObjectTransition(
  world: WorldState,
  input: ObjectTransitionInput,
  report: StepReport,
  index: number,
  events: WorldEvent[],
): void {
  const object = world.objects[input.objectId];
  if (!object) {
    reject(report, index, "invalid_object_transition", "unknown object");
    return;
  }
  const actorRequired = input.kind !== "consume_object";
  if (actorRequired && !input.actorId) {
    reject(report, index, "invalid_object_transition", `${input.kind} requires actorId`);
    return;
  }
  const actor = input.actorId ? actorFromInput(world, input, report, index) : undefined;
  if (input.actorId && !actor) return;

  const releaseReservation = (reservationId: string): void => {
    const reservation = world.reservations[reservationId];
    if (reservation) {
      const owner = world.actors[reservation.ownerActorId];
      if (owner) owner.reservationIds = owner.reservationIds.filter((id) => id !== reservationId);
      delete world.reservations[reservationId];
    }
  };

  if (input.kind === "pickup_object") {
    if (!actor || object.location.kind !== "floor") {
      reject(report, index, "invalid_object_transition", "pickup requires a floor object and live actor");
      return;
    }
    if (actor.cargoIds.length >= world.rules.maxCarrySlots) {
      reject(report, index, "invalid_object_transition", "cargo capacity");
      return;
    }
    const slot = actor.cargoIds.length;
    object.location = { kind: "carried", actorId: actor.id, slot };
    actor.cargoIds = [...actor.cargoIds, object.id];
  } else if (input.kind === "reserve_object") {
    if (!actor || object.location.kind !== "carried" || object.location.actorId !== actor.id || !input.reservationId) {
      reject(report, index, "invalid_object_transition", "reservation requires owned carried object");
      return;
    }
    const reservationId = input.reservationId;
    if (world.reservations[reservationId]) {
      reject(report, index, "invalid_object_transition", "reservation already exists");
      return;
    }
    world.reservations[reservationId] = {
      id: reservationId,
      kind: "work",
      ownerActorId: actor.id,
      objectIds: [object.id],
      createdTick: world.tick,
    };
    object.location = { kind: "reserved-carried", actorId: actor.id, slot: object.location.slot, reservationId };
    actor.reservationIds = [...actor.reservationIds, reservationId];
  } else if (input.kind === "enqueue_object") {
    const turretId = input.turretId;
    const team = input.team ?? actor?.team;
    if (!actor || !turretId || !team || team !== actor.team ||
        (object.location.kind !== "carried" && object.location.kind !== "reserved-carried") ||
        object.location.actorId !== actor.id) {
      reject(report, index, "invalid_object_transition", "queue requires an actor-owned carried object and own-team turret");
      return;
    }
    const turret = layoutForTeam(world, team).turrets.find((candidate) => candidate.id === turretId);
    if (!turret) {
      reject(report, index, "invalid_object_transition", "turret does not belong to actor team");
      return;
    }
    const queueEntries = Object.values(world.objects).filter((candidate) =>
      candidate.location.kind === "queue" && candidate.location.turretId === turretId && candidate.location.team === team,
    );
    const capacity = turret.queueCapacity;
    if (queueEntries.length >= capacity) {
      reject(report, index, "invalid_object_transition", "turret queue full");
      return;
    }
    const previousLocation = object.location;
    object.location = { kind: "queue", team, turretId, index: queueEntries.length };
    actor.cargoIds = actor.cargoIds.filter((id) => id !== object.id);
    if (previousLocation.kind === "reserved-carried") releaseReservation(previousLocation.reservationId);
  } else if (input.kind === "fly_object") {
    if (!actor || !input.projectileId || object.location.kind !== "queue") {
      reject(report, index, "invalid_object_transition", "flight requires actor, queued object, and projectile id");
      return;
    }
    if (object.location.team !== actor.team || (input.team !== undefined && input.team !== actor.team)) {
      reject(report, index, "invalid_object_transition", "flight actor and queue team must match");
      return;
    }
    if (world.projectiles[input.projectileId]) {
      reject(report, index, "invalid_object_transition", "projectile id already exists");
      return;
    }
    const targetTeam = input.targetTeam ?? (actor.team === PLAYER_TEAM ? ENEMY_TEAM : PLAYER_TEAM);
    if (targetTeam !== PLAYER_TEAM && targetTeam !== ENEMY_TEAM || targetTeam === actor.team) {
      reject(report, index, "invalid_object_transition", "flight target must be the opposing team");
      return;
    }
    const targetPartId = input.targetPartId === undefined ? undefined : normalizePartId(input.targetPartId);
    if (input.targetPartId !== undefined && !targetPartId) {
      reject(report, index, "invalid_object_transition", "unknown projectile target part");
      return;
    }
    const queueTeam = object.location.team;
    const queueTurretId = object.location.turretId;
    object.location = { kind: "flying", projectileId: input.projectileId };
    compactQueue(world, queueTeam, queueTurretId);
    world.projectiles[input.projectileId] = {
      id: input.projectileId,
      objectId: object.id,
      team: actor.team,
      sourceActorId: actor.id,
      sourceGeneration: actor.generation,
      targetTeam,
      targetPartId,
    };
  } else if (input.kind === "consume_object") {
    if (object.location.kind === "flying") {
      const projectileId = object.location.projectileId;
      const projectile = world.projectiles[projectileId];
      if (!projectile || projectile.objectId !== object.id) {
        reject(report, index, "invalid_object_transition", "flying object has no matching projectile");
        return;
      }
      delete world.projectiles[projectileId];
    } else if (!actor ||
      (object.location.kind !== "carried" && object.location.kind !== "reserved-carried") ||
      object.location.actorId !== actor.id) {
      reject(report, index, "invalid_object_transition", "consume requires a matching flying projectile or owned cargo");
      return;
    }
    const previousLocation = object.location;
    object.location = { kind: "consumed", reason: input.reason ?? "unspecified", tick: world.tick };
    if (actor) actor.cargoIds = actor.cargoIds.filter((id) => id !== object.id);
    if (previousLocation.kind === "reserved-carried") releaseReservation(previousLocation.reservationId);
    events.push({ type: "object_consumed", objectId: object.id, reason: input.reason ?? "unspecified" });
  } else if (input.kind === "drop_object") {
    if (!actor || !actor.cargoIds.includes(object.id) ||
        (object.location.kind !== "carried" && object.location.kind !== "reserved-carried") ||
        object.location.actorId !== actor.id) {
      reject(report, index, "invalid_object_transition", "drop requires object carried by actor");
      return;
    }
    const previousLocation = object.location;
    object.location = objectLocationFloor(world, actor);
    actor.cargoIds = actor.cargoIds.filter((id) => id !== object.id);
    if (previousLocation.kind === "reserved-carried") releaseReservation(previousLocation.reservationId);
  }
  events.push({ type: "object_moved", objectId: object.id, location: clone(object.location) });
  report.acceptedInputKinds.push(input.kind);
}

function controlInput(world: WorldState, kind: string, input: WorldInput, report: StepReport, index: number): boolean {
  if (kind === "pause") {
    if (!world.pauseReasons.includes("explicit")) world.pauseReasons.push("explicit");
    world.phase = "paused";
    report.acceptedInputKinds.push(kind);
    return true;
  }
  if (kind === "resume") {
    world.pauseReasons = world.pauseReasons.filter((reason) => reason !== "explicit");
    world.phase = world.pauseReasons.length ? "paused" : "running";
    report.acceptedInputKinds.push(kind);
    return true;
  }
  if (kind === "visibility") {
    const visible = (input as { visible?: unknown }).visible === true;
    world.visibility = visible ? "visible" : "hidden";
    if (visible) world.pauseReasons = world.pauseReasons.filter((reason) => reason !== "visibility");
    else if (!world.pauseReasons.includes("visibility")) world.pauseReasons.push("visibility");
    world.phase = world.pauseReasons.length ? "paused" : "running";
    report.acceptedInputKinds.push(kind);
    return true;
  }
  void index;
  return false;
}

function asCoreInput(kind: string, input: WorldInput): CoreAttackInput | TrustedCollisionInput | undefined {
  if (kind === "core_attack") return { ...(input as unknown as CoreAttackInput), kind: "core_attack" };
  if (kind === "trusted_collision") return { ...(input as unknown as TrustedCollisionInput), kind: "trusted_collision" };
  return undefined;
}

/** Advance exactly one integer simulation tick. Wall-clock elapsed time is never an input. */
export function stepWorld(world: WorldState, input?: WorldInput | readonly WorldInput[]): WorldState {
  const next = cloneWorld(world);
  const inputs = input === undefined ? [] : Array.isArray(input) ? [...input] : [input];
  const report = emptyStepReport();

  if (next.phase === "ended") {
    if (inputs.length === 0) return next;
    for (let index = 0; index < inputs.length; index += 1) reject(report, index, "ended");
    next.lastStep = report;
    return next;
  }
  next.lastStep = report;

  const validInputIndexes = new Set<number>();
  for (let index = 0; index < inputs.length; index += 1) {
    if (!staleMatch(next, inputs[index], report, index)) validInputIndexes.add(index);
  }
  const pauseRequested = [...validInputIndexes].some((index) => {
    const candidate = inputs[index];
    return ["pause", "visibility"].includes(inputKind(candidate)) &&
      (inputKind(candidate) === "pause" || (candidate as { visible?: unknown }).visible !== true);
  });
  // Control commands are applied even while paused. Other commands are not
  // silently executed during a pause.
  for (let index = 0; index < inputs.length; index += 1) {
    if (!validInputIndexes.has(index)) continue;
    const candidate = inputs[index];
    const kind = inputKind(candidate);
    if (controlInput(next, kind, candidate, report, index)) continue;
  }
  if (next.phase === "paused" || pauseRequested) {
    for (let index = 0; index < inputs.length; index += 1) {
      if (!validInputIndexes.has(index)) continue;
      const kind = inputKind(inputs[index]);
      if (!["pause", "resume", "visibility", ""].includes(kind)) {
        if (!report.acceptedInputKinds.includes(kind)) reject(report, index, "paused");
      }
    }
    report.advanced = false;
    report.processedTick = null;
    assertObjectLocationsUnique(next);
    return next;
  }

  const currentTick = next.tick;
  report.processedTick = currentTick;
  const startCastles = startCastleSnapshot(next);
  const startActors = startActorSnapshot(next);
  const candidates: Array<{ attackerId: ActorId; targetTeam: TeamId }> = [];
  const events: WorldEvent[] = [];

  // Collect all valid core contacts from the same start snapshot first. This
  // makes a same-tick attacker death unable to erase an already valid hit.
  for (let index = 0; index < inputs.length; index += 1) {
    if (!validInputIndexes.has(index)) continue;
    const candidate = inputs[index];
    const kind = inputKind(candidate);
    const coreInput = asCoreInput(kind, candidate);
    if (!coreInput) continue;
    const actorId = typeof candidate.actorId === "string" ? candidate.actorId : undefined;
    if (!actorId || !next.actors[actorId]) {
      reject(report, index, "unknown_actor");
      continue;
    }
    const requestedGeneration = (candidate as { generation?: unknown }).generation;
    if (!Number.isInteger(requestedGeneration)) {
      reject(report, index, "missing_generation", `${actorId} generation is required`);
      continue;
    }
    if (requestedGeneration !== next.actors[actorId].generation) {
      reject(report, index, "stale_generation");
      continue;
    }
    if (addCoreCandidate(next, next.actors[actorId], coreInput, startActors, startCastles, currentTick, candidates, events)) {
      report.acceptedInputKinds.push(kind);
    } else {
      reject(report, index, "invalid_core_attack");
    }
  }

  for (let index = 0; index < inputs.length; index += 1) {
    if (!validInputIndexes.has(index)) continue;
    const candidate = inputs[index];
    const kind = inputKind(candidate);
    if (["", "advance", "pause", "resume", "visibility", "core_attack", "trusted_collision"].includes(kind)) continue;
    if (kind === "damage_part") {
      processDamagePart(next, candidate as unknown as DamagePartInput, startCastles, report, index, events);
    } else if (kind === "damage_actor") {
      const actorInput = candidate as unknown as DamageActorInput;
      const actor = actorFromInput(next, actorInput, report, index);
      if (!actor) continue;
      const startActor = startActors[actor.id];
      if (!startActor || !startActor.alive) {
        reject(report, index, "dead_actor");
        continue;
      }
      if (startActor.protectedUntilTick !== null && currentTick < startActor.protectedUntilTick) {
        reject(report, index, "protected_actor");
        continue;
      }
      if (!Number.isFinite(actorInput.amount) || actorInput.amount <= 0) {
        reject(report, index, "invalid_transition", "damage must be positive");
        continue;
      }
      applyActorDamage(next, actor, Math.trunc(actorInput.amount), currentTick, events);
      report.acceptedInputKinds.push(kind);
    } else if (kind === "move_actor") {
      processMove(next, candidate as unknown as MoveActorInput, startCastles, report, index);
    } else if (["pickup_object", "reserve_object", "enqueue_object", "fly_object", "consume_object", "drop_object"].includes(kind)) {
      processObjectTransition(next, { ...(candidate as unknown as ObjectTransitionInput), kind: kind as ObjectTransitionInput["kind"] }, report, index, events);
    } else {
      reject(report, index, "unsupported_in_r1");
    }
  }

  destroyPartsAndOpenGates(next, PLAYER_TEAM, events);
  destroyPartsAndOpenGates(next, ENEMY_TEAM, events);

  let finalOutcome: WorldState["outcome"] = "ongoing";
  const hitTargets = new Set(candidates.map((candidate) => candidate.targetTeam));
  if (hitTargets.has(PLAYER_TEAM) && hitTargets.has(ENEMY_TEAM)) finalOutcome = "draw";
  else if (hitTargets.has(PLAYER_TEAM)) finalOutcome = "enemy_win";
  else if (hitTargets.has(ENEMY_TEAM)) finalOutcome = "player_win";
  else if (currentTick >= next.matchLimitTicks - 1) finalOutcome = "draw";

  if (finalOutcome !== "ongoing") {
    next.outcome = finalOutcome;
    next.phase = "ended";
    for (const castle of Object.values(next.castles)) {
      if (hitTargets.has(castle.team)) castle.core.hit = true;
    }
    discardPendingRespawns(next);
    events.push({ type: "outcome", outcome: finalOutcome, tick: currentTick });
  } else {
    finishRespawns(next, currentTick, events);
  }

  next.tick = currentTick + 1;
  next.randomState = xorshift32(next.randomState);
  report.advanced = true;
  report.events = events;
  next.eventLog = [...next.eventLog, ...events];
  assertObjectLocationsUnique(next);
  return next;
}

export const advanceWorld = stepWorld;
