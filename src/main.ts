import blueprint from '../docs/plans/current/INTERIOR_LAYOUTS.json' with { type: 'json' };
import roster from '../docs/plans/current/ENEMY_ROSTER.json' with { type: 'json' };
import './presentation/style.css';
import { createWorld } from './simulation/world.ts';
import { openBattleSetup } from './presentation/battle-screen.ts';

type Area = 'player' | 'plaza' | 'enemy';
type Rect = readonly number[];
const app = document.querySelector<HTMLElement>('#app')!;
const ns = 'http://www.w3.org/2000/svg';
const labels: Record<Area, string> = { player: '自陣', plaza: '広場', enemy: '敵陣' };
const roleLabels: Record<string, string> = { shooter: '射手', shooter_guard: '護衛', ammo_carrier: '運び手', internal_soldier: '内部兵' };
const descriptions: Record<string, string> = {
  core: '7つの門を開いた後、核への有効な一撃で勝敗が決まります。',
  respawn: '主人公は倒れてから5秒後、ここで復活します。核室とは別の部屋です。',
  central_corridor: '正面の出入口と各部屋をつなぎます。敵陣へ向かうには広場を通ります。',
  repair: '運んだ弾を使い、壊れていない外装や設備を修理する場所です。',
  command: '補助員へ仕事を任せるための部屋です。',
};
// The preview retains one initial world. Changing the camera never steps or recreates it.
const previewWorld = createWorld({ matchId: 'r1-layout-preview', seed: 1 });
let area: Area = 'player';
let selectedRoom = 'central_corridor';
let view = { x: 40, y: 7, w: 90, h: 55 };
let disposePreview = () => {};

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function home(): void {
  disposePreview();
  app.innerHTML = `
    <section class="home" aria-label="ホーム">
      <div class="home-intro"><p class="eyebrow">城内作業と砲撃のゲーム</p><h1>セメコメ</h1>
      <p class="home-copy">弾を運んで撃ち合い、<br>7つの門を開いて、敵の核へ。</p></div>
      <svg class="home-art" viewBox="0 0 460 145" aria-label="左の自陣と右の敵陣が広場を挟んで向かい合う" role="img">
        <path d="M124 37 Q230 -1 336 37 M336 56 Q230 18 124 56" fill="none" stroke="#5b7684" stroke-width="2" stroke-dasharray="5 6"/>
        <rect x="21" y="43" width="130" height="66" rx="9" fill="#87bdaf"/>
        <path d="M28 46V34H45V46M63 46V34H80V46M98 46V34H115V46" fill="#87bdaf"/>
        <path d="M138 68H163V81H138" fill="#b5e0d1"/>
        <rect x="309" y="43" width="130" height="66" rx="9" fill="#c28d85"/>
        <path d="M323 46V34H340V46M358 46V34H375V46M393 46V34H410V46" fill="#c28d85"/>
        <path d="M322 68H297V81H322" fill="#e4b9b0"/>
        <path d="M178 98H282" stroke="#cfbd8d" stroke-width="3"/>
        <text x="86" y="136" text-anchor="middle">自陣</text><text x="230" y="136" text-anchor="middle">広場</text><text x="374" y="136" text-anchor="middle">敵陣</text>
      </svg>
      <div class="home-actions"><button class="primary" id="open-battle">運搬・砲撃・修理を試す</button><button id="open-preview">配置を確認する</button><button id="open-rules">ルール説明</button></div>
      <p class="home-notice">運搬・砲撃・外装修理の操作確認版です。<br>核攻撃までの通常対戦はまだ遊べません。</p>
    </section>
    <dialog aria-labelledby="rules-title"><div class="dialog-head"><h2 id="rules-title">セメコメのルール</h2><button id="close-rules">閉じる</button></div>
      <div class="rules-body"><ol>
        <li><strong>弾を運び、砲台から撃つ</strong><br>弾を攻撃に使うか、迎撃や修理に使うかを選びます。補助員にも仕事を任せられます。</li>
        <li><strong>外装7部位を壊して門を開く</strong><br>敵城の外装を1部位壊すごとに、核へ続く門が1つ開きます。</li>
        <li><strong>広場を突破し、核を攻撃する</strong><br>広場の敵を倒して敵陣へ。7つの門がすべて開いてから、核へ突進を当てると勝利します。自陣の核を同じ条件で攻撃されると敗北します。</li>
      </ol><p class="rules-note">敵は30人。それぞれ倒されてから20秒後に復活します。主人公は5秒間、進行中の戦場を見た後に自陣で復活します。<br><br>外装をすべて壊しただけでは決着しません。</p></div>
    </dialog>`;
  document.querySelector('#open-preview')!.addEventListener('click', preview);
  document.querySelector('#open-battle')!.addEventListener('click', () => { disposePreview(); disposePreview = openBattleSetup(app, home); });
  const dialog = document.querySelector('dialog')!;
  document.querySelector('#open-rules')!.addEventListener('click', () => dialog.showModal());
  document.querySelector('#close-rules')!.addEventListener('click', () => dialog.close());
}

function teamCard(team: 'player' | 'enemy'): string {
  return `<div class="team-card ${team === 'enemy' ? 'enemy' : ''}"><div class="team-title"><strong>${labels[team]}</strong><span>${team === 'enemy' ? '敵30人' : '主人公＋補助員2人'}</span></div><div class="armor" aria-label="外装7部位、すべて健全">${'<span></span>'.repeat(7)}</div><p class="gate-status">外装 0/7 破壊 · 門 0/7 開放</p></div>`;
}

function preview(): void {
  area = 'player';
  selectedRoom = 'central_corridor';
  app.innerHTML = `<section class="preview" aria-label="配置確認">
    <header class="masthead"><div><h1>セメコメ</h1><p class="eyebrow">配置確認版</p></div><button id="go-home">ホーム</button></header>
    <div class="teams">${teamCard('player')}${teamCard('enemy')}</div>
    <nav class="area-tabs" aria-label="表示する場所">${(['player','plaza','enemy'] as const).map(a => `<button data-area="${a}" aria-pressed="${a === area}">${labels[a]}</button>`).join('')}</nav>
    <div class="map-wrap"><svg class="map-viewport" role="img" tabindex="0" aria-label="自陣の配置。矢印キーまたはドラッグで表示範囲を動かせます。"></svg><p class="map-caption"></p></div>
    <div class="map-tools"><p class="map-hint">ドラッグで見渡す</p><div class="zoom-tools"><button id="zoom-out" aria-label="縮小">−</button><button id="zoom-reset">全体</button><button id="zoom-in" aria-label="拡大">＋</button></div></div>
    <section class="room-info" aria-label="部屋の説明"><label for="room-select">見たい場所</label><select id="room-select"></select><p class="room-detail" aria-live="polite"></p></section>
  </section>`;
  const svg = document.querySelector<SVGSVGElement>('.map-viewport')!;
  const select = document.querySelector<HTMLSelectElement>('#room-select')!;
  const observer = new ResizeObserver(() => { view.h = view.w * svg.clientHeight / Math.max(1, svg.clientWidth); updateView(svg); });
  observer.observe(svg);
  const cleanups: Array<() => void> = [];
  disposePreview = () => { observer.disconnect(); cleanups.forEach(fn => fn()); };
  document.querySelector('#go-home')!.addEventListener('click', home);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-area]')) {
    button.addEventListener('click', () => {
      area = button.dataset.area as Area;
      selectedRoom = 'central_corridor';
      populateRooms(select); draw(svg); focusRoom(svg); updateInfo();
      for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-area]')) tab.setAttribute('aria-pressed', String(tab.dataset.area === area));
    });
  }
  select.addEventListener('change', () => { selectedRoom = select.value; draw(svg); focusRoom(svg); updateInfo(); });
  document.querySelector('#zoom-in')!.addEventListener('click', () => zoom(svg, .72));
  document.querySelector('#zoom-out')!.addEventListener('click', () => zoom(svg, 1.4));
  document.querySelector('#zoom-reset')!.addEventListener('click', () => {
    const ratio = svg.clientHeight / Math.max(1, svg.clientWidth);
    view = { x: -2, y: -2, w: Math.max(130, 74 / ratio), h: Math.max(130 * ratio, 74) };
    view.x = (126 - view.w) / 2; view.y = (70 - view.h) / 2; updateView(svg);
  });
  let drag: { id: number; x: number; y: number } | null = null;
  svg.addEventListener('pointerdown', e => { if (drag !== null || (e.pointerType === 'mouse' && e.button !== 0)) return; drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); });
  svg.addEventListener('pointermove', e => {
    if (drag?.id !== e.pointerId) return;
    view.x -= (e.clientX - drag.x) * view.w / Math.max(1, svg.clientWidth);
    view.y -= (e.clientY - drag.y) * view.h / Math.max(1, svg.clientHeight);
    drag.x = e.clientX; drag.y = e.clientY; updateView(svg);
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) svg.addEventListener(event, e => { if (drag?.id === e.pointerId) drag = null; });
  const clearDrag = () => { if (drag && svg.hasPointerCapture(drag.id)) svg.releasePointerCapture(drag.id); drag = null; };
  window.addEventListener('blur', clearDrag); document.addEventListener('visibilitychange', clearDrag);
  cleanups.push(() => window.removeEventListener('blur', clearDrag), () => document.removeEventListener('visibilitychange', clearDrag));
  svg.addEventListener('keydown', e => {
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-6,0], ArrowRight: [6,0], ArrowUp: [0,-6], ArrowDown: [0,6] };
    if (!offsets[e.key]) return;
    e.preventDefault(); view.x += offsets[e.key][0]; view.y += offsets[e.key][1]; updateView(svg);
  });
  populateRooms(select); draw(svg); focusRoom(svg); updateInfo();
}

function populateRooms(select: HTMLSelectElement): void {
  select.replaceChildren();
  if (area === 'plaza') { select.append(new Option('広場と両城', 'central_corridor')); }
  else for (const room of blueprint.rooms) select.append(new Option(room.label_ja, room.id));
  select.value = selectedRoom;
}

function displayRect(rect: Rect): number[] {
  return area === 'enemy' ? [126 - rect[2], rect[1], 126 - rect[0], rect[3]] : [...rect];
}

function focusRoom(svg: SVGSVGElement): void {
  const room = blueprint.rooms.find(r => r.id === selectedRoom)!;
  const rect = displayRect(room.rect_cells);
  const cx = area === 'plaza' ? 63 : (rect[0]+rect[2])/2;
  const cy = area === 'plaza' ? 35 : (rect[1]+rect[3])/2;
  view.w = area === 'plaza' ? 132 : 70;
  view.h = view.w * svg.clientHeight / Math.max(1, svg.clientWidth);
  view.x = cx-view.w/2; view.y = cy-view.h/2; updateView(svg);
}

function zoom(svg: SVGSVGElement, factor: number): void {
  const cx=view.x+view.w/2, cy=view.y+view.h/2;
  view.w=Math.min(220, Math.max(30, view.w*factor));
  view.h=view.w*svg.clientHeight/Math.max(1, svg.clientWidth);
  view.x=cx-view.w/2; view.y=cy-view.h/2; updateView(svg);
}

function updateView(svg: SVGSVGElement): void {
  view.x = Math.max(-view.w*.7, Math.min(126-view.w*.3, view.x));
  view.y = Math.max(-view.h*.7, Math.min(70-view.h*.3, view.y));
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
}

function draw(svg: SVGSVGElement): void {
  svg.replaceChildren();
  svg.setAttribute('aria-label', `${labels[area]}の配置。矢印キーまたはドラッグで表示範囲を動かせます。`);
  document.querySelector('.map-caption')!.textContent = area === 'player' ? '自陣の正面 → 広場' : area === 'enemy' ? '広場 ← 敵陣の正面' : '自陣 → 広場 ← 敵陣';
  if (area === 'plaza') {
    svg.append(el('rect', {x:25,y:22,width:76,height:40,rx:3,fill:'#c9bc93'}));
    svg.append(el('rect', {x:2,y:22,width:21,height:40,rx:2,fill:'#8fbdad'}), el('rect', {x:103,y:22,width:21,height:40,rx:2,fill:'#c39791'}));
    svg.append(el('path', {d:'M17 22 Q63 -3 109 22 M17 17 Q63 -16 109 17',fill:'none',stroke:'#90acbb','stroke-width':.8,'stroke-dasharray':'2 2'}));
    for (const [x,label] of [[12,'自城'],[63,'広場'],[114,'敵城']] as const) svg.append(el('text',{x,y:42,'text-anchor':'middle',fill:'#14303b','font-size':4},label));
    svg.append(el('text',{x:63,y:8,'text-anchor':'middle',fill:'#cbdde4','font-size':3},'上空で砲撃'));
    return;
  }
  // Rooms and all connecting floor rectangles come from the same versioned plan.
  svg.append(el('rect', {x:0,y:0,width:126,height:70,rx:2,fill: area === 'enemy' ? '#4d424b' : '#344b56'}));
  for (const passage of [...blueprint.corridor_geometry, ...blueprint.passages]) {
    const r = displayRect(passage.rect_cells);
    svg.append(el('rect',{x:r[0],y:r[1],width:r[2]-r[0],height:r[3]-r[1],fill:'#a9bac0'}));
  }
  for (const room of blueprint.rooms) {
    const r=displayRect(room.rect_cells);
    const color=({core:'#edcd8c',respawn:'#c5b7d4',battery:'#b0cad1',supply:'#c7d0ad',repair:'#b5c7c1',command:'#b4c3da',corridor:'#d3ddd8'} as Record<string,string>)[room.kind] ?? '#ccd4cf';
    svg.append(el('rect',{x:r[0],y:r[1],width:r[2]-r[0],height:r[3]-r[1],fill:color,class:`room-floor ${room.id===selectedRoom?'selected-room':''}`,'data-room':room.id}));
    svg.append(el('text',{x:(r[0]+r[2])/2,y:r[3]-2,'text-anchor':'middle','font-size':room.id==='central_corridor'?3:2.25,class:'room-label'},room.label_ja));
  }
  for (const link of blueprint.links.filter(link => link.gate_id)) {
    const passage = blueprint.passages.find(p => (p.a === link.a && p.b === link.b) || (p.a === link.b && p.b === link.a))!;
    const r = displayRect(passage.rect_cells);
    const x = (r[0] + r[2]) / 2;
    svg.append(el('rect',{x:r[0],y:r[1],width:r[2]-r[0],height:r[3]-r[1],fill:'#e0bb75','data-gate':link.gate_id!}));
    svg.append(el('text',{x,y:r[1]-1.5,'text-anchor':'middle','font-size':1.9,fill:'#f0d4a0'},`門${link.gate_id!.slice(1)}`));
  }
  const entry=blueprint.front_entry.cell;
  svg.append(el('text',{x:area==='enemy'?126-entry[0]:entry[0],y:entry[1],'text-anchor':'middle','font-size':3,fill:'#123342'},area==='enemy'?'←':'→'));
  const castleLayout = area === 'enemy' ? previewWorld.layout.enemy : previewWorld.layout.home;
  for (const room of castleLayout.rooms) for (const pad of room.recoveryPads) {
    if (!previewWorld.actors[pad.actorId]) continue;
    svg.append(el('rect',{x:pad.cell.x-.6,y:pad.cell.y-.6,width:2.2,height:2.2,rx:.35,fill:'none',stroke:'#edf9f0','stroke-width':.22,'stroke-dasharray':'.35 .25','data-recovery-pad':pad.id}));
  }
  for (const actor of Object.values(previewWorld.actors).filter(a => a.team === area)) {
    const x=actor.position.x+.5, y=actor.position.y+.5;
    const fill=area==='enemy'?'#633c40':'#214e51';
    let marker: SVGElement;
    if(actor.role==='shooter') marker=el('polygon',{points:`${x},${y-1.2} ${x+1.2},${y} ${x},${y+1.2} ${x-1.2},${y}`,fill});
    else if(actor.role==='shooter_guard') marker=el('circle',{cx:x,cy:y,r:1.1,fill});
    else if(actor.role==='internal_soldier') marker=el('polygon',{points:`${x},${y-1.2} ${x+1.1},${y+1} ${x-1.1},${y+1}`,fill});
    else marker=el('rect',{x:x-1,y:y-1,width:2,height:2,rx:actor.role==='player'?.8:.1,fill});
    marker.setAttribute('data-actor-id',actor.id); marker.setAttribute('data-role',actor.role);
    marker.append(el('title',{},`${actor.id} ${roleLabels[actor.role] ?? (actor.role==='player'?'主人公':'補助員')}`)); svg.append(marker);
  }
  for (const turret of blueprint.turrets) {
    const equipment = turret as typeof turret & { cell?: number[] };
    if (!equipment.cell) continue;
    const x=area==='enemy'?125-equipment.cell[0]+.5:equipment.cell[0]+.5, y=equipment.cell[1]+.5;
    const g=el('g',{'data-turret':turret.id});
    g.append(el('rect',{x:x-1.2,y:y-1.2,width:2.4,height:2.4,rx:.4,fill:'#385462'}));
    g.append(el('path',{d:`M${x} ${y} h${area==='enemy'?-2.5:2.5}`,stroke:'#233e4b','stroke-width':1.2}));
    g.append(el('title',{},turret.label_ja));svg.append(g);
  }
  for (const port of blueprint.supply_ports) {
    const equipment = port as typeof port & { cell?: number[] };
    if (!equipment.cell) continue;
    const x=area==='enemy'?125-equipment.cell[0]+.5:equipment.cell[0]+.5,y=equipment.cell[1]+.5;
    const g=el('g',{'data-supply-port':port.id});
    g.append(el('rect',{x:x-1.2,y:y-1.2,width:2.4,height:2.4,fill:'#566648'}));
    g.append(el('path',{d:`M${x-1} ${y} h2 M${x} ${y-1} v2`,stroke:'#d7e5ba','stroke-width':.35}));
    g.append(el('title',{},'補給口'));svg.append(g);
  }

}

function updateInfo(): void {
  const detail=document.querySelector('.room-detail')!;
  if (area==='plaza') { detail.textContent='敵を倒して広場を突破すると、敵陣の通常室へ進めます。上空では両城の砲撃が行き交います。'; return; }
  const room=blueprint.rooms.find(r=>r.id===selectedRoom)!;
  const defaultText=room.kind==='battery'?'運んだ弾を装填し、上空へ砲撃する部屋です。':'砲撃や修理に使う弾を補給する部屋です。';
  let description=descriptions[room.id] ?? defaultText;
  if(area==='enemy'&&room.id==='respawn') description='核室とは別の後方の部屋です。敵30人は、それぞれの担当室で復活します。';
  if(area==='enemy') {
    const members=roster.members.filter(m=>m.home_room_id===room.id);
    if(members.length) {
      const counts=new Map<string,number>(); for(const m of members) counts.set(m.role,(counts.get(m.role)??0)+1);
      description+=` 配置：${[...counts].map(([role,count])=>`${roleLabels[role]}${count}人`).join('、')}。`;
    }
  }
  detail.textContent=description;
}

home();
