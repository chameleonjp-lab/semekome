import { getInteraction } from '../simulation/battle.ts';
import type { BattleState } from '../simulation/battle.ts';
import type { PartId } from '../domain/types.ts';
import { EQUIPMENT_BODY_SIZE_SUBUNITS } from '../actors/geometry.ts';
import { getHandoffPosition } from '../artillery/positions.ts';

export const caseLabels: Record<string, string> = {
  standard_slug: '標準弾', dense_payload: '重量弾', screen_panel: '防護板', fast_dart: '高速杭',
};
const caseColors: Record<string, string> = {
  standard_slug: '#efce7c', dense_payload: '#e5a574', screen_panel: '#9bbef2', fast_dart: '#e5e9eb',
};

/** Static authored floor is cached; drawing never updates the simulation. */
export function createBattleRenderer(canvas: HTMLCanvasElement, initial: BattleState): (state: BattleState, target: PartId, slot?: number) => void {
  const context = canvas.getContext('2d')!;
  const floor = document.createElement('canvas');
  const unit = 10;
  floor.width = 126 * unit; floor.height = 70 * unit;
  const staticContext = floor.getContext('2d')!;
  const layout = initial.layout.home;
  staticContext.fillStyle = '#172c37';
  for (const cell of layout.floorCells) staticContext.fillRect(cell.x * unit, cell.y * unit, unit, unit);
  for (const room of layout.rooms) {
    const r = room.rect;
    staticContext.fillStyle = room.kind === 'supply' ? '#334944' : room.kind === 'battery' ? '#36414e' : '#263c47';
    staticContext.fillRect(r.x0 * unit + 1, r.y0 * unit + 1, (r.x1 - r.x0) * unit - 2, (r.y1 - r.y0) * unit - 2);
  }
  // Draw only actual floor boundaries, leaving authored door passages open.
  const cells = new Set(layout.floorCells.map(cell => `${cell.x},${cell.y}`));
  staticContext.strokeStyle = '#71868b'; staticContext.lineWidth = 1;
  staticContext.beginPath();
  for (const cell of layout.floorCells) {
    for (const [dx, dy, ax, ay, bx, by] of [[-1, 0, 0, 0, 0, 1], [1, 0, 1, 0, 1, 1], [0, -1, 0, 0, 1, 0], [0, 1, 0, 1, 1, 1]]) {
      if (cells.has(`${cell.x + dx},${cell.y + dy}`)) continue;
      staticContext.moveTo((cell.x + ax) * unit, (cell.y + ay) * unit);
      staticContext.lineTo((cell.x + bx) * unit, (cell.y + by) * unit);
    }
  }
  staticContext.stroke();
  return (state, target, slot = 0) => {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#101c27'; context.fillRect(0, 0, width, height);

    // Two separate lanes: the visual x coordinate is always home-left / enemy-right.
    const laneWidth = Math.max(1, width - 84);
    context.font = '10px -apple-system, "Noto Sans JP", sans-serif';
    context.textAlign = 'left'; context.fillStyle = '#b9cdd6';
    context.fillText('自陣', 8, 15); context.textAlign = 'right'; context.fillText('敵陣', width - 8, 15);
    for (const [route, y, label] of [['direct', 15, '直通'], ['detour', 35, '迂回']] as const) {
      context.strokeStyle = '#405661'; context.beginPath(); context.moveTo(42, y); context.lineTo(width - 42, y); context.stroke();
      context.textAlign = 'left'; context.fillStyle = '#9eb1bc'; context.fillText(label, 8, y + (route === 'direct' ? 15 : 10));
      for (const flight of Object.values(state.artillery.flights)) {
        if (flight.route !== route) continue;
        const x = 42 + laneWidth * (flight.team === 'player' ? flight.progress : 1 - flight.progress);
        context.fillStyle = flight.team === 'player' ? '#b8ece0' : '#efb3a8';
        const direction = flight.team === 'player' ? 1 : -1;
        context.beginPath(); context.moveTo(x + direction * 5, y); context.lineTo(x - direction * 4, y - 4); context.lineTo(x - direction * 4, y + 4); context.closePath(); context.fill();
      }
    }

    const top = 55, mapHeight = height - top;
    const position = state.fixedActors.P1.position;
    const interaction = getInteraction(state, 'P1', slot);
    const scale = Math.max(7, Math.min(width / 32, 15));
    const cameraX = position.x / 1000 - width / scale / 2;
    const cameraY = position.y / 1000 - mapHeight / scale / 2;
    const x = (value: number) => (value - cameraX) * scale;
    const y = (value: number) => top + (value - cameraY) * scale;
    context.save(); context.beginPath(); context.rect(0, top, width, mapHeight); context.clip();
    context.drawImage(floor, -cameraX * scale, top - cameraY * scale, 126 * scale, 70 * scale);
    for (const room of layout.rooms) {
      if (room.label === room.id) continue;
      context.font = '11px -apple-system, "Noto Sans JP", sans-serif'; context.textAlign = 'center'; context.fillStyle = '#d6e0df';
      context.fillText(room.label, x((room.rect.x0 + room.rect.x1) / 2), y(room.rect.y0 + 1.4));
    }
    for (const [id, cells] of Object.entries(layout.gateCells)) {
      context.fillStyle = state.castles.player.gates[id as keyof typeof state.castles.player.gates].open ? '#73b7a755' : '#d5a665';
      for (const cell of cells) context.fillRect(x(cell.x), y(cell.y), scale, scale);
    }
    for (const port of layout.supplyPorts) {
      const size = EQUIPMENT_BODY_SIZE_SUBUNITS / 1000;
      const inset = (1 - size) / 2;
      context.fillStyle = '#d2bf79'; context.fillRect(x(port.cell.x + inset), y(port.cell.y + inset), scale * size, scale * size);
      context.textAlign = 'center'; context.fillStyle = '#ecdfb7'; context.fillText('補給', x(port.cell.x + .5), y(port.cell.y - .7));
    }
    for (const turret of layout.turrets) {
      const liveTurret = state.artillery.turrets[`player:${turret.id}`];
      if (liveTurret) for (const slot of [0, 1] as const) {
        const point = getHandoffPosition(liveTurret, slot);
        const frameSize = Math.max(4, scale * .45);
        context.strokeStyle = '#799b99'; context.lineWidth = 1;
        context.strokeRect(x(point.x / 1000) - frameSize / 2, y(point.y / 1000) - frameSize / 2, frameSize, frameSize);
      }
      const size = EQUIPMENT_BODY_SIZE_SUBUNITS / 1000;
      const inset = (1 - size) / 2;
      context.fillStyle = '#80b9b1'; context.fillRect(x(turret.cell.x + inset), y(turret.cell.y + inset), scale * size, scale * size);
      // The barrel is decorative; the physical body uses the shared geometry size.
      context.fillRect(x(turret.cell.x + .5), y(turret.cell.y + .4), scale * .85, scale * .2);
      const distance = Math.hypot(position.x - (turret.cell.x * 1000 + 500), position.y - (turret.cell.y * 1000 + 500));
      if (distance <= 800 && (interaction.handles.includes('deliver') || interaction.handles.includes('load'))) {
        context.strokeStyle = '#fff4b0'; context.lineWidth = 2;
        context.strokeRect(x(turret.cell.x) - 3, y(turret.cell.y) - 3, scale + 6, scale + 6);
      }
      const queued = Object.values(state.objects).filter(object => object.location.kind === 'queue' && object.location.team === 'player' && object.location.turretId === turret.id).length;
      context.fillStyle = '#c7e8e1'; context.textAlign = 'center'; context.fillText(`${turret.label} ${queued}/2`, x(turret.cell.x + .5), y(turret.cell.y - .7));
    }
    const highlighted = interaction.handles.includes('pickup') && !interaction.handles.includes('deliver') && !interaction.handles.includes('load')
      ? interaction.cases.find(item => item.id === interaction.pickupCaseId) : undefined;
    for (const item of Object.values(state.battleCases)) {
      const object = state.objects[item.id];
      if (!item.currentPosition || object?.location.kind !== 'floor' || object.location.team !== 'player') continue;
      const p = item.currentPosition;
      context.fillStyle = caseColors[item.type] ?? '#eddaae';
      const size = Math.max(5, scale * .65);
      const cx = x(p.x / 1000), cy = y(p.y / 1000);
      context.beginPath();
      if (item.type === 'dense_payload') {
        context.moveTo(cx, cy - size / 2); context.lineTo(cx + size / 2, cy);
        context.lineTo(cx, cy + size / 2); context.lineTo(cx - size / 2, cy); context.closePath();
      } else if (item.type === 'fast_dart') {
        context.moveTo(cx + size / 2, cy); context.lineTo(cx - size / 2, cy - size / 2);
        context.lineTo(cx - size / 2, cy + size / 2); context.closePath();
      } else if (item.type === 'screen_panel') context.rect(cx - size * .6, cy - size * .25, size * 1.2, size * .5);
      else context.rect(cx - size / 2, cy - size / 2, size, size);
      context.fill(); context.strokeStyle = '#142631'; context.lineWidth = 1; context.stroke();
      if (item.id === highlighted?.id) {
        // Name only the actionable case; sixteen stacked labels obscure the
        // supply floor. All four types remain distinguishable by silhouette.
        context.textAlign = 'center'; context.font = '10px -apple-system, "Noto Sans JP", sans-serif'; context.fillStyle = '#f2efdb';
        context.fillText(caseLabels[item.type], cx, cy - size / 2 - 6);
        context.strokeStyle = '#fff4b0'; context.lineWidth = 2;
        context.strokeRect(x(p.x / 1000) - size / 2 - 3, y(p.y / 1000) - size / 2 - 3, size + 6, size + 6);
      }
    }
    for (const actor of Object.values(state.actors)) {
      if (actor.location.castleTeam !== 'player' || !actor.alive) continue;
      const p = state.fixedActors[actor.id].position;
      context.beginPath(); context.arc(x(p.x / 1000), y(p.y / 1000), actor.id === 'P1' ? 7 : 5, 0, Math.PI * 2);
      context.fillStyle = actor.id === 'P1' ? '#fff1b2' : '#a5d4c9'; context.fill();
      context.strokeStyle = '#142631'; context.lineWidth = 2; context.stroke();
      context.fillStyle = '#edf6f4'; context.font = '10px -apple-system, "Noto Sans JP", sans-serif'; context.textAlign = 'center';
      context.fillText(actor.id === 'P1' ? 'あなた' : '補助員', x(p.x / 1000), y(p.y / 1000) - 12);
    }
    context.restore();
    // Overview gives navigation context without moving or recreating actors.
    const miniWidth = 100, miniHeight = 56, miniX = width - miniWidth - 8, miniY = top + 8;
    context.fillStyle = '#101c27e8'; context.fillRect(miniX - 3, miniY - 3, miniWidth + 6, miniHeight + 6);
    context.drawImage(floor, miniX, miniY, miniWidth, miniHeight);
    context.fillStyle = '#ead398'; context.font = '8px sans-serif'; context.textAlign = 'center';
    layout.supplyPorts.forEach((port, index) => context.fillText(String.fromCharCode(65 + index), miniX + (port.cell.x + .5) / 126 * miniWidth, miniY + (port.cell.y + .5) / 70 * miniHeight));
    context.fillStyle = '#fff1b2'; context.beginPath(); context.arc(miniX + position.x / 126000 * miniWidth, miniY + position.y / 70000 * miniHeight, 3, 0, Math.PI * 2); context.fill();
    context.textAlign = 'left'; context.fillStyle = '#a8bfc9'; context.font = '10px -apple-system, "Noto Sans JP", sans-serif';
    context.fillText(`敵外装 ${target} を狙う`, 8, height - 8);
  };
}
