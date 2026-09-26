import { getInteraction } from '../simulation/physical-battle.ts';
import type { BattleState } from '../simulation/physical-battle.ts';
import type { ActorState, CastleLayout, PartId, Point, TeamId } from '../domain/types.ts';
import { PART_IDS } from '../domain/types.ts';
import {
  drawGameArt, getGameArt, requestGameArtLoad,
  type GameArtName,
} from './game-art.ts';
import {
  ACTOR_HITBOX_RADIUS_CELLS,
  EQUIPMENT_HITBOX_SIZE_CELLS,
  actorRespawnAnchor,
  actorVisibleToPlayer,
  castlePartWorldPoint,
  coreWorldPoint,
  equipmentIsDisabledAt,
  equipmentIsStoppedAt,
  equipmentWorldPoint,
  floorCaseAnchor,
  gateWorldPoint,
  getCoreAccessProjection,
  plazaFacadePartWorldPoint,
  projectStepRenderEffects,
  snapshotFlights,
  turretQueueWorldPoint,
  type FlightRenderSnapshot,
  type RenderAnchor,
  type RenderEffect,
} from './battle-projection.ts';

export const caseLabels: Record<string, string> = {
  standard_slug: '標準弾', dense_payload: '重量弾', screen_panel: '防護板', fast_dart: '高速杭',
  split_payload: '分割弾', disruption_pack: '補給妨害', breach_lance: '貫通杭', adhesive_pod: '通路妨害',
};
const caseColors: Record<string, string> = {
  standard_slug: '#efce7c', dense_payload: '#e5a574', screen_panel: '#9bbef2', fast_dart: '#e5e9eb',
  split_payload: '#d8a4df', disruption_pack: '#e58a89', breach_lance: '#d4b58b', adhesive_pod: '#9bd0a6',
};
const roomColors: Record<string, string> = {
  core: '#4c4132', respawn: '#40374a', corridor: '#304550', repair: '#3a514d', command: '#384553',
  supply: '#3c5143', battery: '#3b4655', security: '#4a3b40',
};
const roomLabels: Record<string, string> = {
  core: '核室', respawn: '復活室', central_corridor: '中央通路', repair: '修理室', command: '指令室',
  battery_a: '砲台A', battery_b: '砲台B', battery_c: '砲台C', battery_d: '砲台D',
  ammo_a: '弾薬庫A', ammo_b: '弾薬庫B', ammo_c: '弾薬庫C', ammo_d: '弾薬庫D',
  security: '警備室', front_corridor: '前部通路', rear_corridor: '後部通路',
};

type FloorSurface = { canvas: HTMLCanvasElement; hasFloorArt: boolean };
const FLOOR_TEXTURE_UNIT = 12;
let cachedFloorTextureSource: HTMLImageElement | undefined;
let cachedFloorTextureTile: HTMLCanvasElement | undefined;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
function artName(type: string): GameArtName | undefined {
  const names: readonly string[] = ['standard_slug', 'dense_payload', 'screen_panel', 'fast_dart', 'split_payload', 'disruption_pack', 'breach_lance', 'adhesive_pod'];
  return names.includes(type) ? type as GameArtName : undefined;
}
function teamColor(team: TeamId): string { return team === 'player' ? '#a8ded1' : '#e2a49c'; }
function objectKey(team: TeamId, id: string): string { return `${team}:${id}`; }
function roomCenter(room: CastleLayout['rooms'][number]): Point {
  return { x: (room.rect.x0 + room.rect.x1) / 2, y: (room.rect.y0 + room.rect.y1) / 2 };
}
function formatClock(ticks: number, ticksPerSecond: number): string {
  const seconds = Math.ceil(Math.max(0, ticks) / ticksPerSecond);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export interface BattleRenderer {
  (state: BattleState, target: PartId, slot?: number): void;
  /** Capture each fixed simulation step before a later step overwrites lastStep. */
  observeStep(state: BattleState): void;
}

/** Downsamples the authored floor image once so cell generation copies only a 12px tile. */
function getFloorTextureTile(image: HTMLImageElement): CanvasImageSource {
  if (cachedFloorTextureSource === image && cachedFloorTextureTile) return cachedFloorTextureTile;
  const tile = document.createElement('canvas');
  tile.width = FLOOR_TEXTURE_UNIT;
  tile.height = FLOOR_TEXTURE_UNIT;
  const tileContext = tile.getContext('2d');
  if (!tileContext) return image;
  tileContext.imageSmoothingEnabled = false;
  tileContext.drawImage(image, 0, 0, FLOOR_TEXTURE_UNIT, FLOOR_TEXTURE_UNIT);
  cachedFloorTextureSource = image;
  cachedFloorTextureTile = tile;
  return tile;
}

/**
 * Static, state-derived art is cached per layout. When the floor texture
 * completes its asynchronous load the one cached surface is rebuilt once.
 */
function buildFloorSurface(layout: CastleLayout): FloorSurface {
  const canvas = document.createElement('canvas');
  canvas.width = layout.widthCells * FLOOR_TEXTURE_UNIT;
  canvas.height = layout.heightCells * FLOOR_TEXTURE_UNIT;
  const context = canvas.getContext('2d');
  if (!context) return { canvas, hasFloorArt: false };
  const floorImage = getGameArt('floor');
  const hasFloorArt = !!floorImage;
  const cells = new Set(layout.floorCells.map((cell) => `${cell.x},${cell.y}`));
  const roomByCell = new Map<string, string>();
  for (const room of layout.rooms) {
    for (let row = room.rect.y0; row < room.rect.y1; row += 1) {
      for (let col = room.rect.x0; col < room.rect.x1; col += 1) roomByCell.set(`${col},${row}`, room.kind);
    }
  }
  context.fillStyle = '#182c36'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  const floorTile = floorImage ? getFloorTextureTile(floorImage) : undefined;
  for (const cell of layout.floorCells) {
    const x = cell.x * FLOOR_TEXTURE_UNIT, y = cell.y * FLOOR_TEXTURE_UNIT;
    if (floorTile) context.drawImage(floorTile, x, y, FLOOR_TEXTURE_UNIT, FLOOR_TEXTURE_UNIT);
    else {
      const grain = ((cell.x * 17 + cell.y * 29) % 5) * 2;
      context.fillStyle = `rgb(${35 + grain},${58 + grain},${67 + grain})`;
      context.fillRect(x, y, FLOOR_TEXTURE_UNIT, FLOOR_TEXTURE_UNIT);
      context.fillStyle = '#c3d4d522'; context.fillRect(x + 2, y + 2, 2, 1);
    }
    const kind = roomByCell.get(`${cell.x},${cell.y}`);
    if (kind && roomColors[kind]) {
      context.fillStyle = `${roomColors[kind]}b8`;
      context.fillRect(x, y, FLOOR_TEXTURE_UNIT, FLOOR_TEXTURE_UNIT);
    }
    context.strokeStyle = '#09192322'; context.lineWidth = 0.55;
    context.strokeRect(x + 0.25, y + 0.25, FLOOR_TEXTURE_UNIT - 0.5, FLOOR_TEXTURE_UNIT - 0.5);
  }
  // The authored floor-cell boundary is also the wall line. Passage cells
  // remain open because they are part of the floor set in the layout.
  context.strokeStyle = '#82959a'; context.lineWidth = 1.3; context.beginPath();
  for (const cell of layout.floorCells) {
    const x = cell.x * FLOOR_TEXTURE_UNIT, y = cell.y * FLOOR_TEXTURE_UNIT, u = FLOOR_TEXTURE_UNIT;
    if (!cells.has(`${cell.x - 1},${cell.y}`)) { context.moveTo(x, y); context.lineTo(x, y + u); }
    if (!cells.has(`${cell.x + 1},${cell.y}`)) { context.moveTo(x + u, y); context.lineTo(x + u, y + u); }
    if (!cells.has(`${cell.x},${cell.y - 1}`)) { context.moveTo(x, y); context.lineTo(x + u, y); }
    if (!cells.has(`${cell.x},${cell.y + 1}`)) { context.moveTo(x, y + u); context.lineTo(x + u, y + u); }
  }
  context.stroke();
  return { canvas, hasFloorArt };
}

function drawCaseFallback(context: CanvasRenderingContext2D, type: string, cx: number, cy: number, size: number): void {
  context.save(); context.translate(cx, cy); context.fillStyle = caseColors[type] ?? '#eddaae';
  context.strokeStyle = '#142631'; context.lineWidth = Math.max(1, size * 0.09); context.beginPath();
  if (type === 'dense_payload') {
    context.moveTo(0, -size / 2); context.lineTo(size / 2, 0); context.lineTo(0, size / 2); context.lineTo(-size / 2, 0); context.closePath();
  } else if (type === 'fast_dart' || type === 'breach_lance') {
    context.moveTo(size / 2, 0); context.lineTo(-size / 2, -size * 0.42); context.lineTo(-size / 2, size * 0.42); context.closePath();
  } else if (type === 'screen_panel') context.rect(-size * 0.62, -size * 0.25, size * 1.24, size * 0.5);
  else if (type === 'split_payload') {
    context.moveTo(0, -size / 2); context.lineTo(size / 2, size / 2); context.lineTo(-size / 2, size / 2); context.closePath();
  } else if (type === 'disruption_pack') context.arc(0, 0, size * 0.45, 0, Math.PI * 2);
  else if (type === 'adhesive_pod') context.roundRect(-size * 0.42, -size * 0.42, size * 0.84, size * 0.84, size * 0.2);
  else context.roundRect(-size * 0.42, -size * 0.42, size * 0.84, size * 0.84, size * 0.12);
  context.fill(); context.stroke(); context.restore();
}

function drawCase(context: CanvasRenderingContext2D, type: string, x: number, y: number, size: number, alpha = 1, flipX = false): void {
  const name = artName(type);
  context.save(); context.translate(x, y); context.scale(flipX ? -1 : 1, 1);
  if (!name || !drawGameArt(context, name, -size / 2, -size / 2, size, size, alpha)) {
    context.globalAlpha = alpha; drawCaseFallback(context, type, 0, 0, size);
  }
  context.restore();
}

function drawPerson(
  context: CanvasRenderingContext2D, actor: ActorState, x: number, y: number, scale: number,
  state: BattleState, highlighted: boolean,
): void {
  const imageForRole: Record<string, GameArtName> = {
    player: 'hero', support: 'helper', shooter: 'gunner', shooter_guard: 'guard', ammo_carrier: 'carrier', internal_soldier: 'soldier',
  };
  const size = Math.max(19, scale * (actor.id === 'P1' ? 2.25 : 1.95));
  const imageName = imageForRole[actor.role] ?? 'soldier';
  const color = teamColor(actor.team);
  context.save();
  if (actor.protectedUntilTick !== null && state.tick < actor.protectedUntilTick && Math.floor(state.tick / 6) % 2 === 0) context.globalAlpha = 0.58;
  const artVisible = drawGameArt(context, imageName, x - size / 2, y - size / 2, size, size);
  if (!artVisible) {
    context.fillStyle = color; context.strokeStyle = '#142631'; context.lineWidth = 1.6;
    context.beginPath(); context.arc(x, y - size * 0.16, size * 0.23, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = color; context.beginPath(); context.roundRect(x - size * 0.25, y, size * 0.5, size * 0.39, size * 0.12); context.fill(); context.stroke();
  }
  context.globalAlpha = 1;
  // The sprite stays readable, while this small center outline shows the
  // actual movement/collision radius instead of suggesting the whole image is solid.
  context.strokeStyle = highlighted ? '#fff2aa' : color; context.lineWidth = highlighted ? 1.7 : 1;
  context.beginPath(); context.arc(x, y, ACTOR_HITBOX_RADIUS_CELLS * scale, 0, Math.PI * 2); context.stroke();
  if (actor.damageImmuneUntilTick !== null && state.tick < actor.damageImmuneUntilTick) {
    context.strokeStyle = '#9ddcff'; context.lineWidth = 1.5; context.setLineDash([2, 2]);
    context.beginPath(); context.arc(x, y, size * 0.72, 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
  }
  if (actor.alive && actor.id === 'P1' && scale >= 7) {
    const barWidth = size * 1.05, barY = y + size * 0.52;
    context.fillStyle = '#101c27cc'; context.fillRect(x - barWidth / 2, barY, barWidth, 2.5);
    context.fillStyle = actor.team === 'player' ? '#a8ded1' : '#e2a49c';
    context.fillRect(x - barWidth / 2, barY, barWidth * clamp(actor.health / actor.maxHealth, 0, 1), 2.5);
  }
  const slots = state.cargoSlots[actor.id] ?? [null, null];
  slots.forEach((caseId, index) => {
    if (!caseId) return;
    const item = state.battleCases[caseId];
    if (!item) return;
    drawCase(context, item.type, x + (index - 0.5) * size * 0.56, y - size * 0.55, size * 0.42);
  });
  if (actor.id === 'P1' || highlighted) {
    context.font = '9px -apple-system, "Noto Sans JP", sans-serif'; context.textAlign = 'center';
    context.fillStyle = '#e8f1ef'; context.strokeStyle = '#142631'; context.lineWidth = 3; context.textBaseline = 'bottom';
    const name = actor.id === 'P1' ? 'あなた' : actor.role === 'support' ? '補助員' : actor.id;
    context.strokeText(name, x, y - size * 0.62); context.fillText(name, x, y - size * 0.62);
  }
  context.restore();
}

function drawEquipmentIcon(
  context: CanvasRenderingContext2D,
  name: 'turret' | 'supply' | 'repair' | 'core' | 'gate',
  x: number,
  y: number,
  size: number,
  color: string,
  alpha = 1,
  flipX = false,
): void {
  context.save(); context.translate(x, y); context.scale(flipX ? -1 : 1, 1);
  if (drawGameArt(context, name, -size / 2, -size / 2, size, size, alpha)) { context.restore(); return; }
  const cx = 0, cy = 0;
  context.globalAlpha *= alpha; context.fillStyle = color; context.strokeStyle = '#132733'; context.lineWidth = 1.2;
  if (name === 'turret') {
    context.fillRect(cx - size * 0.38, cy - size * 0.3, size * 0.76, size * 0.6);
    context.fillRect(cx - size * 0.06, cy - size * 0.12, size * 0.62, size * 0.22);
  } else if (name === 'supply') {
    context.beginPath(); context.roundRect(cx - size * 0.36, cy - size * 0.36, size * 0.72, size * 0.72, size * 0.12); context.fill(); context.stroke();
    context.strokeStyle = '#e2ebd0'; context.beginPath(); context.moveTo(cx, cy - size * 0.2); context.lineTo(cx, cy + size * 0.2); context.moveTo(cx - size * 0.2, cy); context.lineTo(cx + size * 0.2, cy); context.stroke();
  } else if (name === 'core') {
    context.beginPath(); context.moveTo(cx, cy - size * 0.45); context.lineTo(cx + size * 0.4, cy); context.lineTo(cx, cy + size * 0.45); context.lineTo(cx - size * 0.4, cy); context.closePath(); context.fill(); context.stroke();
  } else if (name === 'gate') {
    context.strokeRect(cx - size * 0.38, cy - size * 0.42, size * 0.76, size * 0.84);
    context.beginPath(); context.moveTo(cx - size * 0.15, cy - size * 0.25); context.lineTo(cx - size * 0.15, cy + size * 0.24); context.moveTo(cx + size * 0.15, cy - size * 0.25); context.lineTo(cx + size * 0.15, cy + size * 0.24); context.stroke();
  } else {
    context.beginPath(); context.arc(cx, cy, size * 0.34, 0, Math.PI * 2); context.fill(); context.stroke();
    context.beginPath(); context.moveTo(cx - size * 0.2, cy); context.lineTo(cx - size * 0.05, cy + size * 0.18); context.lineTo(cx + size * 0.23, cy - size * 0.2); context.stroke();
  }
  context.restore();
}

function drawHealthPips(context: CanvasRenderingContext2D, x: number, y: number, width: number, health: number, maximum: number, disabled: boolean): void {
  const ratio = maximum > 0 ? clamp(health / maximum, 0, 1) : 0;
  context.fillStyle = '#101c27dd'; context.fillRect(x - width / 2, y, width, 3);
  context.fillStyle = disabled ? '#e58c81' : ratio > 0.5 ? '#a9ddbd' : '#e9bd77';
  context.fillRect(x - width / 2, y, width * ratio, 3);
}

function drawEquipmentTeamRing(context: CanvasRenderingContext2D, x: number, y: number, size: number, team: TeamId): void {
  context.save();
  context.strokeStyle = team === 'player' ? '#a8ded1' : '#edaaa0';
  context.lineWidth = 1.8;
  context.setLineDash(team === 'player' ? [] : [2, 1.5]);
  context.beginPath(); context.arc(x, y, size * 0.56, 0, Math.PI * 2); context.stroke();
  context.restore();
}

function drawEquipmentFootprint(context: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
  const size = EQUIPMENT_HITBOX_SIZE_CELLS * scale;
  context.save();
  context.strokeStyle = '#f5ebbfbb'; context.lineWidth = 1; context.setLineDash([2, 2]);
  context.strokeRect(x - size / 2, y - size / 2, size, size);
  context.restore();
}

function drawFortressFacade(context: CanvasRenderingContext2D, state: BattleState, team: TeamId, doorX: number, centerY: number, scale: number): void {
  const castle = state.castles[team];
  const w = 9, h = 20;
  // Coordinates arrive in viewport pixels after plaza camera translation.
  const left = team === 'player' ? doorX - w * scale : doorX;
  const top = centerY - h * scale / 2;
  context.save();
  context.fillStyle = team === 'player' ? '#49695f' : '#70504e'; context.strokeStyle = '#bbbbb0'; context.lineWidth = 1.2;
  context.fillRect(left, top, w * scale, h * scale); context.strokeRect(left, top, w * scale, h * scale);
  // Keep the plaza entrance open at all times; the seven interior gates are
  // drawn from their own state inside the castle map.
  const openingX = team === 'player' ? left + (w - 1.4) * scale : left + 0.4 * scale;
  context.fillStyle = '#111d25'; context.fillRect(openingX, centerY - 2.2 * scale, 1.2 * scale, 4.4 * scale);
  for (let index = 0; index < PART_IDS.length; index += 1) {
    const part = castle.exterior[PART_IDS[index]];
    const px = left + (0.7 + index * 1.08) * scale, py = top + 1.2 * scale;
    context.fillStyle = part.destroyed ? '#26343a' : team === 'player' ? '#b5dfcd' : '#e4b7ac';
    context.strokeStyle = part.destroyed ? '#829095' : '#26343a'; context.lineWidth = 0.7;
    context.fillRect(px, py, 0.86 * scale, 1.5 * scale); context.strokeRect(px, py, 0.86 * scale, 1.5 * scale);
    if (part.destroyed) {
      context.strokeStyle = '#c0776d'; context.beginPath(); context.moveTo(px, py); context.lineTo(px + 0.86 * scale, py + 1.5 * scale); context.stroke();
    } else drawHealthPips(context, px + 0.43 * scale, py + 1.7 * scale, 0.76 * scale, part.health, part.maxHealth, false);
  }
  context.fillStyle = team === 'player' ? '#dcf1e8' : '#f1d4ce'; context.font = `${Math.max(8, scale * 1.3)}px sans-serif`; context.textAlign = 'center';
  context.fillText(team === 'player' ? '自城' : '敵城', left + w * scale / 2, top + (h - 1) * scale);
  context.restore();
}

function effectPoint(effect: RenderEffect, area: 'castle' | 'plaza', team?: TeamId): Point | undefined {
  if (area === 'plaza') {
    if (effect.plazaAnchor) return effect.plazaAnchor;
    return effect.anchor?.area === 'plaza' ? effect.anchor.point : undefined;
  }
  return effect.anchor?.area === 'castle' && effect.anchor.team === team ? effect.anchor.point : undefined;
}

function drawStepEffect(context: CanvasRenderingContext2D, effect: RenderEffect, x: number, y: number, scale: number, age: number): void {
  const size = Math.max(8, scale * (0.82 + age * 0.055));
  const alpha = Math.max(0, 1 - age / 23);
  const color = effect.kind === 'screen_panel' || effect.caseType === 'screen_panel' ? '#9edbff'
    : effect.kind === 'gate_opened' || effect.kind === 'core_unlocked' || effect.kind.includes('repair') ? '#a8e3bd'
      : effect.kind === 'projectile_no_target' ? '#c2c9c8'
        : effect.kind === 'actor_died' ? '#ff8279'
          : '#ffd08c';
  context.save(); context.globalAlpha = alpha;
  if (effect.kind === 'screen_panel' || effect.caseType === 'screen_panel') {
    context.strokeStyle = color; context.lineWidth = 1.7; context.beginPath(); context.arc(x, y, size * 0.44, 0, Math.PI * 2); context.stroke();
    context.beginPath(); context.moveTo(x - size * 0.35, y); context.lineTo(x + size * 0.35, y); context.stroke();
    context.restore(); return;
  }
  if (effect.kind === 'projectile_no_target') {
    context.strokeStyle = color; context.lineWidth = 1.3; context.setLineDash([2, 2]);
    context.beginPath(); context.arc(x, y, size * 0.36, 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
    context.restore(); return;
  }
  if (effect.kind === 'gate_opened' || effect.kind === 'core_unlocked' || effect.kind.includes('repair') || effect.kind === 'equipment_restored') {
    context.strokeStyle = color; context.lineWidth = 1.7;
    context.beginPath(); context.arc(x, y, size * 0.42, -Math.PI * 0.85, Math.PI * 0.85); context.stroke();
    context.restore(); return;
  }
  if (!drawGameArt(context, 'impact', x - size / 2, y - size / 2, size, size, alpha)) {
    context.strokeStyle = color; context.lineWidth = effect.kind === 'part_destroyed' ? 2.4 : 1.7;
    context.beginPath(); context.arc(x, y, size * 0.42, 0, Math.PI * 2); context.stroke();
  }
  context.restore();
}

/** Static battleground projection plus live values, built without mutating state. */
export function createBattleRenderer(
  canvas: HTMLCanvasElement,
  initial: BattleState,
): BattleRenderer {
  const context = canvas.getContext('2d')!;
  if (!context) throw new Error('battle canvas 2D context is unavailable');
  requestGameArtLoad();
  const floorSurfaces = new Map<CastleLayout, FloorSurface>();
  const effects: RenderEffect[] = [];
  const seenEffects = new Set<string>();
  const observedEnemyDeaths = new Set<string>();
  let previousFlights: ReadonlyMap<string, FlightRenderSnapshot> = snapshotFlights(initial);
  let lastObservedTick: number | null = null;

  const floorSurface = (layout: CastleLayout): FloorSurface => {
    const existing = floorSurfaces.get(layout);
    const loaded = !!getGameArt('floor');
    if (existing && existing.hasFloorArt === loaded) return existing;
    const next = buildFloorSurface(layout);
    floorSurfaces.set(layout, next);
    return next;
  };

  function observeStep(state: BattleState): void {
    const observedTick = state.lastStep.processedTick;
    if (!state.lastStep.advanced || observedTick === null || (lastObservedTick !== null && observedTick <= lastObservedTick)) return;
    for (const effect of projectStepRenderEffects(state, previousFlights)) {
      if (effect.actorId && state.actors[effect.actorId]?.team === 'enemy') {
        if (!actorVisibleToPlayer(state, effect.actorId)) continue;
        if (effect.kind === 'actor_died') observedEnemyDeaths.add(`${effect.actorId}:${state.actors[effect.actorId].generation}`);
      }
      if (seenEffects.has(effect.key)) continue;
      seenEffects.add(effect.key);
      effects.push(effect);
    }
    previousFlights = snapshotFlights(state);
    for (const key of observedEnemyDeaths) {
      const [id, generation] = key.split(':');
      if (!state.actors[id] || state.actors[id].alive || state.actors[id].generation !== Number(generation)) observedEnemyDeaths.delete(key);
    }
    lastObservedTick = observedTick;
    for (let index = effects.length - 1; index >= 0; index -= 1) {
      if (state.tick - effects[index].tick > 42) effects.splice(index, 1);
    }
    if (seenEffects.size > 1200) {
      const retained = effects.map((effect) => effect.key);
      seenEffects.clear(); retained.forEach((key) => seenEffects.add(key));
    }
  }

  function drawFlightLanes(state: BattleState, width: number): void {
    const bandHeight = Math.min(49, Math.max(38, width * 0.12));
    const laneLeft = Math.min(43, width * 0.13), laneRight = width - laneLeft;
    context.fillStyle = '#0e1d27'; context.fillRect(0, 0, width, bandHeight);
    const routes = [
      { route: 'direct', y: bandHeight * 0.36, label: '直通' },
      { route: 'detour', y: bandHeight * 0.72, label: '迂回' },
    ] as const;
    for (const lane of routes) {
      context.strokeStyle = '#607680'; context.lineWidth = 1.1; context.setLineDash(lane.route === 'detour' ? [3, 3] : []);
      context.beginPath(); context.moveTo(laneLeft, lane.y); context.lineTo(laneRight, lane.y); context.stroke(); context.setLineDash([]);
      context.font = '8px -apple-system, "Noto Sans JP", sans-serif'; context.textAlign = 'left'; context.textBaseline = 'middle'; context.fillStyle = '#b2c6cd';
      context.fillText(lane.label, 5, lane.y);
    }
    context.font = '9px -apple-system, "Noto Sans JP", sans-serif'; context.textBaseline = 'alphabetic';
    context.fillStyle = '#b9d3d1'; context.textAlign = 'left'; context.fillText('自陣', laneLeft, 9);
    context.fillStyle = '#e7bcb3'; context.textAlign = 'right'; context.fillText('敵陣', width - 5, 9);
    const laneWidth = Math.max(1, laneRight - laneLeft);
    for (const flight of Object.values(state.artillery.flights)) {
      const lane = routes.find((candidate) => candidate.route === flight.route);
      if (!lane) continue;
      const progress = clamp(flight.progress, 0, 1);
      const x = laneLeft + laneWidth * (flight.team === 'player' ? progress : 1 - progress);
      const item = state.battleCases[flight.objectId];
      const splitChild = !!state.objects[flight.objectId]?.parentObjectId;
      const artSize = splitChild ? 2.6 : 15;
      if (splitChild) {
        context.fillStyle = teamColor(flight.team); context.strokeStyle = '#f5efda'; context.lineWidth = 0.8;
        context.beginPath(); context.arc(x, lane.y, artSize / 2, 0, Math.PI * 2); context.fill(); context.stroke();
      } else if (item) drawCase(context, item.type, x, lane.y, artSize, 1, flight.team === 'enemy');
      else {
        const direction = flight.team === 'player' ? 1 : -1;
        context.fillStyle = teamColor(flight.team); context.beginPath(); context.moveTo(x + direction * 6, lane.y);
        context.lineTo(x - direction * 5, lane.y - 4); context.lineTo(x - direction * 5, lane.y + 4); context.closePath(); context.fill();
      }
      if (!splitChild) {
        context.fillStyle = teamColor(flight.team); context.globalAlpha = 0.72; context.fillRect(x - 7, lane.y + 8, 14, 1); context.globalAlpha = 1;
      }
    }
    for (const effect of effects) {
      if (effect.kind !== 'projectile_intercepted' || state.tick - effect.tick > 24 || !effect.route || effect.progress === undefined) continue;
      const lane = routes.find((candidate) => candidate.route === effect.route);
      if (!lane) continue;
      const age = Math.max(0, state.tick - effect.tick), size = 14 + age * 0.9;
      const x = laneLeft + laneWidth * effect.progress;
      if (!drawGameArt(context, 'impact', x - size / 2, lane.y - size / 2, size, size, 1 - age / 26)) {
        context.strokeStyle = `rgba(255,214,136,${1 - age / 26})`; context.lineWidth = 2; context.beginPath(); context.arc(x, lane.y, size / 2, 0, Math.PI * 2); context.stroke();
      }
    }
    return;
  }

  function drawCastleMap(state: BattleState, team: TeamId, target: PartId, slot: number, width: number, height: number, top: number, actor: ActorState): void {
    const layout = team === 'player' ? state.layout.home : state.layout.enemy;
    const staticFloor = floorSurface(layout).canvas;
    const mapHeight = Math.max(1, height - top);
    const position = state.fixedActors[actor.id]?.position ?? { x: actor.position.x * 1000 + 500, y: actor.position.y * 1000 + 500 };
    const scale = clamp(width / 32, 7, 15);
    const cameraWorldWidth = width / scale, cameraWorldHeight = mapHeight / scale;
    const cameraX = clamp(position.x / 1000 - cameraWorldWidth / 2, 0, Math.max(0, layout.widthCells - cameraWorldWidth));
    const cameraY = clamp(position.y / 1000 - cameraWorldHeight / 2, 0, Math.max(0, layout.heightCells - cameraWorldHeight));
    const sx = (worldX: number) => (worldX - cameraX) * scale;
    const sy = (worldY: number) => top + (worldY - cameraY) * scale;
    context.save(); context.beginPath(); context.rect(0, top, width, mapHeight); context.clip();
    context.fillStyle = '#111f29'; context.fillRect(0, top, width, mapHeight);
    context.drawImage(staticFloor, -cameraX * scale, top - cameraY * scale,
      layout.widthCells * scale, layout.heightCells * scale);

    for (const room of layout.rooms) {
      const r = room.rect;
      const center = roomCenter(room);
      if (room.kind === 'core') {
        const corePoint = coreWorldPoint(layout) ?? center;
        const cx = sx(corePoint.x), cy = sy(corePoint.y);
        const access = getCoreAccessProjection(state, team);
        drawEquipmentIcon(context, 'core', cx, cy, Math.max(18, scale * 1.5), '#edcd8c');
        context.strokeStyle = access.attackable ? '#f1987d' : '#9ec9df'; context.lineWidth = 1.5;
        context.setLineDash(access.attackable ? [] : [3, 2]); context.beginPath(); context.arc(cx, cy, Math.max(10, scale * 0.92), 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
        context.font = 'bold 8px -apple-system, "Noto Sans JP", sans-serif'; context.textAlign = 'left';
        context.fillStyle = access.attackable ? '#ffc2a9' : '#c4e4f0'; context.strokeStyle = '#142630'; context.lineWidth = 2.5;
        const status = access.attackable ? '攻撃可能' : access.hit ? '核損傷' : `保護中 ${access.openGateCount}/7`;
        context.strokeText(status, cx + Math.max(12, scale * 1.1), cy + 3); context.fillText(status, cx + Math.max(12, scale * 1.1), cy + 3);
        if (state.castles[team].core.hit) {
          drawGameArt(context, 'impact', cx - scale, cy - scale, scale * 2, scale * 2);
        }
      } else if (room.kind === 'repair') {
        drawEquipmentIcon(context, 'repair', sx(center.x), sy(center.y), Math.max(15, scale * 1.15), '#a9d8bc');
      }
      context.font = `${Math.max(8, Math.min(11, scale * 0.78))}px -apple-system, "Noto Sans JP", sans-serif`;
      context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillStyle = '#ecf1e8';
      context.strokeStyle = '#142630'; context.lineWidth = 2.5;
      const label = roomLabels[room.id] ?? room.label;
      const labelY = room.kind === 'core' || room.kind === 'repair' ? r.y0 + 1 : Math.min(r.y1 - 0.7, center.y + 2.2);
      context.strokeText(label, sx(center.x), sy(labelY)); context.fillText(label, sx(center.x), sy(labelY));
    }

    for (const [gateId, gateCells] of Object.entries(layout.gateCells)) {
      const gate = state.castles[team].gates[gateId as keyof typeof state.castles.player.gates];
      if (!gateCells.length) continue;
      const center = gateCells.reduce((sum, cell) => ({ x: sum.x + cell.x, y: sum.y + cell.y }), { x: 0, y: 0 });
      center.x /= gateCells.length; center.y /= gateCells.length;
      const cx = sx(center.x + 0.5), cy = sy(center.y + 0.5);
      if (!gate?.open) {
        // Gate cells become a clear aperture when open. Closed gates are
        // drawn as bars across the actual passage cells only.
        context.strokeStyle = '#efc779'; context.lineWidth = 2;
        context.beginPath();
        for (const cell of gateCells) {
          context.moveTo(sx(cell.x + 0.2), sy(cell.y + 0.5)); context.lineTo(sx(cell.x + 0.8), sy(cell.y + 0.5));
        }
        context.stroke();
      } else {
        context.fillStyle = '#bde6ca'; context.beginPath(); context.arc(cx, cy, 2, 0, Math.PI * 2); context.fill();
      }
      context.globalAlpha = 1;
      context.fillStyle = gate?.open ? '#d1ecd4' : '#fff1cc'; context.font = '8px sans-serif'; context.textAlign = 'center'; context.fillText(gateId, cx, sy(center.y - 0.25));
    }

    const slowZone = state.logistics.slowZones[team];
    if (slowZone && state.tick < slowZone.expiresAtTick) {
      const center = { x: slowZone.center.x / 1000, y: slowZone.center.y / 1000 };
      const x = sx(center.x), y = sy(center.y), radius = slowZone.radiusSubunits / 1000 * scale;
      context.save(); context.fillStyle = '#8dc89e14'; context.strokeStyle = '#a7d9b9aa'; context.lineWidth = 1.5; context.setLineDash([4, 3]);
      context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill(); context.stroke(); context.setLineDash([]);
      const label = `速度 ${Math.round(slowZone.multiplier * 100)}% · ${formatClock(slowZone.expiresAtTick - state.tick, state.rules.ticksPerSecond)}`;
      const labelHalf = Math.min(58, Math.max(0, width / 2 - 2)), labelX = clamp(x, labelHalf, width - labelHalf);
      const labelY = clamp(y + radius + 14, top + 12, height - 22);
      context.font = 'bold 8px -apple-system, "Noto Sans JP", sans-serif'; context.textAlign = 'center'; context.textBaseline = 'bottom';
      context.lineWidth = 2.5; context.strokeStyle = '#11232a'; context.fillStyle = '#c4e8cb';
      context.strokeText(label, labelX, labelY); context.fillText(label, labelX, labelY); context.restore();
    }

    const interaction = state.actors.P1?.alive ? getInteraction(state, 'P1', slot) : undefined;
    const highlighted = interaction?.cases.find((item) => item.id === interaction.pickupCaseId);
    for (const definition of layout.supplyPorts) {
      const runtime = state.logistics.ports[objectKey(team, definition.id)];
      const point = equipmentWorldPoint(state, team, 'supply_port', definition.id) ?? { x: definition.cell.x + 0.5, y: definition.cell.y + 0.5 };
      const cx = point.x, cy = point.y;
      const wx = sx(cx), wy = sy(cy), size = Math.max(15, scale * 1.15);
      drawEquipmentIcon(context, 'supply', wx, wy, size, '#d0d59b');
      drawEquipmentTeamRing(context, wx, wy, size, team);
      drawEquipmentFootprint(context, wx, wy, scale);
      if (runtime) {
        const disabled = equipmentIsDisabledAt(runtime, state.tick);
        drawHealthPips(context, wx, wy + size * 0.48, size * 0.9, runtime.health, state.rules.equipmentHealth, disabled);
        if (disabled || equipmentIsStoppedAt(runtime, state.tick)) {
          context.fillStyle = '#e98f7c'; context.font = 'bold 8px sans-serif'; context.textAlign = 'center'; context.fillText('停止', wx, wy - size * 0.45);
        }
      }
      const interrupted = state.logistics.supplyStops[team]?.disruptedUntilTick ?? 0;
      if (state.tick < interrupted) {
        context.strokeStyle = '#dc8d83'; context.lineWidth = 1.5; context.beginPath(); context.arc(wx, wy, size * 0.72, 0, Math.PI * 2); context.stroke();
        context.fillStyle = '#ffc1a8'; context.font = 'bold 8px sans-serif'; context.textAlign = 'center';
        context.fillText(`妨害 ${formatClock(interrupted - state.tick, state.rules.ticksPerSecond)}`, wx, wy - size * 0.66);
      }
      const label = definition.id.split('_').at(-1)?.toUpperCase() ?? '';
      context.fillStyle = '#f2e6bd'; context.font = '8px sans-serif'; context.textAlign = 'center'; context.fillText(label, wx, wy + size * 0.7);
    }

    for (const definition of layout.turrets) {
      const runtime = state.artillery.turrets[objectKey(team, definition.id)];
      if (!runtime) continue;
      const position = equipmentWorldPoint(state, team, 'turret', definition.id) ?? { x: definition.cell.x + 0.5, y: definition.cell.y + 0.5 };
      const wx = sx(position.x), wy = sy(position.y), size = Math.max(14, scale * 1.05);
      drawEquipmentIcon(context, 'turret', wx, wy, size, teamColor(team), 1, layout.frontDirection < 0);
      drawEquipmentTeamRing(context, wx, wy, size, team);
      drawEquipmentFootprint(context, wx, wy, scale);
      const disabled = equipmentIsDisabledAt(runtime, state.tick);
      drawHealthPips(context, wx, wy + size * 0.46, size * 0.95, runtime.health, state.rules.equipmentHealth, disabled);
      const queued = runtime.queueIds.length;
      context.fillStyle = '#f4f0de'; context.font = '8px sans-serif'; context.textAlign = 'center';
      context.fillText(`${definition.label} ${queued}/${definition.queueCapacity}`, wx, wy - size * 0.54);
      if (disabled || equipmentIsStoppedAt(runtime, state.tick)) {
        context.fillStyle = '#ef968b'; context.font = 'bold 8px sans-serif'; context.fillText('停止', wx, wy + size * 0.75);
      }
      for (const [index, stagedId] of runtime.stagingSlots.entries()) {
        const handoff = runtime.stagingPositions[index as 0 | 1];
        const hx = sx(handoff.x / 1000), hy = sy(handoff.y / 1000);
        const item = stagedId ? state.battleCases[stagedId] : undefined;
        if (item) drawCase(context, item.type, hx, hy, Math.max(10, scale * 0.7));
        else {
          context.strokeStyle = '#86aaa6'; context.lineWidth = 1; context.strokeRect(hx - size * 0.18, hy - size * 0.18, size * 0.36, size * 0.36);
        }
      }
    }

    const floorCases = Object.values(state.battleCases).flatMap((item) => {
      const anchor = floorCaseAnchor(state, item.id);
      return anchor?.area === 'castle' && anchor.team === team ? [{ item, point: anchor.point }] : [];
    });
    for (const { item, point } of floorCases) {
      const cx = sx(point.x), cy = sy(point.y), size = Math.max(9, scale * 0.76);
      drawCase(context, item.type, cx, cy, size);
      if (item.id === highlighted?.id) {
        context.strokeStyle = '#fff0ac'; context.lineWidth = 2; context.strokeRect(cx - size * 0.72, cy - size * 0.72, size * 1.44, size * 1.44);
        context.fillStyle = '#f5f0d9'; context.font = '8px -apple-system, "Noto Sans JP", sans-serif'; context.textAlign = 'center';
        context.fillText(caseLabels[item.type] ?? item.type, cx, cy - size * 0.7 - 3);
      }
    }

    // Queue/handoff items remain visible even when their physical position is
    // represented by a turret slot rather than a case-floor location.
    for (const turret of Object.values(state.artillery.turrets).filter((item) => item.team === team)) {
      const definition = layout.turrets.find((item) => item.id === turret.id);
      if (!definition) continue;
      for (const [index, objectId] of turret.queueIds.entries()) {
        const item = state.battleCases[objectId]; if (!item) continue;
        const point = turretQueueWorldPoint(turret, layout.frontDirection, index);
        const x = sx(point.x), y = sy(point.y); drawCase(context, item.type, x, y, Math.max(7, scale * 0.5));
      }
    }

    const relevantActors = Object.values(state.actors).filter((candidate) => candidate.alive
      ? candidate.location.area === 'castle' && candidate.location.castleTeam === team && actorVisibleToPlayer(state, candidate.id)
      : actorRespawnAnchor(state, candidate.id)?.team === team &&
        (candidate.team === 'player' || observedEnemyDeaths.has(`${candidate.id}:${candidate.generation}`)));
    for (const candidate of relevantActors) {
      const fixed = state.fixedActors[candidate.id]?.position;
      if (!fixed) continue;
      const respawnAnchor = candidate.alive ? undefined : actorRespawnAnchor(state, candidate.id);
      const world = respawnAnchor?.point ?? { x: fixed.x / 1000, y: fixed.y / 1000 };
      const wx = sx(world.x), wy = sy(world.y);
      const dash = state.dashes[candidate.id];
      if (candidate.alive && dash) {
        for (let trail = 1; trail <= 3; trail += 1) {
          const alpha = 0.26 - trail * 0.055;
          const tx = wx - dash.direction.x * scale * trail * 0.45, ty = wy - dash.direction.y * scale * trail * 0.45;
          if (!drawGameArt(context, candidate.id === 'P1' ? 'hero' : candidate.role === 'support' ? 'helper' : 'soldier', tx - scale * 0.45, ty - scale * 0.45, scale * 0.9, scale * 0.9, alpha)) {
            context.fillStyle = `rgba(255,230,172,${alpha})`; context.beginPath(); context.arc(tx, ty, scale * 0.35, 0, Math.PI * 2); context.fill();
          }
        }
      }
      if (candidate.alive) drawPerson(context, candidate, wx, wy, scale, state, candidate.id === 'P1' || candidate.team !== team);
      else if (candidate.respawnAtTick !== null && candidate.respawnAtTick > state.tick && respawnAnchor) {
        const artNameForGhost: GameArtName = candidate.id === 'P1' ? 'hero' : candidate.role === 'support' ? 'helper' : candidate.role === 'shooter' ? 'gunner' : candidate.role === 'shooter_guard' ? 'guard' : candidate.role === 'ammo_carrier' ? 'carrier' : 'soldier';
        if (!drawGameArt(context, artNameForGhost, wx - scale * 0.65, wy - scale * 0.65, scale * 1.3, scale * 1.3, 0.24)) {
          context.strokeStyle = '#bdcbd0'; context.setLineDash([2, 2]); context.beginPath(); context.arc(wx, wy, scale * 0.42, 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
        }
        context.fillStyle = '#ecf1f1'; context.font = '8px sans-serif'; context.textAlign = 'center';
        context.fillText(formatClock(candidate.respawnAtTick - state.tick, state.rules.ticksPerSecond), wx, wy - scale * 0.68);
      }
    }

    // The seven authored exterior parts form the visible front wall. Their
    // health and breakage come straight from the castle state.
    const facadeX = layout.frontDirection > 0 ? 123.6 : 2.4;
    for (let index = 0; index < PART_IDS.length; index += 1) {
      const part = state.castles[team].exterior[PART_IDS[index]];
      const px = sx(facadeX), py = sy(24 + index * 3.5), plateSize = Math.max(8, scale * 0.82);
      context.fillStyle = part.destroyed ? '#293941' : team === 'player' ? '#9bbfaf' : '#c99991';
      context.strokeStyle = part.destroyed ? '#8b9497' : '#263c42'; context.lineWidth = 1;
      context.fillRect(px - plateSize / 2, py - plateSize / 2, plateSize, plateSize * 0.72);
      context.strokeRect(px - plateSize / 2, py - plateSize / 2, plateSize, plateSize * 0.72);
      if (!part.destroyed) drawHealthPips(context, px, py + plateSize * 0.44, plateSize, part.health, part.maxHealth, false);
    }
    for (const effect of effects) {
      const age = state.tick - effect.tick;
      if (age < 0 || age > 22) continue;
      const point = effectPoint(effect, 'castle', team);
      if (point) drawStepEffect(context, effect, sx(point.x), sy(point.y), scale, age);
    }
    for (const task of Object.values(state.repairs.tasks)) {
      const repairingActor = state.actors[task.actorId];
      const fixed = state.fixedActors[task.actorId]?.position;
      if (!repairingActor || repairingActor.location.castleTeam !== team || !fixed) continue;
      const rx = sx(fixed.x / 1000), ry = sy(fixed.y / 1000);
      drawEquipmentIcon(context, 'repair', rx + scale * 0.58, ry - scale * 0.54, Math.max(10, scale * 0.72), '#c3edcb');
      const ratio = clamp((state.tick - task.startedTick) / Math.max(1, task.completesAtTick - task.startedTick), 0, 1);
      context.strokeStyle = '#d8edc8'; context.lineWidth = 1.5; context.beginPath(); context.arc(rx, ry, scale * 0.72, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio); context.stroke();
    }
    for (const task of Object.values(state.repairs.equipmentTasks)) {
      const repairingActor = state.actors[task.actorId], fixed = state.fixedActors[task.actorId]?.position;
      if (!repairingActor || repairingActor.location.castleTeam !== team || !fixed) continue;
      const rx = sx(fixed.x / 1000), ry = sy(fixed.y / 1000);
      drawEquipmentIcon(context, 'repair', rx + scale * 0.55, ry - scale * 0.55, Math.max(10, scale * 0.72), '#c3edcb');
    }
    context.restore();

    // Compact overview preserves navigation context while keeping the active
    // room at a readable scale on narrow canvases.
    const miniWidth = Math.min(98, width * 0.28), miniHeight = miniWidth * layout.heightCells / layout.widthCells;
    const miniX = width - miniWidth - 7, miniY = top + 7;
    context.fillStyle = '#0b1820dd'; context.fillRect(miniX - 3, miniY - 3, miniWidth + 6, miniHeight + 6);
    context.drawImage(staticFloor, miniX, miniY, miniWidth, miniHeight);
    const miniScale = miniWidth / layout.widthCells;
    for (const id of PART_IDS) {
      const partIndex = PART_IDS.indexOf(id), part = state.castles[team].exterior[id];
      context.fillStyle = part.destroyed ? '#45545a' : team === 'player' ? '#b8e2d4' : '#e6b1a9';
      const mx = miniX + (layout.frontDirection > 0 ? 123 : 2) * miniScale;
      context.fillRect(mx - 1.4, miniY + (24 + partIndex * 3.5) * miniScale, 2.5, 2.5);
    }
    for (const candidate of relevantActors) {
      if (!candidate.alive) continue;
      const fixed = state.fixedActors[candidate.id]?.position; if (!fixed) continue;
      context.fillStyle = candidate.team === 'player' ? '#eaffde' : '#ffb3a8'; context.beginPath();
      context.arc(miniX + fixed.x / 1000 * miniScale, miniY + fixed.y / 1000 * miniScale, candidate.id === 'P1' ? 2.4 : 1.25, 0, Math.PI * 2); context.fill();
    }
    context.strokeStyle = '#f5e3a3'; context.lineWidth = 1; context.strokeRect(miniX + cameraX * miniScale, miniY + cameraY * miniScale, cameraWorldWidth * miniScale, cameraWorldHeight * miniScale);
    context.font = '8px sans-serif'; context.fillStyle = '#d9e4e3'; context.textAlign = 'left';
    context.fillText(team === 'player' ? '自陣' : '敵陣', miniX, miniY + miniHeight + 10);

    const currentRoom = actor.currentRoomId === 'plaza' ? '広場' : layout.rooms.find((room) => room.id === actor.currentRoomId)?.label ?? actor.currentRoomId;
    context.fillStyle = '#0d1b24df'; context.fillRect(5, height - 21, Math.min(160, width * 0.52), 16);
    context.fillStyle = '#dbe8e5'; context.font = '9px -apple-system, "Noto Sans JP", sans-serif'; context.textAlign = 'left';
    context.fillText(`${team === 'player' ? '自陣' : '敵陣'} · ${currentRoom} · 門 ${state.castles[team].openGateIds.length}/7`, 10, height - 10);
    void target;
  }

  function drawPlazaMap(state: BattleState, width: number, height: number, top: number, player: ActorState): void {
    const mapHeight = Math.max(1, height - top);
    const p = player.alive && player.location.area === 'plaza'
      ? state.fixedActors[player.id]?.position ?? { x: 63_000, y: 35_000 }
      : { x: 63_000, y: 35_000 };
    const scale = clamp(width / 32, 7, 15);
    const cameraWorldWidth = width / scale, cameraWorldHeight = mapHeight / scale;
    const cameraX = clamp(p.x / 1000 - cameraWorldWidth / 2, 0, Math.max(0, 126 - cameraWorldWidth));
    const cameraY = clamp(p.y / 1000 - cameraWorldHeight / 2, 14, Math.max(14, 56 - cameraWorldHeight));
    const sx = (x: number) => (x - cameraX) * scale;
    const sy = (y: number) => top + (y - cameraY) * scale;
    context.save(); context.beginPath(); context.rect(0, top, width, mapHeight); context.clip();
    context.fillStyle = '#263b40'; context.fillRect(0, top, width, mapHeight);
    const floorImage = getGameArt('floor');
    if (floorImage) {
      const tile = getFloorTextureTile(floorImage);
      for (let y = Math.floor(cameraY); y <= cameraY + cameraWorldHeight; y += 1) {
        for (let x = Math.floor(cameraX); x <= cameraX + cameraWorldWidth; x += 1) {
          context.drawImage(tile, sx(x), sy(y), scale, scale);
        }
      }
    } else {
      context.fillStyle = '#3b5050';
      for (let y = Math.floor(cameraY); y <= cameraY + cameraWorldHeight; y += 1) {
        for (let x = Math.floor(cameraX); x <= cameraX + cameraWorldWidth; x += 1) {
          if ((x + y) % 2 === 0) context.fillRect(sx(x), sy(y), scale, scale);
        }
      }
    }
    const plaza = state.layout.plaza;
    const left = sx(plaza.x0), upper = sy(plaza.y0), w = (plaza.x1 - plaza.x0) * scale, h = (plaza.y1 - plaza.y0) * scale;
    context.fillStyle = '#b1a87c66'; context.fillRect(left, upper, w, h);
    context.strokeStyle = '#e2d8ae88'; context.lineWidth = 1; context.setLineDash([5, 4]);
    context.beginPath(); context.moveTo(sx(63), sy(plaza.y0)); context.lineTo(sx(63), sy(plaza.y1)); context.stroke(); context.setLineDash([]);
    // Facade armor slots are projections of exterior state, not new world
    // entities. Each slot visibly disappears as its matching part is lost.
    drawFortressFacade(context, state, 'player', sx(8.8), sy(35), scale);
    drawFortressFacade(context, state, 'enemy', sx(117.2), sy(35), scale);
    for (const candidate of Object.values(state.actors).filter((actorState) => actorState.location.area === 'plaza' && actorState.alive)) {
      const fixed = state.fixedActors[candidate.id]?.position; if (!fixed) continue;
      const wx = sx(fixed.x / 1000), wy = sy(fixed.y / 1000);
      drawPerson(context, candidate, wx, wy, scale, state, candidate.id === 'P1');
    }
    for (const item of Object.values(state.battleCases)) {
      const anchor = floorCaseAnchor(state, item.id);
      if (anchor?.area !== 'plaza') continue;
      const x = sx(anchor.point.x), y = sy(anchor.point.y), size = Math.max(8, scale * 0.72);
      drawCase(context, item.type, x, y, size);
    }
    for (const effect of effects) {
      const age = state.tick - effect.tick;
      if (age < 0 || age > 23 || effect.kind === 'projectile_intercepted') continue;
      const point = effectPoint(effect, 'plaza');
      if (point) drawStepEffect(context, effect, sx(point.x), sy(point.y), scale, age);
    }
    context.restore();

    // Both fortress states remain available in an overview while the camera
    // keeps plaza combat large enough to read on a phone.
    const miniWidth = Math.min(98, width * 0.28), miniHeight = miniWidth * 70 / 126;
    const miniX = width - miniWidth - 7, miniY = top + 7;
    context.fillStyle = '#0b1820df'; context.fillRect(miniX - 3, miniY - 3, miniWidth + 6, miniHeight + 6);
    context.fillStyle = '#b1a87c'; context.fillRect(miniX, miniY + 20 / 70 * miniHeight, miniWidth, 30 / 70 * miniHeight);
    for (const [team, x] of [['player', 1], ['enemy', 124]] as const) {
      for (const partId of PART_IDS) {
        const index = PART_IDS.indexOf(partId), part = state.castles[team].exterior[partId];
        context.fillStyle = part.destroyed ? '#536166' : team === 'player' ? '#ace0cf' : '#e6b2a9';
        context.fillRect(miniX + (x + (team === 'player' ? index : -index)) / 126 * miniWidth, miniY + 25 / 70 * miniHeight, 2.2, 3);
      }
    }
    for (const candidate of Object.values(state.actors).filter((item) => item.location.area === 'plaza' && item.alive)) {
      const fixed = state.fixedActors[candidate.id]?.position; if (!fixed) continue;
      context.fillStyle = teamColor(candidate.team); context.beginPath();
      context.arc(miniX + fixed.x / 126_000 * miniWidth, miniY + fixed.y / 70_000 * miniHeight, candidate.id === 'P1' ? 2.5 : 1.4, 0, Math.PI * 2); context.fill();
    }
    context.strokeStyle = '#f1e4aa'; context.lineWidth = 1;
    context.strokeRect(miniX + cameraX / 126 * miniWidth, miniY + cameraY / 70 * miniHeight, cameraWorldWidth / 126 * miniWidth, cameraWorldHeight / 70 * miniHeight);
    context.font = '8px sans-serif'; context.textAlign = 'left'; context.fillStyle = '#e1ebe6'; context.fillText('自城', miniX, miniY + miniHeight + 10);
    context.textAlign = 'right'; context.fillText('敵城', miniX + miniWidth, miniY + miniHeight + 10);

    const lastDeath = effects.filter((effect) => effect.actorId === player.id && effect.kind === 'actor_died').at(-1);
    const deathOrigin = lastDeath?.anchor?.area === 'castle'
      ? lastDeath.anchor.team === 'player' ? '自城' : '敵城'
      : lastDeath?.anchor?.area === 'plaza' ? '広場'
        : player.location.area === 'castle' ? player.location.castleTeam === 'player' ? '自城' : '敵城' : '広場';
    const respawnClock = formatClock((player.respawnAtTick ?? state.tick) - state.tick, state.rules.ticksPerSecond);
    const spectator = player.alive ? '' : width < 300
      ? `観戦 · ${deathOrigin} · ${respawnClock}`
      : `観戦 · ${deathOrigin}で撃破 · 復活 ${respawnClock}`;
    const footer = player.alive
      ? `広場 · 自城 ${state.castles.player.openGateIds.length}/7門 · 敵 ${Object.values(state.actors).filter((item) => item.team === 'enemy' && item.alive).length}人`
      : spectator;
    context.fillStyle = '#0d1b24df'; context.fillRect(5, height - 21, Math.min(width - 10, player.alive ? 185 : 218), 16);
    context.font = '9px -apple-system, "Noto Sans JP", sans-serif'; context.fillStyle = '#ecf0de'; context.textAlign = 'left';
    context.fillText(footer, 10, height - 10);
  }

  const render = ((state: BattleState, target: PartId, slot = 0) => {
    observeStep(state);
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingEnabled = true;
    context.fillStyle = '#101c27'; context.fillRect(0, 0, width, height);
    drawFlightLanes(state, width);
    const top = Math.min(52, Math.max(39, width * 0.13));
    const player = state.actors.P1;
    if (!player) return;
    if (!player.alive || player.location.area === 'plaza') drawPlazaMap(state, width, height, top, player);
    else drawCastleMap(state, player.location.castleTeam ?? player.team, target, slot, width, height, top, player);
  }) as BattleRenderer;
  render.observeStep = observeStep;
  return render;
}
