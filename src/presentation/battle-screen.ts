import { createBattle, getInteraction, pauseBattle, resumeBattle, setBattleVisibility, stepBattle } from '../simulation/physical-battle.ts';
import type { BattleHandle, BattleIntent, BattleRoute } from '../simulation/physical-battle.ts';
import { PART_IDS } from '../domain/types.ts';
import type { PartId } from '../domain/types.ts';
import { bindMovement } from '../input/battle-input.ts';
import { SessionClock, validatePlayerName } from '../input/session-clock.ts';
import { caseLabels, createBattleRenderer } from './battle-renderer.ts';
import './battle.css';

const actionLabels: Record<BattleHandle, string> = {
  pickup: '弾を拾う', drop: '弾を置く', deliver: '砲台へ渡す', load: '砲台へ装填', launch: '砲撃する', intercept: '迎撃する',
};

export function openBattleSetup(app: HTMLElement, goHome: () => void): () => void {
  let disposeBattle = () => {};
  let started = false;
  app.innerHTML = `<section class="battle-setup" aria-label="名前入力"><p class="eyebrow">運搬・砲撃の操作確認版</p>
    <h1>出撃の準備</h1><p>弾薬庫で弾を拾い、隣の砲台へ運びます。<br>補助員と敵も、同じ戦場で作業します。</p>
    <form novalidate><label for="player-name">あなたの名前</label><input id="player-name" name="playerName" autocomplete="nickname" aria-describedby="name-hint name-error" placeholder="1〜20文字" required>
    <p id="name-hint">前後の空白は取り除きます。名前の外部送信は行いません。</p><p id="name-error" role="alert"></p>
    <button type="submit" class="primary">確認を開始する</button><button type="button" id="cancel-setup">ホームへ戻る</button></form>
    <p class="scope-note">今回は運搬・砲撃まで。広場の戦い・敵陣への侵入・核攻撃・結果とランキングは未実装です。</p></section>`;
  const input = app.querySelector<HTMLInputElement>('#player-name')!;
  app.querySelector('#cancel-setup')!.addEventListener('click', goHome);
  app.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault();
    if (started) return;
    const validation = validatePlayerName(input.value);
    app.querySelector('#name-error')!.textContent = validation.error ?? '';
    input.setAttribute('aria-invalid', String(Boolean(validation.error)));
    if (validation.error) { input.focus(); return; }
    started = true;
    disposeBattle = mountBattle(app, validation.name, goHome);
  });
  return () => disposeBattle();
}

function mountBattle(app: HTMLElement, name: string, goHome: () => void): () => void {
  const random = new Uint32Array(1); crypto.getRandomValues(random);
  let state = createBattle({ matchId: crypto.randomUUID(), seed: random[0] });
  let countdown = 180;
  let paused = false;
  let disposed = false;
  let slot = 0;
  let route: BattleRoute = 'direct';
  let part: PartId = 'P1';
  let pending: BattleIntent | undefined;
  let frame = 0;
  let playerOperatedLaunches = 0;
  const clock = new SessionClock();
  const events = new AbortController();
  const options = { signal: events.signal };
  app.innerHTML = `<section class="battle" aria-label="運搬と砲撃"><header class="battle-header"><div><strong class="player-label"></strong><span class="battle-stage">運搬・砲撃の確認</span></div><output class="battle-time" aria-label="経過時間">0:00</output><button id="pause-battle">一時停止</button></header>
    <div class="battle-armor" aria-label="両城の外装">${(['player', 'enemy'] as const).map(team => `<div data-team="${team}"><span>${team === 'player' ? '自陣' : '敵陣'}</span><div class="armor">${PART_IDS.map(id => `<span data-part="${id}"></span>`).join('')}</div><output class="battle-gates"></output></div>`).join('')}</div>
    <div class="battle-map"><canvas aria-label="あなたを中心とした自陣の城内と、直通・迂回の砲撃経路"></canvas><span class="current-room"></span></div>
    <p class="battle-hint" aria-live="polite">上の弾薬庫Aへ。弾の近くで「弾を拾う」。</p>
    <div class="cargo-controls" aria-label="所持する弾"><button data-slot="0" aria-pressed="true">左：空</button><button data-slot="1" aria-pressed="false">右：空</button></div>
    <div class="battle-controls"><div class="movement-pad" role="group" aria-label="移動パッド。中心から動きたい方向へ指をずらす"><span class="pad-up">↑</span><span class="pad-left">←</span><i></i><span class="pad-right">→</span><span class="pad-down">↓</span></div><div class="action-controls"><button id="battle-action" class="primary" disabled>弾に近づく</button><button id="battle-drop" disabled>選択中の弾を置く</button></div></div>
    <div class="battle-settings"><button id="route-toggle">経路：直通</button><label class="target-control">狙う部位<select id="target-part">${PART_IDS.map(id => `<option value="${id}">敵外装 ${id}</option>`).join('')}</select></label><button id="battle-help" aria-label="操作説明">?</button></div>
    <div class="battle-overlay" role="dialog" aria-modal="true" aria-labelledby="overlay-title"><div><p id="overlay-title" class="overlay-title" role="status">開始まで</p><strong class="countdown-number">3</strong><p class="overlay-description">左のパッドで移動・右のボタンで弾を扱う</p><button id="resume-battle" class="primary" hidden>再開する</button><button id="leave-battle">準備を中止する</button></div></div>
    <dialog class="battle-help-dialog" aria-labelledby="battle-help-title"><div class="dialog-head"><h2 id="battle-help-title">運搬と砲撃</h2><button id="close-battle-help">閉じる</button></div><div class="rules-body"><ol><li>上の弾薬庫Aで、床の弾に近づいて拾います。</li><li>通路を通って隣の砲撃室Aへ。砲台の近くで装填します。</li><li>装填後も砲台の操作位置に立つと自動で発射します。離れると止まります。</li><li>同じ経路の敵弾とぶつかると迎撃。直通・迂回や狙う部位は、次に装填する弾へ反映します。</li></ol><p>所持枠は2つ、合計重量は3まで。標準弾・防護板・高速杭は重量1、重量弾は2です。</p><p>広場への移動・近接戦・核攻撃は次段階です。外装7部位が壊れても勝利ではありません。</p></div></dialog></section>`;
  const screen = app.querySelector<HTMLElement>('.battle')!;
  screen.dataset.matchId = state.matchId;
  app.querySelector('.player-label')!.textContent = name;
  const canvas = app.querySelector('canvas')!;
  const render = createBattleRenderer(canvas, state);
  const movement = bindMovement(app.querySelector<HTMLElement>('.movement-pad')!);
  const overlay = app.querySelector<HTMLElement>('.battle-overlay')!;
  const title = app.querySelector<HTMLElement>('.overlay-title')!;
  const number = app.querySelector<HTMLElement>('.countdown-number')!;
  const description = app.querySelector<HTMLElement>('.overlay-description')!;
  const resume = app.querySelector<HTMLButtonElement>('#resume-battle')!;
  const action = app.querySelector<HTMLButtonElement>('#battle-action')!;
  const drop = app.querySelector<HTMLButtonElement>('#battle-drop')!;
  const leave = app.querySelector<HTMLButtonElement>('#leave-battle')!;
  const help = app.querySelector<HTMLDialogElement>('.battle-help-dialog')!;
  let lastHud = '';
  let overlayWasVisible: boolean | null = null;
  const canInteract = () => !paused && countdown === 0 && state.phase === 'running';

  const clearInput = () => { movement.clear(); pending = undefined; clock.reset(); };
  const stop = () => {
    if (disposed || state.phase === 'ended') return;
    paused = true; state = pauseBattle(state); clearInput(); updateOverlay();
  };
  const updateOverlay = () => {
    const ended = state.phase === 'ended';
    overlay.hidden = !paused && countdown === 0 && !ended;
    overlay.inert = help.open;
    overlay.setAttribute('aria-hidden', String(help.open || overlay.hidden));
    number.hidden = paused || countdown === 0 || ended;
    number.textContent = String(Math.ceil(countdown / 60));
    title.textContent = ended ? '操作確認を終了しました' : paused ? '一時停止中' : '開始まで';
    description.textContent = ended ? '今回は運搬・砲撃の確認です。通常戦の勝敗やスコアは未実装です。' : paused ? '再開ボタンを押すまで、戦場も時計も止まります。' : '左のパッドで移動・右のボタンで弾を扱う';
    resume.hidden = !paused || ended;
    leave.textContent = countdown > 0 && !ended ? '準備を中止する' : 'ホームへ戻る';
    for (const child of screen.children) {
      if (child instanceof HTMLElement && child !== overlay && child !== help) child.inert = !overlay.hidden;
    }
    if (overlayWasVisible !== !overlay.hidden) {
      overlayWasVisible = !overlay.hidden;
      if (!help.open) (overlay.hidden ? app.querySelector<HTMLButtonElement>('#pause-battle')! : resume.hidden ? leave : resume).focus({ preventScroll: true });
    }
  };
  const queueAction = (handle: BattleHandle) => {
    if (paused || countdown > 0 || state.phase !== 'running' || pending) return;
    const interaction = getInteraction(state, 'P1', slot);
    if (!interaction.handles.includes(handle)) return;
    pending = { matchId: state.matchId, actorId: 'P1', generation: state.actors.P1.generation, handle, slot, route, part, contextToken: interaction.contextToken };
  };
  // Pointerdown performs one edge-triggered action; the subsequent click is ignored.
  for (const button of [action, drop]) {
    const trigger = () => {
      const handle = button === drop ? 'drop' : action.dataset.handle as BattleHandle | undefined;
      if (handle) queueAction(handle);
    };
    button.addEventListener('pointerdown', event => { if (event.button === 0 && !button.disabled) trigger(); }, options);
    button.addEventListener('click', event => { if (event.detail === 0) trigger(); }, options);
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>('[data-slot]')) button.addEventListener('click', () => {
    if (!canInteract()) return;
    slot = Number(button.dataset.slot); lastHud = '';
  }, options);
  app.querySelector('#route-toggle')!.addEventListener('click', event => {
    if (!canInteract()) return;
    route = route === 'direct' ? 'detour' : 'direct';
    (event.currentTarget as HTMLButtonElement).textContent = `経路：${route === 'direct' ? '直通' : '迂回'}`;
  }, options);
  app.querySelector<HTMLSelectElement>('#target-part')!.addEventListener('change', event => { if (canInteract()) part = (event.target as HTMLSelectElement).value as PartId; }, options);
  app.querySelector('#pause-battle')!.addEventListener('click', stop, options);
  resume.addEventListener('click', () => {
    if (document.hidden || help.open || state.phase === 'ended') return;
    state = setBattleVisibility(state, true); state = resumeBattle(state); paused = state.phase === 'paused'; clearInput(); updateOverlay();
  }, options);
  const mountedAt = performance.now();
  leave.addEventListener('click', () => {
    // A second tap on Start may land on this newly mounted button. Do not
    // interpret the same double-tap gesture as a request to abandon the match.
    if (performance.now() - mountedAt < 350) return;
    goHome();
  }, options);
  app.querySelector('#battle-help')!.addEventListener('click', () => { stop(); help.showModal(); updateOverlay(); }, options);
  app.querySelector('#close-battle-help')!.addEventListener('click', () => help.close(), options);
  help.addEventListener('close', () => { updateOverlay(); resume.focus({ preventScroll: true }); }, options);
  overlay.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const buttons = [resume, leave].filter(button => !button.hidden);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault(); buttons[(current + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
  }, options);
  window.addEventListener('blur', stop, options);
  document.addEventListener('visibilitychange', () => {
    state = setBattleVisibility(state, !document.hidden);
    if (document.hidden) stop();
    clearInput(); updateOverlay();
  }, options);
  const updateHud = () => {
    const interaction = getInteraction(state, 'P1', slot);
    const available = (['deliver', 'load', 'pickup'] as const).find(handle => interaction.handles.includes(handle));
    const actor = state.actors.P1;
    const cargo = [0, 1].map(index => Object.values(state.objects).find(item => (item.location.kind === 'carried' || item.location.kind === 'reserved-carried') && item.location.actorId === 'P1' && item.location.slot === index));
    const nearest = interaction.cases.find(item => item.id === interaction.pickupCaseId);
    const signature = JSON.stringify([Math.floor(state.tick / 60), actor.currentRoomId, available, nearest?.id, cargo.map(item => item?.id), slot, state.castles.player.destroyedPartIds, state.castles.enemy.destroyedPartIds, PART_IDS.map(id => [state.castles.player.exterior[id].health, state.castles.enemy.exterior[id].health])]);
    screen.dataset.tick = String(state.tick); screen.dataset.phase = countdown ? 'countdown' : paused ? 'paused' : state.phase;
    screen.dataset.playerX = String(state.fixedActors.P1.position.x); screen.dataset.playerY = String(state.fixedActors.P1.position.y);
    screen.dataset.playerOperatedLaunches = String(playerOperatedLaunches);
    if (signature === lastHud) return;
    lastHud = signature;
    const seconds = Math.floor(state.tick / 60);
    app.querySelector('.battle-time')!.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    action.disabled = !available; action.dataset.handle = available ?? ''; action.textContent = available === 'pickup' && nearest ? `${caseLabels[nearest.type]}を拾う` : available ? actionLabels[available] : '弾に近づく';
    drop.disabled = !cargo[slot] || !interaction.handles.includes('drop');
    for (const button of app.querySelectorAll<HTMLButtonElement>('[data-slot]')) {
      const index = Number(button.dataset.slot); const item = cargo[index];
      const type = item ? state.battleCases[item.id]?.type : undefined;
      button.textContent = `${index === 0 ? '左' : '右'}：${type ? caseLabels[type] ?? type : '空'}`;
      button.setAttribute('aria-pressed', String(index === slot));
    }
    const room = state.layout.home.rooms.find(item => item.id === actor.currentRoomId);
    app.querySelector('.current-room')!.textContent = room?.label ?? '通路';
    app.querySelector('.battle-hint')!.textContent = available === 'load' ? '装填後は、操作位置で待つと自動発射します。' : cargo.some(Boolean) ? '選んだ弾を砲台へ。弾薬庫の隣が砲撃室です。' : actor.currentRoomId === 'central_corridor' ? '上の弾薬庫Aへ。広場への移動は次段階です。' : '床の弾に近づいて拾う → 隣の砲台へ運ぶ。';
    for (const team of ['player', 'enemy'] as const) {
      const card = app.querySelector<HTMLElement>(`[data-team="${team}"]`)!;
      card.querySelector('.battle-gates')!.textContent = `門 ${state.castles[team].openGateIds.length}/7`;
      for (const id of PART_IDS) {
        const armor = state.castles[team].exterior[id]; const bar = card.querySelector<HTMLElement>(`[data-part="${id}"]`)!;
        bar.style.transform = `scaleX(${armor.health / armor.maxHealth})`;
        bar.title = `${id} 耐久${armor.health}/${armor.maxHealth}`;
        bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', bar.title);
      }
      card.setAttribute('aria-label', `${team === 'player' ? '自陣' : '敵陣'}、外装${state.castles[team].destroyedPartIds.length}部位破壊、${state.castles[team].openGateIds.length}門開放`);
    }
    for (const option of app.querySelectorAll<HTMLOptionElement>('#target-part option')) {
      const armor = state.castles.enemy.exterior[option.value as PartId];
      option.textContent = `敵 ${option.value}：${armor.health}/${armor.maxHealth}`;
    }
  };
  const loop = (now: number) => {
    if (disposed) return;
    if (!paused && state.phase !== 'ended') {
      const step = clock.advance(now);
      if (step.interrupted) stop();
      else for (let index = 0; index < step.ticks; index++) {
        if (countdown > 0) { countdown--; if (countdown === 0) clearInput(); }
        else {
          const intent: BattleIntent = { ...pending, matchId: state.matchId, actorId: 'P1', generation: pending?.generation ?? state.actors.P1.generation, direction: movement.direction(), slot: pending?.slot ?? slot, route: pending?.route ?? route, part: pending?.part ?? part };
          pending = undefined; state = stepBattle(state, intent);
          playerOperatedLaunches += state.lastStep.events.filter(event => event.type === 'projectile_launched' && event.sourceActorId === 'P1').length;
        }
      }
    } else clock.reset();
    updateOverlay(); updateHud(); render(state, part, slot);
    frame = requestAnimationFrame(loop);
  };
  if (document.hidden) { state = setBattleVisibility(state, false); stop(); }
  updateOverlay(); updateHud(); render(state, part, slot);
  frame = requestAnimationFrame(loop);
  return () => { disposed = true; cancelAnimationFrame(frame); movement.dispose(); events.abort(); pending = undefined; };
}
