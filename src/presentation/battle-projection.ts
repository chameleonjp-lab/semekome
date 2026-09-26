import { PART_IDS, GATE_IDS, type CastleLayout, type GateId, type PartId, type Point, type TeamId } from '../domain/types.ts';
import { EQUIPMENT_BODY_SIZE_SUBUNITS, hasFloorLineOfSight } from '../actors/geometry.ts';
import { ACTOR_RADIUS_SUBUNITS, FLOOR_SUBUNITS, cellCenter } from '../actors/movement.ts';
import type { BattleState, BattleTurretState } from '../simulation/physical-battle.ts';

export type RenderAnchor =
  | { area: 'castle'; team: TeamId; point: Point }
  | { area: 'plaza'; point: Point };

export type RenderEffect = {
  key: string;
  tick: number;
  kind: string;
  team?: TeamId;
  actorId?: string;
  anchor?: RenderAnchor;
  plazaAnchor?: Point;
  partId?: PartId;
  gateId?: GateId;
  caseType?: string;
  amount?: number;
  route?: 'direct' | 'detour';
  progress?: number;
  radiusSubunits?: number;
  multiplier?: number;
  expiresAtTick?: number;
};

export interface FlightRenderSnapshot {
  id: string;
  objectId: string;
  caseType?: string;
  team: TeamId;
  route: 'direct' | 'detour';
  progress: number;
  distanceUnits: number;
  speedUnitsPerSecond: number;
}

export interface CoreAccessProjection {
  openGateCount: number;
  protected: boolean;
  attackable: boolean;
  hit: boolean;
}

export const ACTOR_HITBOX_RADIUS_CELLS = ACTOR_RADIUS_SUBUNITS / FLOOR_SUBUNITS;
export const EQUIPMENT_HITBOX_SIZE_CELLS = EQUIPMENT_BODY_SIZE_SUBUNITS / FLOOR_SUBUNITS;

/** Presentation visibility only; never change NPC decisions or simulation. */
export function actorVisibleToPlayer(state: BattleState, actorId: string): boolean {
  const actor = state.actors[actorId], player = state.actors.P1;
  if (!actor || !player) return false;
  if (actor.team === player.team) return true;
  if (!player.alive || player.location.area === 'plaza') return actor.location.area === 'plaza';
  if (actor.location.area !== 'castle' || actor.location.castleTeam !== player.location.castleTeam ||
      actor.currentRoomId !== player.currentRoomId || !player.location.castleTeam) return false;
  const from = state.fixedActors.P1?.position, to = state.fixedActors[actorId]?.position;
  return !!from && !!to && hasFloorLineOfSight(state, player.location.castleTeam, from, to);
}

const PLAZA_FACADE_WIDTH = 9;
const PLAZA_FACADE_TOP = 25;
const PART_SLOT_LEFT = 0.7;
const PART_SLOT_PITCH = 1.08;
const PART_SLOT_WIDTH = 0.86;
const PART_SLOT_TOP = 1.2;
const PART_SLOT_HEIGHT = 1.5;
const ROUTE_COLLISION_EPSILON = 0.012;

export function fixedPointToWorld(point: { x: number; y: number }): Point {
  return { x: point.x / FLOOR_SUBUNITS, y: point.y / FLOOR_SUBUNITS };
}

export function castlePartWorldPoint(layout: CastleLayout, partId: PartId): Point {
  const partIndex = PART_IDS.indexOf(partId);
  return {
    x: layout.frontDirection > 0 ? 123.6 : 2.4,
    y: 24 + partIndex * 3.5,
  };
}

/** Center point of the matching armor plate in the plaza's state-driven facade. */
export function plazaFacadePartWorldPoint(team: TeamId, partId: PartId): Point {
  const partIndex = PART_IDS.indexOf(partId);
  const doorX = team === 'player' ? 8.8 : 117.2;
  const left = team === 'player' ? doorX - PLAZA_FACADE_WIDTH : doorX;
  return {
    x: left + PART_SLOT_LEFT + partIndex * PART_SLOT_PITCH + PART_SLOT_WIDTH / 2,
    y: PLAZA_FACADE_TOP + PART_SLOT_TOP + PART_SLOT_HEIGHT / 2,
  };
}

export function gateWorldPoint(layout: CastleLayout, gateId: GateId): Point | undefined {
  const cells = layout.gateCells[gateId];
  if (!cells?.length) return undefined;
  const center = cells.reduce((point, cell) => ({ x: point.x + cell.x + 0.5, y: point.y + cell.y + 0.5 }), { x: 0, y: 0 });
  return { x: center.x / cells.length, y: center.y / cells.length };
}

export function coreWorldPoint(layout: CastleLayout): Point | undefined {
  const room = layout.rooms.find((candidate) => candidate.kind === 'core' || candidate.id === 'core');
  if (!room) return undefined;
  return { x: (room.rect.x0 + room.rect.x1) / 2, y: (room.rect.y0 + room.rect.y1) / 2 };
}

export function getCoreAccessProjection(state: BattleState, team: TeamId): CoreAccessProjection {
  const castle = state.castles[team];
  const openGateCount = GATE_IDS.reduce((total, gateId) => total + (castle.gates[gateId]?.open ? 1 : 0), 0);
  const hit = castle.core.hit;
  const attackable = !hit && openGateCount === GATE_IDS.length;
  return { openGateCount, protected: !hit && !attackable, attackable, hit };
}

export function actorWorldAnchor(state: BattleState, actorId: string): RenderAnchor | undefined {
  const actor = state.actors[actorId];
  const fixed = state.fixedActors[actorId]?.position;
  if (!actor || !fixed) return undefined;
  const point = fixedPointToWorld(fixed);
  if (actor.location.area === 'plaza') return { area: 'plaza', point };
  if (!actor.location.castleTeam) return undefined;
  return { area: 'castle', team: actor.location.castleTeam, point };
}

export function actorRespawnAnchor(state: BattleState, actorId: string): Extract<RenderAnchor, { area: 'castle' }> | undefined {
  const actor = state.actors[actorId];
  if (!actor) return undefined;
  const layout = actor.team === 'player' ? state.layout.home : state.layout.enemy;
  const pad = layout.rooms
    .find((room) => room.id === actor.respawnRoomId)
    ?.recoveryPads.find((candidate) => candidate.id === actor.respawnPadId);
  if (!pad) return undefined;
  return {
    area: 'castle',
    team: actor.team,
    point: { x: cellCenter(pad.cell.x) / FLOOR_SUBUNITS, y: cellCenter(pad.cell.y) / FLOOR_SUBUNITS },
  };
}

export function equipmentWorldPoint(state: BattleState, team: TeamId, kind: 'turret' | 'supply_port', id: string): Point | undefined {
  const runtime = kind === 'turret' ? state.artillery.turrets[`${team}:${id}`] : state.logistics.ports[`${team}:${id}`];
  return runtime ? fixedPointToWorld(runtime.position) : undefined;
}

export function equipmentIsDisabledAt(runtime: { disabledUntilTick: number | null }, tick: number): boolean {
  return runtime.disabledUntilTick !== null && tick <= runtime.disabledUntilTick;
}

export function equipmentIsStoppedAt(runtime: { stoppedUntilTick: number | null }, tick: number): boolean {
  return runtime.stoppedUntilTick !== null && tick < runtime.stoppedUntilTick;
}

/** Queue cases have no physical floor position; keep their display row outside the equipment hitbox. */
export function turretQueueWorldPoint(turret: BattleTurretState, frontDirection: 1 | -1, index: number): Point {
  return {
    x: turret.position.x / FLOOR_SUBUNITS + frontDirection * (0.75 + index * 1.35),
    y: turret.position.y / FLOOR_SUBUNITS,
  };
}

export function snapshotFlights(state: BattleState): Map<string, FlightRenderSnapshot> {
  return new Map(Object.values(state.artillery.flights).map((flight) => [flight.id, {
    id: flight.id,
    objectId: flight.objectId,
    caseType: state.battleCases[flight.objectId]?.type,
    team: flight.team,
    route: flight.route,
    progress: flight.progress,
    distanceUnits: flight.distanceUnits,
    speedUnitsPerSecond: flight.speedUnitsPerSecond,
  }]));
}

function projectedFlightProgress(
  previous: FlightRenderSnapshot,
  state: BattleState,
): { before: number; after: number } | undefined {
  const after = state.artillery.flights[previous.id];
  if (after) return { before: previous.progress, after: after.progress };
  if (!(previous.distanceUnits > 0) || !(previous.speedUnitsPerSecond >= 0)) return undefined;
  const delta = previous.speedUnitsPerSecond / state.rules.ticksPerSecond / previous.distanceUnits;
  return { before: previous.progress, after: Math.min(1, previous.progress + delta) };
}

function interceptionLaneProgress(
  state: BattleState,
  firstId: string,
  secondId: string,
  previousFlights: ReadonlyMap<string, FlightRenderSnapshot>,
): { route: 'direct' | 'detour'; progress: number } | undefined {
  const first = previousFlights.get(firstId), second = previousFlights.get(secondId);
  if (!first || !second || first.route !== second.route || first.team === second.team) return undefined;
  const firstProgress = projectedFlightProgress(first, state), secondProgress = projectedFlightProgress(second, state);
  if (!firstProgress || !secondProgress) return undefined;
  const sumBefore = firstProgress.before + secondProgress.before;
  const sumAfter = firstProgress.after + secondProgress.after;
  if (sumBefore > 1 + ROUTE_COLLISION_EPSILON || sumAfter < 1 - ROUTE_COLLISION_EPSILON) return undefined;
  const delta = sumAfter - sumBefore;
  const time = Math.abs(delta) < Number.EPSILON
    ? Math.abs(sumAfter - 1) <= ROUTE_COLLISION_EPSILON ? 0 : undefined
    : (1 - sumBefore) / delta;
  if (time === undefined || time < -ROUTE_COLLISION_EPSILON || time > 1 + ROUTE_COLLISION_EPSILON) return undefined;
  const progress = first.team === 'player' ? firstProgress : secondProgress;
  const atContact = progress.before + (progress.after - progress.before) * Math.max(0, Math.min(1, time));
  // `atContact` is expressed in the player's world-to-target direction,
  // independent of which projectile happened to be listed first in the event.
  return { route: first.route, progress: atContact };
}

function currentCastleLayout(state: BattleState, team: TeamId): CastleLayout {
  return team === 'player' ? state.layout.home : state.layout.enemy;
}

function frontFacadeCenter(layout: CastleLayout): Point {
  return { x: layout.frontDirection > 0 ? 123.6 : 2.4, y: 35 };
}

function plazaFacadeCenter(team: TeamId): Point {
  const doorX = team === 'player' ? 8.8 : 117.2;
  const left = team === 'player' ? doorX - PLAZA_FACADE_WIDTH : doorX;
  return { x: left + PLAZA_FACADE_WIDTH / 2, y: 35 };
}

function exteriorAnchors(state: BattleState, team: TeamId, partId: PartId): Pick<RenderEffect, 'anchor' | 'plazaAnchor'> {
  return {
    anchor: { area: 'castle', team, point: castlePartWorldPoint(currentCastleLayout(state, team), partId) },
    plazaAnchor: plazaFacadePartWorldPoint(team, partId),
  };
}

function equipmentEffectAnchor(state: BattleState, team: TeamId, kind: 'turret' | 'supply_port', id: string): RenderAnchor | undefined {
  const point = equipmentWorldPoint(state, team, kind, id);
  return point ? { area: 'castle', team, point } : undefined;
}

/** Freeze visual evidence at the exact fixed step so the RAF renderer can batch several ticks safely. */
export function projectStepRenderEffects(
  state: BattleState,
  previousFlights: ReadonlyMap<string, FlightRenderSnapshot>,
): RenderEffect[] {
  const tick = state.lastStep.processedTick;
  if (!state.lastStep.advanced || tick === null) return [];
  const effects: RenderEffect[] = [];
  const damagedParts = new Set<string>();
  const destroyedParts = new Set<string>();
  for (const event of state.lastStep.events) {
    if (event.type === 'part_damaged') damagedParts.add(`${event.team}:${event.partId}`);
    else if (event.type === 'part_destroyed') destroyedParts.add(`${event.team}:${event.partId}`);
  }
  for (const [index, event] of state.lastStep.events.entries()) {
    const key = `${tick}:${index}:${event.type}`;
    if (event.type === 'actor_damaged' || event.type === 'actor_died' || event.type === 'actor_respawned') {
      const physical = event.physicalLocation;
      const anchor: RenderAnchor | undefined = physical
        ? physical.area === 'plaza'
          ? { area: 'plaza', point: fixedPointToWorld(physical.positionSubunits) }
          : { area: 'castle', team: physical.castleTeam, point: fixedPointToWorld(physical.positionSubunits) }
        : event.type === 'actor_respawned' ? actorRespawnAnchor(state, event.actorId) : actorWorldAnchor(state, event.actorId);
      if (anchor) effects.push({ key, tick, kind: event.type, actorId: event.actorId, anchor });
    } else if (event.type === 'part_damaged' && !destroyedParts.has(`${event.team}:${event.partId}`)) {
      effects.push({ key, tick, kind: event.type, team: event.team, partId: event.partId, amount: event.amount, ...exteriorAnchors(state, event.team, event.partId) });
    } else if (event.type === 'part_destroyed') {
      effects.push({ key, tick, kind: event.type, team: event.team, partId: event.partId, ...exteriorAnchors(state, event.team, event.partId) });
      const layout = currentCastleLayout(state, event.team);
      const point = gateWorldPoint(layout, event.gateId);
      if (point) effects.push({ key: `${key}:gate`, tick, kind: 'gate_opened', team: event.team, gateId: event.gateId, anchor: { area: 'castle', team: event.team, point } });
      if (event.gateId === 'G7') {
        const core = coreWorldPoint(layout);
        if (core) effects.push({ key: `${key}:core`, tick, kind: 'core_unlocked', team: event.team, anchor: { area: 'castle', team: event.team, point: core } });
      }
    } else if (event.type === 'projectile_impacted') {
      const item = state.battleCases[event.objectId];
      const flight = [...previousFlights.values()].find((candidate) => candidate.objectId === event.objectId);
      const caseType = item?.type ?? flight?.caseType;
      if (caseType === 'screen_panel') {
        if (event.targetPart) effects.push({ key, tick, kind: event.type, team: event.targetTeam, partId: event.targetPart, caseType, ...exteriorAnchors(state, event.targetTeam, event.targetPart) });
        else {
          const layout = currentCastleLayout(state, event.targetTeam);
          effects.push({ key, tick, kind: 'projectile_no_target', team: event.targetTeam, caseType, anchor: { area: 'castle', team: event.targetTeam, point: frontFacadeCenter(layout) }, plazaAnchor: plazaFacadeCenter(event.targetTeam) });
        }
      } else if (event.targetPart) {
        const partKey = `${event.targetTeam}:${event.targetPart}`;
        // The aggregated part event is the single hit flash for all damaging
        // projectiles on that plate during this fixed step.
        if (!damagedParts.has(partKey) && !destroyedParts.has(partKey)) {
          effects.push({ key, tick, kind: event.type, team: event.targetTeam, partId: event.targetPart, caseType, ...exteriorAnchors(state, event.targetTeam, event.targetPart) });
        }
      } else {
        const layout = currentCastleLayout(state, event.targetTeam);
        effects.push({ key, tick, kind: 'projectile_no_target', team: event.targetTeam, caseType, anchor: { area: 'castle', team: event.targetTeam, point: frontFacadeCenter(layout) }, plazaAnchor: plazaFacadeCenter(event.targetTeam) });
      }
    } else if (event.type === 'repair_completed') {
      effects.push({ key, tick, kind: event.type, team: event.team, actorId: event.actorId, partId: event.partId, ...exteriorAnchors(state, event.team, event.partId) });
    } else if (event.type === 'equipment_damaged' || event.type === 'equipment_restored' || event.type === 'equipment_repair_completed') {
      const anchor = equipmentEffectAnchor(state, event.team, event.equipmentKind, event.equipmentId);
      if (anchor) effects.push({ key, tick, kind: event.type, team: event.team, actorId: 'actorId' in event ? event.actorId : undefined, anchor });
    } else if (event.type === 'projectile_intercepted') {
      const contact = interceptionLaneProgress(state, event.firstProjectileId, event.secondProjectileId, previousFlights);
      if (contact) effects.push({ key, tick, kind: event.type, route: contact.route, progress: contact.progress });
    } else if (event.type === 'projectile_split') {
      const firstChild = event.childProjectileIds.map((id) => state.artillery.flights[id]).find(Boolean);
      if (firstChild) {
        const progress = firstChild.team === 'player' ? firstChild.progress : 1 - firstChild.progress;
        effects.push({ key, tick, kind: event.type, route: firstChild.route, progress });
      }
    } else if (event.type === 'slow_zone_created') {
      effects.push({
        key, tick, kind: event.type, team: event.targetTeam,
        anchor: { area: 'castle', team: event.targetTeam, point: fixedPointToWorld(event.center) },
        radiusSubunits: event.radiusSubunits, multiplier: event.multiplier, expiresAtTick: event.expiresAtTick,
      });
    }
  }
  return effects;
}

export function floorCaseAnchor(state: BattleState, caseId: string): RenderAnchor | undefined {
  const item = state.battleCases[caseId];
  const object = state.objects[caseId];
  const fixed = item?.currentPosition ?? item?.position;
  if (!item || item.location !== 'floor' || !fixed || object?.location.kind !== 'floor') return undefined;
  const area = item.floorLocation?.area ?? (object.location.area === 'plaza' ? 'plaza' : 'castle');
  if (area === 'plaza') return { area: 'plaza', point: fixedPointToWorld(fixed) };
  const team = item.floorLocation?.area === 'castle' ? item.floorLocation.castleTeam : object.location.team;
  return { area: 'castle', team, point: fixedPointToWorld(fixed) };
}

export function queueCenterDistanceWorld(turret: BattleTurretState, frontDirection: 1 | -1): number {
  return Math.abs(turretQueueWorldPoint(turret, frontDirection, 1).x - turretQueueWorldPoint(turret, frontDirection, 0).x);
}
