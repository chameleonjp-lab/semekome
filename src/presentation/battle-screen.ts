import { createBattle, getInteraction, getPlayerSupplyPreview, pauseBattle, resumeBattle, setBattleVisibility, stepBattle } from '../simulation/physical-battle.ts';
import type { BattleEquipmentKind, BattleHandle, BattleIntent, BattleRoute } from '../simulation/physical-battle.ts';
import { CASE_TYPES, SUPPLY_BAG, type CaseType } from '../content/cases.ts';
import { PART_IDS } from '../domain/types.ts';
import type { PartId, TeamId } from '../domain/types.ts';
import { bindMovement } from '../input/battle-input.ts';
import { SessionClock, validatePlayerName } from '../input/session-clock.ts';
import { validateSupplyAllocation } from '../logistics/supply-schedule.ts';
import { GAME_ART_URLS } from './game-art.ts';
import { bindArtImageFallbacks, setArtImageSource, setArtImageVisible } from './art-fallback.ts';
import { actorStatusName, battleHint, battleMapLabel, partDisplayName } from './battle-hud.ts';
import { caseLabels, createBattleRenderer } from './battle-renderer.ts';
import './battle.css';

const actionLabels: Record<BattleHandle, string> = {
  pickup: '弾を拾う', drop: '弾を置く', deliver: '砲台へ渡す', load: '砲台へ装填', repair: '修理する', launch: '砲撃する', intercept: '迎撃する',
};

const allocationCounts = [1, 2, 3] as const;

function allocationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('exactly four')) return '異なる4種類を選んでください。';
  if (message.includes('between one and three')) return '各種類は1〜3個にしてください。';
  if (message.includes('exactly eight')) return '合計8個にしてください。';
  return '補給配分を確認してください。';
}

function readSupplyAllocation(root: ParentNode): CaseType[] {
  const types = [...root.querySelectorAll<HTMLSelectElement>('[data-supply-type]')].map((select) => select.value as CaseType);
  const counts = [...root.querySelectorAll<HTMLSelectElement>('[data-supply-count]')].map((select) => Number(select.value));
  return types.flatMap((type, index) => Array.from({ length: counts[index] ?? 0 }, () => type));
}

function refreshSupplyAllocationSummary(root: ParentNode): void {
  const types = [...root.querySelectorAll<HTMLSelectElement>('[data-supply-type]')].map((select) => select.value);
  const total = [...root.querySelectorAll<HTMLSelectElement>('[data-supply-count]')]
    .reduce((sum, select) => sum + Number(select.value), 0);
  root.querySelector('#supply-summary')!.textContent = `選択 ${new Set(types).size}/4種類・合計 ${total}/8個`;
}

function supplyAllocationRows(): string {
  return Array.from({ length: 4 }, (_, index) => {
    const selectedType = SUPPLY_BAG[index === 0 ? 0 : index === 1 ? 3 : index === 2 ? 5 : 7];
    const selectedCount = SUPPLY_BAG.filter((type) => type === selectedType).length;
    return `<div class="supply-row"><label><span>種類${index + 1}</span><span class="supply-type-picker"><img data-supply-art src="${GAME_ART_URLS[selectedType]}" alt="" aria-hidden="true"><select data-supply-type aria-label="補給${index + 1}の種類">${CASE_TYPES.map((type) => `<option value="${type}"${type === selectedType ? ' selected' : ''}>${caseLabels[type]}</option>`).join('')}</select></span></label><label class="supply-count"><span>個数</span><select data-supply-count aria-label="補給${index + 1}の個数">${allocationCounts.map((count) => `<option value="${count}"${count === selectedCount ? ' selected' : ''}>${count}個</option>`).join('')}</select></label></div>`;
  }).join('');
}

export function openBattleSetup(app: HTMLElement, goHome: () => void): () => void {
  let disposeBattle = () => {};
  let started = false;
  app.innerHTML = `<section class="battle-setup" aria-label="名前と補給の編成"><p class="eyebrow">運搬・砲撃・修理の操作確認版</p>
    <h1>出撃の準備</h1><p>弾薬庫で弾を拾い、隣の砲台へ運びます。<br>補助員と敵も、同じ戦場で作業します。</p>
    <form novalidate><label for="player-name">あなたの名前</label><input id="player-name" name="playerName" autocomplete="nickname" aria-describedby="name-hint name-error" placeholder="1〜20文字" required>
    <p id="name-hint">前後の空白は取り除きます。名前の外部送信は行いません。</p><p id="name-error" role="alert"></p>
    <section class="supply-setup" aria-labelledby="supply-setup-title"><h2 id="supply-setup-title">補給の編成</h2><p>使う種類を4つ選び、合計8個にします。標準配分をそのまま使うこともできます。</p><div class="supply-allocation">${supplyAllocationRows()}</div><p id="supply-summary" aria-live="polite"></p><p id="supply-error" aria-live="polite"></p></section>
    <button type="submit" class="primary">確認を開始する</button><button type="button" id="cancel-setup">ホームへ戻る</button></form>
    <p class="scope-note">今回は運搬・砲撃・外装修理・設備修理の操作確認版です。広場への移動や敵AIの戦闘は進みますが、主人公の近接攻撃操作、通常戦の開始導線・結果画面・ランキングには未接続です。</p></section>`;
  bindArtImageFallbacks(app);
  const input = app.querySelector<HTMLInputElement>('#player-name')!;
  const supplyError = app.querySelector<HTMLElement>('#supply-error')!;
  refreshSupplyAllocationSummary(app);
  for (const control of app.querySelectorAll<HTMLSelectElement>('[data-supply-type], [data-supply-count]')) {
    control.addEventListener('change', () => {
      if (control.matches('[data-supply-type]')) {
        const art = control.closest('.supply-row')?.querySelector<HTMLImageElement>('[data-supply-art]');
      if (art) setArtImageSource(art, GAME_ART_URLS[control.value as CaseType]);
      }
      refreshSupplyAllocationSummary(app);
      supplyError.textContent = '';
    });
  }
  app.querySelector('#cancel-setup')!.addEventListener('click', goHome);
  app.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault();
    if (started) return;
    const validation = validatePlayerName(input.value);
    app.querySelector('#name-error')!.textContent = validation.error ?? '';
    input.setAttribute('aria-invalid', String(Boolean(validation.error)));
    if (validation.error) { input.focus(); return; }
    const allocation = readSupplyAllocation(app);
    try {
      const validatedAllocation = validateSupplyAllocation(allocation);
      supplyError.textContent = '';
      started = true;
      disposeBattle = mountBattle(app, validation.name, validatedAllocation, goHome);
    } catch (error) {
      supplyError.textContent = allocationErrorMessage(error);
      app.querySelector<HTMLSelectElement>('[data-supply-type]')?.focus();
      return;
    }
  });
  return () => disposeBattle();
}

function mountBattle(app: HTMLElement, name: string, playerSupplyAllocation: readonly CaseType[], goHome: () => void): () => void {
  const random = new Uint32Array(1); crypto.getRandomValues(random);
  let state = createBattle({ matchId: crypto.randomUUID(), seed: random[0], playerSupplyAllocation });
  let countdown = 180;
  let paused = false;
  let disposed = false;
  let slot = 0;
  let route: BattleRoute = 'direct';
  let part: PartId = 'P1';
  let equipmentTarget: { kind: BattleEquipmentKind; id: string } | undefined;
  let pending: BattleIntent | undefined;
  let frame = 0;
  let playerOperatedLaunches = 0;
  const clock = new SessionClock();
  const events = new AbortController();
  const options = { signal: events.signal };
  app.innerHTML = `<section class="battle" aria-label="運搬と砲撃と修理"><header class="battle-header"><div><strong class="player-label"></strong><span class="battle-stage">運搬・砲撃・修理の確認</span></div><output id="supply-preview" class="supply-preview" aria-label="次に届く補給"><span class="supply-preview-title">次の補給：</span><span class="supply-preview-items"></span></output><output class="battle-time" aria-label="経過時間">0:00</output><button id="pause-battle">一時停止</button></header>
    <div class="battle-armor" aria-label="両城の外装">${(['player', 'enemy'] as const).map(team => `<div data-team="${team}"><span>${team === 'player' ? '自陣' : '敵陣'}</span><div class="armor">${PART_IDS.map(id => `<span data-part="${id}"></span>`).join('')}</div><output class="battle-gates"></output></div>`).join('')}</div>
    <div class="battle-map"><canvas aria-label="あなたを中心とした自陣の城内と、直通・迂回の砲撃経路"></canvas><span class="current-room"></span></div>
    <p class="battle-hint" aria-live="polite">上の弾薬庫Aへ。弾の近くで「弾を拾う」。</p>
    <div class="cargo-controls" aria-label="所持する弾"><button data-slot="0" aria-pressed="true"><img class="cargo-icon" alt="" hidden><span class="cargo-label">左：空</span></button><button data-slot="1" aria-pressed="false"><img class="cargo-icon" alt="" hidden><span class="cargo-label">右：空</span></button></div>
    <div class="battle-controls"><div class="movement-pad" role="group" aria-label="移動パッド。中心から動きたい方向へ指をずらす"><span class="pad-up">↑</span><span class="pad-left">←</span><i></i><span class="pad-right">→</span><span class="pad-down">↓</span></div><div class="action-controls"><button id="battle-action" class="primary" disabled><img class="action-icon" alt="" hidden><span class="action-label">弾に近づく</span></button><button id="battle-drop" disabled><span class="drop-icon" aria-hidden="true">↓</span><span>選択中の弾を置く</span></button></div></div>
    <div class="battle-settings"><button id="route-toggle">経路：直通</button><label class="target-control">狙う部位<select id="target-part">${PART_IDS.map(id => `<option value="${id}">敵 ${partDisplayName(id)}</option>`).join('')}</select></label><label id="equipment-target-control" class="target-control" hidden>修理対象設備<select id="equipment-target"><option value="">選択してください</option></select></label><button id="battle-help" aria-label="操作説明">?</button></div>
    <div class="battle-overlay" role="dialog" aria-modal="true" aria-labelledby="overlay-title"><div><p id="overlay-title" class="overlay-title" role="status">開始まで</p><strong class="countdown-number">3</strong><p class="overlay-description">左のパッドで移動・右のボタンで弾を扱う</p><button id="resume-battle" class="primary" hidden>再開する</button><button id="leave-battle">準備を中止する</button></div></div>
    <dialog class="battle-help-dialog" aria-labelledby="battle-help-title"><div class="dialog-head"><h2 id="battle-help-title">運搬・砲撃・修理</h2><button id="close-battle-help">閉じる</button></div><div class="rules-body"><ol><li>弾薬庫で、床の弾に近づいて拾います。敵陣や広場の床弾も拾えます。</li><li>弾を砲台へ運び、受け渡し枠へ渡すか砲台の近くで装填します。</li><li>装填後も砲台の操作位置に立つと自動で発射します。離れると止まります。</li><li>同じ経路の敵弾とぶつかると迎撃。直通・迂回や狙う部位は、次に装填する弾へ反映します。</li><li>自陣の修理室で所持中の弾を1個使い、外装は90更新、設備は120更新で修理できます。途中で移動・被弾すると弾は戻ります。</li></ol><p>所持枠は2つ、合計重量は3まで。標準弾・防護板・高速杭は重量1、重量弾は2です。</p><p>広場への移動と敵AIの戦闘は進みます。主人公の近接攻撃操作と通常戦の勝敗結果画面・ランキングは未接続です。外装7部位を壊しただけでは勝敗は決まりません。</p></div></dialog></section>`;
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
  const equipmentTargetControl = app.querySelector<HTMLElement>('#equipment-target-control')!;
  const equipmentTargetSelect = app.querySelector<HTMLSelectElement>('#equipment-target')!;
  const routeToggle = app.querySelector<HTMLButtonElement>('#route-toggle')!;
  const targetPartSelect = app.querySelector<HTMLSelectElement>('#target-part')!;
  const supplyPreviewItems = app.querySelector<HTMLElement>('.supply-preview-items')!;
  const actionIcon = action.querySelector<HTMLImageElement>('.action-icon')!;
  const actionLabel = action.querySelector<HTMLElement>('.action-label')!;
  bindArtImageFallbacks(screen);
  screen.dataset.playerSupplyAllocation = state.logistics.playerAllocation.join(',');
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
    description.textContent = ended ? '今回は運搬・砲撃・外装修理の確認です。通常戦の勝敗やスコアは未実装です。' : paused ? '再開ボタンを押すまで、戦場も時計も止まります。' : '左のパッドで移動・右のボタンで弾を扱う';
    resume.hidden = !paused || ended;
    leave.textContent = countdown > 0 && !ended ? '準備を中止する' : 'ホームへ戻る';
    for (const child of screen.children) {
      if (child instanceof HTMLElement && child !== overlay && child !== help) child.inert = !overlay.hidden;
    }
    movement.setEnabled(canInteract() && state.actors.P1.alive);
    if (overlayWasVisible !== !overlay.hidden) {
      overlayWasVisible = !overlay.hidden;
      if (!help.open) (overlay.hidden ? app.querySelector<HTMLButtonElement>('#pause-battle')! : resume.hidden ? leave : resume).focus({ preventScroll: true });
    }
  };
  const queueAction = (handle: BattleHandle) => {
    if (paused || countdown > 0 || state.phase !== 'running' || !state.actors.P1.alive || pending) return;
    const interaction = getInteraction(state, 'P1', slot);
    if (!interaction.handles.includes(handle)) return;
    const target = handle === 'repair' && equipmentTargetSelect.value
      ? equipmentTargetSelect.value.split(':')
      : [];
    pending = {
      matchId: state.matchId,
      actorId: 'P1',
      generation: state.actors.P1.generation,
      handle,
      slot,
      route,
      part,
      ...(target.length === 2 ? { equipmentKind: target[0] as BattleEquipmentKind, equipmentId: target[1] } : {}),
      contextToken: interaction.contextToken,
    };
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
    if (!canInteract() || !state.actors.P1.alive) return;
    slot = Number(button.dataset.slot); lastHud = '';
  }, options);
  routeToggle.addEventListener('click', event => {
    if (!canInteract() || !state.actors.P1.alive) return;
    route = route === 'direct' ? 'detour' : 'direct';
    (event.currentTarget as HTMLButtonElement).textContent = `経路：${route === 'direct' ? '直通' : '迂回'}`;
  }, options);
  targetPartSelect.addEventListener('change', event => { if (canInteract() && state.actors.P1.alive) part = (event.target as HTMLSelectElement).value as PartId; }, options);
  equipmentTargetSelect.addEventListener('change', event => {
    if (!canInteract() || !state.actors.P1.alive) return;
    const [kind, id] = (event.target as HTMLSelectElement).value.split(':');
    equipmentTarget = kind && id ? { kind: kind as BattleEquipmentKind, id } : undefined;
  }, options);
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
    const available = (['repair', 'deliver', 'load', 'pickup'] as const).find(handle => interaction.handles.includes(handle));
    const actor = state.actors.P1;
    const cargo = [0, 1].map(index => Object.values(state.objects).find(item => (item.location.kind === 'carried' || item.location.kind === 'reserved-carried') && item.location.actorId === 'P1' && item.location.slot === index));
    const nearest = interaction.cases.find(item => item.id === interaction.pickupCaseId);
    const supplyPreview = getPlayerSupplyPreview(state);
    const equipmentTargetsSignature = interaction.equipmentRepairTargets.map(target => `${target.kind}:${target.id}:${target.health}:${target.disabledUntilTick}`);
    const signature = JSON.stringify([Math.floor(state.tick / 60), actor.alive, actor.location, actor.currentRoomId, actor.respawnAtTick, canInteract(), paused, countdown > 0, state.phase, state.visibility, available, nearest?.id, cargo.map(item => item?.id), slot, equipmentTargetsSignature, state.logistics.bagCycles.player, state.logistics.bagIndices.player, supplyPreview, state.castles.player.destroyedPartIds, state.castles.enemy.destroyedPartIds, PART_IDS.map(id => [state.castles.player.exterior[id].health, state.castles.enemy.exterior[id].health])]);
    screen.dataset.tick = String(state.tick); screen.dataset.phase = countdown ? 'countdown' : paused ? 'paused' : state.phase;
    screen.dataset.spectating = String(!actor.alive);
    screen.dataset.playerX = String(state.fixedActors.P1.position.x); screen.dataset.playerY = String(state.fixedActors.P1.position.y);
    screen.dataset.playerOperatedLaunches = String(playerOperatedLaunches);
    screen.dataset.playerSupplyPreview = supplyPreview.join(',');
    if (signature === lastHud) return;
    lastHud = signature;
    const seconds = Math.floor(state.tick / 60);
    app.querySelector('.battle-time')!.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    supplyPreviewItems.replaceChildren(...supplyPreview.map(type => {
      const item = document.createElement('span'); item.className = 'supply-preview-item'; item.dataset.caseType = type;
      const image = document.createElement('img'); image.alt = ''; image.setAttribute('aria-hidden', 'true'); setArtImageSource(image, GAME_ART_URLS[type]);
      const label = document.createElement('span'); label.textContent = caseLabels[type];
      item.append(image, label); return item;
    }));
    action.disabled = !canInteract() || !actor.alive || !available; action.dataset.handle = available ?? '';
    actionLabel.textContent = available === 'pickup' && nearest ? `${caseLabels[nearest.type]}を拾う` : available ? actionLabels[available] : '弾に近づく';
    const actionArt = available === 'pickup' && nearest ? nearest.type
      : available === 'repair' ? 'repair'
        : available === 'deliver' || available === 'load' ? 'turret'
          : undefined;
    setArtImageVisible(actionIcon, Boolean(actionArt));
    if (actionArt) setArtImageSource(actionIcon, GAME_ART_URLS[actionArt]);
    drop.disabled = !canInteract() || !actor.alive || !cargo[slot] || !interaction.handles.includes('drop');
    for (const button of app.querySelectorAll<HTMLButtonElement>('[data-slot]')) {
      const index = Number(button.dataset.slot); const item = cargo[index];
      const type = item ? state.battleCases[item.id]?.type : undefined;
      const icon = button.querySelector<HTMLImageElement>('.cargo-icon')!;
      const label = button.querySelector<HTMLElement>('.cargo-label')!;
      label.textContent = `${index === 0 ? '左' : '右'}：${type ? caseLabels[type] ?? type : '空'}`;
      setArtImageVisible(icon, Boolean(type));
      if (type) setArtImageSource(icon, GAME_ART_URLS[type]);
      button.disabled = !canInteract() || !actor.alive;
      button.setAttribute('aria-pressed', String(index === slot));
    }
    app.querySelector('.current-room')!.textContent = actorStatusName(state, actor);
    canvas.setAttribute('aria-label', battleMapLabel(state, actor));
    equipmentTargetControl.hidden = actor.location.area !== 'castle' || actor.location.castleTeam !== actor.team || actor.currentRoomId !== 'repair' || interaction.equipmentRepairTargets.length === 0;
    const availableTargetValues = new Set(interaction.equipmentRepairTargets.map(target => `${target.kind}:${target.id}`));
    equipmentTargetSelect.replaceChildren(new Option('外装を修理', ''));
    for (const target of interaction.equipmentRepairTargets) equipmentTargetSelect.add(new Option(`${target.kind === 'turret' ? '砲台' : '補給口'} ${target.id}：${target.health}/${state.rules.equipmentRepairHealth}`, `${target.kind}:${target.id}`));
    const selectedTarget = equipmentTarget && availableTargetValues.has(`${equipmentTarget.kind}:${equipmentTarget.id}`) ? `${equipmentTarget.kind}:${equipmentTarget.id}` : '';
    equipmentTargetSelect.value = selectedTarget;
    equipmentTarget = selectedTarget ? equipmentTarget : undefined;
    app.querySelector('.battle-hint')!.textContent = battleHint(state, actor, available, cargo.some(Boolean), interaction.handles.includes('drop'));
    for (const team of ['player', 'enemy'] as const) {
      const card = app.querySelector<HTMLElement>(`[data-team="${team}"]`)!;
      card.querySelector('.battle-gates')!.textContent = `門 ${state.castles[team].openGateIds.length}/7`;
      for (const id of PART_IDS) {
        const armor = state.castles[team].exterior[id]; const bar = card.querySelector<HTMLElement>(`[data-part="${id}"]`)!;
        bar.style.transform = `scaleX(${armor.health / armor.maxHealth})`;
        bar.title = `${partDisplayName(id)} 耐久${armor.health}/${armor.maxHealth}`;
        bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', bar.title);
      }
      card.setAttribute('aria-label', `${team === 'player' ? '自陣' : '敵陣'}、外装${state.castles[team].destroyedPartIds.length}部位破壊、${state.castles[team].openGateIds.length}門開放`);
    }
    for (const option of app.querySelectorAll<HTMLOptionElement>('#target-part option')) {
      const targetTeam: TeamId = actor.location.area === 'castle' && actor.location.castleTeam === actor.team && actor.currentRoomId === 'repair'
        ? actor.team
        : actor.team === 'player' ? 'enemy' : 'player';
      const targetArmor = state.castles[targetTeam].exterior[option.value as PartId];
      option.textContent = `${targetTeam === 'player' ? '自陣' : '敵陣'} ${partDisplayName(option.value as PartId)}：${targetArmor.health}/${targetArmor.maxHealth}`;
    }
    routeToggle.disabled = !canInteract() || !actor.alive;
    targetPartSelect.disabled = !canInteract() || !actor.alive;
    equipmentTargetSelect.disabled = !canInteract() || !actor.alive;
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
          pending = undefined;
          const wasAlive = state.actors.P1.alive;
          state = stepBattle(state, intent);
          render.observeStep(state);
          if (wasAlive && !state.actors.P1.alive) { clearInput(); movement.setEnabled(false); lastHud = ''; }
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
