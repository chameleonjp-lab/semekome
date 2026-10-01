import { getInteraction, getPlayerSupplyPreview, pauseBattle, resumeBattle, setBattleVisibility } from '../simulation/physical-battle.ts';
import type { AllyActorId, BattleDirection, BattleEquipmentKind, BattleHandle, BattleIntent, BattleRoute } from '../simulation/physical-battle.ts';
import { CASE_TYPES, SUPPLY_BAG, type CaseType } from '../content/cases.ts';
import { PART_IDS } from '../domain/types.ts';
import type { PartId, TeamId } from '../domain/types.ts';
import { bindAttackInput, bindDashInput, bindMovement } from '../input/battle-input.ts';
import { SessionClock, validatePlayerName } from '../input/session-clock.ts';
import { validateSupplyAllocation } from '../logistics/supply-schedule.ts';
import { GAME_ART_URLS } from './game-art.ts';
import { bindArtImageFallbacks, setArtImageSource, setArtImageVisible } from './art-fallback.ts';
import { actorStatusName, battleHint, battleMapLabel, partDisplayName } from './battle-hud.ts';
import { caseLabels, createBattleRenderer } from './battle-renderer.ts';
import { createBattleSessionRecord, createBattleSessionStore, type BattleOutcome, type BattleResultReason } from './battle-session-record.ts';
import { projectBattleResultMetrics } from './battle-result-metrics.ts';
import { createAllyCommandQueue } from './ally-command-queue.ts';
import { createBattleRecorder } from '../replay/battle-replay.ts';
import { SUPPORT_TYPES, SUPPORT_LABELS, validateSupportTypes, type SupportType } from '../content/support-types.ts';
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
  let disposeActive = () => {};
  let closed = false;
  const leaveToHome = () => {
    disposeActive();
    disposeActive = () => {};
    goHome();
  };
  const renderSetup = () => {
    if (closed) return;
    disposeActive();
    disposeActive = () => {};
    let started = false;
    app.innerHTML = `<section class="battle-setup" aria-label="通常戦の名前と補給の編成"><p class="eyebrow">通常戦の準備</p>
      <h1>出撃の準備</h1><p>名前と補給の編成を決めると、3秒のカウントダウン後に通常戦が始まります。<br>弾薬庫で弾を拾い、砲台へ運びます。補助員と敵も同じ戦場で動きます。</p>
      <form novalidate><label for="player-name">あなたの名前</label><input id="player-name" name="playerName" autocomplete="nickname" aria-describedby="name-hint name-error" placeholder="1〜20文字" required>
      <p id="name-hint">前後の空白は取り除きます。名前の外部送信は行いません。</p><p id="name-error" role="alert"></p>
      <section class="supply-setup" aria-labelledby="supply-setup-title"><h2 id="supply-setup-title">補給の編成</h2><p>使う種類を4つ選び、合計8個にします。標準配分をそのまま使うこともできます。</p><div class="supply-allocation">${supplyAllocationRows()}</div><p id="supply-summary" aria-live="polite"></p><p id="supply-error" aria-live="polite"></p></section>
      <section class="supply-setup"><h2>補助員の編成</h2>${['P2', 'P3'].map(id => `<label>${id}<select data-support-type>${SUPPORT_TYPES.map(type => `<option value="${type}">${SUPPORT_LABELS[type]}</option>`).join('')}</select></label>`).join('')}<p>同じ型を2人選べます。</p></section>
      <button type="submit" class="primary">確認を開始する</button><button type="button" id="cancel-setup">ホームへ戻る</button></form>
      <p class="scope-note">通常戦は、名前入力・補給編成・カウントダウン・実戦・結果画面まで進みます。承認済みスコア・ランキング接続は未完了です。</p></section>`;
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
    app.querySelector('#cancel-setup')!.addEventListener('click', leaveToHome);
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
        disposeActive = mountBattle(app, validation.name, validatedAllocation, leaveToHome, renderSetup, validateSupportTypes([...app.querySelectorAll<HTMLSelectElement>('[data-support-type]')].map(control => control.value)));
      } catch (error) {
        supplyError.textContent = allocationErrorMessage(error);
        app.querySelector<HTMLSelectElement>('[data-supply-type]')?.focus();
        return;
      }
    });
  };
  renderSetup();
  return () => {
    closed = true;
    disposeActive();
    disposeActive = () => {};
  };
}

function mountBattle(app: HTMLElement, name: string, playerSupplyAllocation: readonly CaseType[], goHome: () => void, onReplay: () => void, supportTypes: readonly SupportType[]): () => void {
  const random = new Uint32Array(1); crypto.getRandomValues(random);
  const recorder = createBattleRecorder({ matchId: crypto.randomUUID(), seed: random[0], playerSupplyAllocation, supportTypes });
  let state = recorder.state;
  const sessionStore = createBattleSessionStore();
  const sessionRecord = sessionStore.begin(createBattleSessionRecord({
    matchId: state.matchId,
    playerName: name,
    playerSupplyAllocation: state.logistics.playerAllocation,
  }));
  let countdown = 180;
  let paused = false;
  let disposed = false;
  let slot = 0;
  let route: BattleRoute = 'direct';
  let part: PartId = 'P1';
  let equipmentTarget: { kind: BattleEquipmentKind; id: string } | undefined;
  let pending: BattleIntent | undefined;
  let pendingDash: BattleDirection | undefined;
  let pendingAttack = false;
  const allyCommandQueue = createAllyCommandQueue();
  let frame = 0;
  let playerOperatedLaunches = 0;
  let playerDashStarts = 0;
  const clock = new SessionClock();
  const events = new AbortController();
  const options = { signal: events.signal };
  app.innerHTML = `<section class="battle" aria-label="通常戦"><header class="battle-header"><div><strong class="player-label"></strong><span class="battle-stage">通常戦</span></div><output id="supply-preview" class="supply-preview" aria-label="次に届く補給"><span class="supply-preview-title">次の補給：</span><span class="supply-preview-items"></span></output><output class="battle-time" aria-label="経過時間">0:00</output><button id="pause-battle">一時停止</button></header>
    <div class="battle-armor" aria-label="両城の外装">${(['player', 'enemy'] as const).map(team => `<div data-team="${team}"><span>${team === 'player' ? '自陣' : '敵陣'}</span><div class="armor">${PART_IDS.map(id => `<span data-part="${id}"></span>`).join('')}</div><output class="battle-gates"></output></div>`).join('')}</div>
    <div class="battle-map"><canvas aria-label="あなたを中心とした自陣の城内と、直通・迂回の砲撃経路"></canvas><span class="current-room"></span></div>
    <p class="battle-hint" aria-live="polite">上の弾薬庫Aへ。弾の近くで「弾を拾う」。</p>
    <div class="cargo-controls" aria-label="所持する弾"><button data-slot="0" aria-pressed="true"><img class="cargo-icon" alt="" hidden><span class="cargo-label">左：空</span></button><button data-slot="1" aria-pressed="false"><img class="cargo-icon" alt="" hidden><span class="cargo-label">右：空</span></button></div>
    <div class="battle-controls"><div class="movement-pad" role="group" aria-label="移動パッド。中心から動きたい方向へ指をずらす"><span class="pad-up">↑</span><span class="pad-left">←</span><i></i><span class="pad-right">→</span><span class="pad-down">↓</span></div><div class="action-controls"><button id="battle-action" class="primary" disabled><img class="action-icon" alt="" hidden><span class="action-label">弾に近づく</span></button><div class="action-row"><button id="battle-drop" disabled><span class="drop-icon" aria-hidden="true">↓</span><span>選択中の弾を置く</span></button><button id="battle-attack" type="button" aria-label="近接攻撃。近くに攻撃対象なし" disabled><span class="attack-label">敵に近づく</span></button></div></div><button id="battle-dash" class="dash-control" type="button" aria-label="突進" aria-describedby="dash-status" disabled><span class="dash-label">突進</span><span id="dash-status" class="dash-status">操作開始後に使用できます</span><span class="dash-progress" aria-hidden="true"><i></i></span></button></div>
    <div class="battle-settings"><button id="route-toggle">経路：直通</button><label class="target-control">狙う部位<select id="target-part">${PART_IDS.map(id => `<option value="${id}">敵 ${partDisplayName(id)}</option>`).join('')}</select></label><label id="equipment-target-control" class="target-control" hidden>修理対象設備<select id="equipment-target"><option value="">選択してください</option></select></label><details class="ally-orders"><summary aria-label="味方命令">味方</summary><div class="ally-order-panel"><div class="ally-order-buttons"><button id="ally-p2-command" type="button" data-ally-id="P2">P2：守備を指示</button><button id="ally-p3-command" type="button" data-ally-id="P3">P3：守備を指示</button></div>${['P2', 'P3'].map(id => `<div><label>${id}の命令<select data-ally-kind="${id}"><option value="artillery">砲撃</option><option value="defense">防衛</option><option value="invasion">侵入</option><option value="supply">取消し・通常業務</option></select></label><label>目標室<select data-ally-room="${id}">${state.layout.home.rooms.map(room => `<option value="${room.id}">${room.label}</option>`).join('')}</select></label><button data-ally-submit="${id}" type="button">${id}へ指示</button></div>`).join('')}<p id="ally-order-status"></p><p id="ally-order-hint">守備中は現在位置を保ち、同室の敵だけを防衛します。</p></div></details><button id="battle-help" aria-label="操作説明">?</button></div>
    <div class="battle-overlay" role="dialog" aria-modal="true" aria-labelledby="overlay-title"><div><p id="overlay-title" class="overlay-title" role="status">開始まで</p><strong class="countdown-number">3</strong><p class="terminal-result" aria-live="polite" hidden></p><p class="overlay-description">左のパッドで移動・右のボタンで弾を扱う。敵と接触したら近接攻撃</p><button id="resume-battle" class="primary" hidden>再開する</button><button id="leave-battle">準備を中止する</button></div></div>
    <dialog class="battle-help-dialog" aria-labelledby="battle-help-title"><div class="dialog-head"><h2 id="battle-help-title">通常戦の操作</h2><button id="close-battle-help">閉じる</button></div><div class="rules-body"><ol><li>弾薬庫で、床の弾に近づいて拾います。敵陣や広場の床弾も拾えます。</li><li>弾を砲台へ運び、受け渡し枠へ渡すか砲台の近くで装填します。</li><li>装填後も砲台の操作位置に立つと自動で発射します。離れると止まります。</li><li>同じ経路の敵弾とぶつかると迎撃。直通・迂回や狙う部位は、次に装填する弾へ反映します。</li><li>自陣の修理室で所持中の弾を1個使い、外装は90更新、設備は120更新で修理できます。途中で移動・被弾すると弾は戻ります。</li><li>敵と接触した状態で「近接攻撃」を押すと、敵に1回の接触ダメージを与えます。キーボードではXキー、コアへの勝利攻撃は突進です。</li><li>突進はボタンまたはSpaceを押し始めたとき1回だけ発動します。移動中は現在方向、停止中は最後の移動方向（初期は右）へ進み、再使用待ちの間は使えません。</li><li>「味方」からP2/P3へ守備を指示すると、その位置を保ちながら同室の敵だけを防衛します。もう一度押すと補給へ戻ります。</li></ol><p>所持枠は2つ、合計重量は3まで。標準弾・防護板・高速杭は重量1、重量弾は2です。</p><p>広場への移動と敵AIの戦闘は同じ通常戦の中で進みます。終局時は勝敗と理由を結果画面に表示し、実戦の記録も残します。承認済みスコア・ランキング・共有は未接続です。外装7部位を壊しただけでは勝敗は決まりません。</p></div></dialog></section>`;
  const screen = app.querySelector<HTMLElement>('.battle')!;
  screen.dataset.matchId = state.matchId;
  screen.dataset.flow = 'normal';
  screen.dataset.startRecordId = sessionRecord.start.id;
  screen.dataset.recordConnection = sessionRecord.connection;
  screen.dataset.startRecordStatus = sessionRecord.start.status;
  screen.dataset.recordPersistence = sessionStore.persistent ? 'session' : 'memory';
  app.querySelector('.player-label')!.textContent = name;
  const canvas = app.querySelector('canvas')!;
  const render = createBattleRenderer(canvas, state);
  const movement = bindMovement(app.querySelector<HTMLElement>('.movement-pad')!);
  const dashButton = app.querySelector<HTMLButtonElement>('#battle-dash')!;
  const dashStatus = dashButton.querySelector<HTMLElement>('.dash-status')!;
  const dashProgress = dashButton.querySelector<HTMLElement>('.dash-progress i')!;
  const overlay = app.querySelector<HTMLElement>('.battle-overlay')!;
  const title = app.querySelector<HTMLElement>('.overlay-title')!;
  const number = app.querySelector<HTMLElement>('.countdown-number')!;
  const description = app.querySelector<HTMLElement>('.overlay-description')!;
  const resume = app.querySelector<HTMLButtonElement>('#resume-battle')!;
  const action = app.querySelector<HTMLButtonElement>('#battle-action')!;
  const drop = app.querySelector<HTMLButtonElement>('#battle-drop')!;
  const attackButton = app.querySelector<HTMLButtonElement>('#battle-attack')!;
  const leave = app.querySelector<HTMLButtonElement>('#leave-battle')!;
  const help = app.querySelector<HTMLDialogElement>('.battle-help-dialog')!;
  const terminalResult = app.querySelector<HTMLElement>('.terminal-result')!;
  const equipmentTargetControl = app.querySelector<HTMLElement>('#equipment-target-control')!;
  const equipmentTargetSelect = app.querySelector<HTMLSelectElement>('#equipment-target')!;
  const routeToggle = app.querySelector<HTMLButtonElement>('#route-toggle')!;
  const targetPartSelect = app.querySelector<HTMLSelectElement>('#target-part')!;
  const allyOrderHint = app.querySelector<HTMLElement>('#ally-order-hint')!;
  const allyOrderButtons = {
    P2: app.querySelector<HTMLButtonElement>('#ally-p2-command')!,
    P3: app.querySelector<HTMLButtonElement>('#ally-p3-command')!,
  } satisfies Record<AllyActorId, HTMLButtonElement>;
  for (const button of app.querySelectorAll<HTMLButtonElement>('[data-ally-submit]')) {
    const allyId = button.dataset.allySubmit as AllyActorId;
    button.addEventListener('click', () => {
      if (!canInteract()) return;
      const kind = app.querySelector<HTMLSelectElement>(`[data-ally-kind="${allyId}"]`)!.value as 'artillery' | 'defense' | 'invasion' | 'supply';
      const targetRoomId = app.querySelector<HTMLSelectElement>(`[data-ally-room="${allyId}"]`)!.value;
      allyCommandQueue.submit(state, { allyId, kind, ...(kind === 'defense' || kind === 'invasion' ? { targetRoomId } : {}),
        ...(kind === 'artillery' ? { route, part } : {}) });
      updateAllyOrderControls();
    });
  }
  const supplyPreviewItems = app.querySelector<HTMLElement>('.supply-preview-items')!;
  const actionIcon = action.querySelector<HTMLImageElement>('.action-icon')!;
  const actionLabel = action.querySelector<HTMLElement>('.action-label')!;
  const attackLabel = attackButton.querySelector<HTMLElement>('.attack-label')!;
  bindArtImageFallbacks(screen);
  screen.dataset.playerSupplyAllocation = state.logistics.playerAllocation.join(',');
  let lastHud = '';
  let overlayWasVisible: boolean | null = null;
  const canInteract = () => !paused && countdown === 0 && state.phase === 'running' && !document.hidden && !help.open;
  const playerProtected = () => {
    const actor = state.actors.P1;
    return actor.protectedUntilTick !== null && state.tick < actor.protectedUntilTick;
  };
  const canStartDash = () => {
    const actor = state.actors.P1;
    return canInteract() && actor.alive && !playerProtected() && !state.dashes.P1 &&
      state.tick >= (state.dashCooldownUntilTick.P1 ?? 0) && pendingDash === undefined && !pendingAttack;
  };
  const canStartAttack = () => {
    const actor = state.actors.P1;
    return canInteract() && actor.alive && !playerProtected() && !state.dashes.P1 &&
      pending === undefined && pendingDash === undefined && !pendingAttack && getInteraction(state, 'P1', slot).attackTargetId !== undefined;
  };
  const dashInput = bindDashInput(dashButton, () => {
    if (!canStartDash()) return;
    const current = movement.direction();
    pendingDash = current.x !== 0 || current.y !== 0 ? { ...current } : movement.lastDirection();
  });
  const attackInput = bindAttackInput(attackButton, () => {
    if (canStartAttack()) pendingAttack = true;
  });

  const releaseInput = () => { movement.clear(); dashInput.clear(); attackInput.clear(); pending = undefined; pendingDash = undefined; pendingAttack = false; allyCommandQueue.clear(); };
  const clearInput = (resetClock = true) => { releaseInput(); if (resetClock) clock.reset(); };
  const updateAllyOrderControls = () => {
    const player = state.actors.P1;
    for (const allyId of ['P2', 'P3'] as const) {
      const ally = state.actors[allyId];
      const order = state.allyOrders[allyId];
      const currentKind = order?.generation === ally.generation ? 'hold' : 'supply';
      const queuedKind = allyCommandQueue.peek(state, allyId);
      const button = allyOrderButtons[allyId];
      button.disabled = !canInteract() || !player.alive || !ally.alive;
      button.textContent = !ally.alive
        ? `${allyId}：復活待ち`
        : queuedKind
          ? `${allyId}：${queuedKind === 'hold' ? '守備' : '補給'}の指示を取り消す`
          : `${allyId}：${currentKind === 'hold' ? '補給へ戻す' : '守備を指示'}`;
      button.setAttribute('aria-label', `${allyId}への命令。${button.textContent}`);
      button.dataset.order = currentKind;
      button.dataset.pendingOrder = queuedKind ?? '';
    }
    for (const button of app.querySelectorAll<HTMLButtonElement>('[data-ally-submit]')) button.disabled = !canInteract() || !state.actors[button.dataset.allySubmit!]?.alive;
    const commandNames = { hold: '現在位置の守備', supply: '通常業務', artillery: '砲撃', defense: '防衛', invasion: '侵入' };
    app.querySelector('#ally-order-status')!.textContent = (['P2', 'P3'] as const).map(id => {
      const order = state.allyOrders[id]; return `${id} ${SUPPORT_LABELS[state.supportTypes[id]].split('：')[0]}：${commandNames[order?.kind ?? 'supply']}${order?.targetRoomId ? ` (${state.layout.home.rooms.find(room => room.id === order.targetRoomId)?.label ?? order.targetRoomId})` : ''}`;
    }).join(' / ');
    const queued = allyCommandQueue.snapshot(state);
    const heldAllies = (['P2', 'P3'] as const).filter(allyId => state.allyOrders[allyId]?.generation === state.actors[allyId].generation);
    allyOrderHint.textContent = queued.length > 0
      ? `${queued.map(command => `${command.allyId}：${command.kind === 'hold' ? '守備' : '補給'}`).join('・')}の指示を待機中。もう一度押すと、その人への指示だけ取り消せます。`
      : heldAllies.length > 0
        ? `${heldAllies.join('・')}は現在位置を保持中。同室の敵だけを防衛します。`
        : '守備中は現在位置を保ち、同室の敵だけを防衛します。';
  };
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
    title.textContent = ended ? '通常戦を終了しました' : paused ? '一時停止中' : '開始まで';
    description.textContent = ended ? '勝敗が確定しました。結果詳細・スコア・ランキングは次の段階です。' : paused ? '再開ボタンを押すまで、戦場も時計も止まります。' : '左のパッドで移動。敵と接触したら近接攻撃、突進はボタンまたはSpace';
    terminalResult.hidden = !ended;
    if (ended) {
      const bothCoresHit = state.castles.player.core.hit && state.castles.enemy.core.hit;
      const neitherCoreHit = !state.castles.player.core.hit && !state.castles.enemy.core.hit;
      terminalResult.textContent = state.outcome === 'player_win' ? '勝利 — 敵コアへの有効命中'
        : state.outcome === 'enemy_win' ? '敗北 — 自陣コアへの有効命中'
          : bothCoresHit ? '引き分け — 同一更新内の同時コア命中'
            : neitherCoreHit ? '引き分け — 時間切れ' : '引き分け';
    } else terminalResult.textContent = '';
    resume.hidden = !paused || ended;
    leave.textContent = countdown > 0 && !ended ? '準備を中止する' : 'ホームへ戻る';
    for (const child of screen.children) {
      if (child instanceof HTMLElement && child !== overlay && child !== help) child.inert = !overlay.hidden;
    }
    movement.setEnabled(canInteract() && state.actors.P1.alive);
    const dashEnabled = canStartDash();
    dashInput.setEnabled(dashEnabled);
    dashButton.disabled = !dashEnabled;
    const attackEnabled = canInteract() && state.actors.P1.alive && !playerProtected() && !state.dashes.P1 &&
      pending === undefined && (pendingAttack || getInteraction(state, 'P1', slot).attackTargetId !== undefined);
    attackInput.setEnabled(attackEnabled);
    attackButton.disabled = !attackEnabled;
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
  for (const allyId of ['P2', 'P3'] as const) {
    allyOrderButtons[allyId].addEventListener('click', () => {
      if (!canInteract() || !state.actors.P1.alive || !state.actors[allyId].alive) return;
      allyCommandQueue.toggle(state, allyId);
      lastHud = '';
      updateAllyOrderControls();
    }, options);
  }
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
    const attackTargetId = interaction.attackTargetId;
    const supplyPreview = getPlayerSupplyPreview(state);
    const equipmentTargetsSignature = interaction.equipmentRepairTargets.map(target => `${target.kind}:${target.id}:${target.health}:${target.disabledUntilTick}`);
    const dashCooldownRemaining = Math.max(0, (state.dashCooldownUntilTick.P1 ?? 0) - state.tick);
    const dashStatusText = !actor.alive ? '観戦中'
      : state.phase === 'ended' ? '戦闘終了'
        : countdown > 0 ? '開始前'
          : paused || document.hidden || help.open || state.phase !== 'running' ? '操作停止中'
            : playerProtected() ? '復活保護中'
              : pendingDash ? '次の更新で開始'
                : state.dashes.P1 ? '突進中'
                  : dashCooldownRemaining > 0 ? `再使用 ${Math.ceil(dashCooldownRemaining / 60)}秒`
                    : '使用可能 · Space';
    const cooldownLength = Math.max(1, state.rules.dashCooldownTicks);
    const dashProgressValue = Math.max(0, Math.min(1, 1 - dashCooldownRemaining / cooldownLength));
    dashStatus.textContent = dashStatusText;
    dashButton.disabled = !canStartDash();
    dashButton.setAttribute('aria-label', `突進。${dashStatusText}`);
    dashProgress.style.transform = `scaleX(${dashProgressValue})`;
    const attackStatusText = !actor.alive ? '観戦中' : pendingAttack ? '次の更新で開始' : attackTargetId ? '近接攻撃' : '敵に近づく';
    attackLabel.textContent = attackStatusText;
    attackButton.disabled = !canStartAttack();
    attackButton.setAttribute('aria-label', attackTargetId ? `近接攻撃。対象 ${attackTargetId}` : `近接攻撃。${attackStatusText}`);
    updateAllyOrderControls();
    const signature = JSON.stringify([Math.floor(state.tick / 60), actor.alive, actor.generation, actor.location, actor.currentRoomId, actor.respawnAtTick, canInteract(), paused, countdown > 0, state.phase, state.visibility, available, nearest?.id, attackTargetId, cargo.map(item => item?.id), slot, equipmentTargetsSignature, state.logistics.bagCycles.player, state.logistics.bagIndices.player, supplyPreview, state.castles.player.destroyedPartIds, state.castles.enemy.destroyedPartIds, PART_IDS.map(id => [state.castles.player.exterior[id].health, state.castles.enemy.exterior[id].health]), Math.ceil(dashCooldownRemaining / 60), state.dashes.P1?.remainingTicks, pendingDash, pendingAttack, allyCommandQueue.snapshot(state), state.allyOrders, playerDashStarts, state.outcome, dashStatusText, attackStatusText]);
    screen.dataset.tick = String(state.tick); screen.dataset.phase = countdown ? 'countdown' : paused ? 'paused' : state.phase;
    screen.dataset.spectating = String(!actor.alive);
    screen.dataset.playerX = String(state.fixedActors.P1.position.x); screen.dataset.playerY = String(state.fixedActors.P1.position.y);
    screen.dataset.playerOperatedLaunches = String(playerOperatedLaunches);
    screen.dataset.playerDashStarts = String(playerDashStarts);
    screen.dataset.playerGeneration = String(actor.generation);
    screen.dataset.outcome = state.outcome;
    screen.dataset.playerSupplyPreview = supplyPreview.join(',');
    screen.dataset.attackTarget = attackTargetId ?? '';
    screen.dataset.allyP2Order = state.allyOrders.P2?.kind ?? 'supply';
    screen.dataset.allyP3Order = state.allyOrders.P3?.kind ?? 'supply';
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
  let resultShown = false;
  const showResult = () => {
    if (resultShown || disposed) return;
    const outcome = state.outcome;
    if (outcome === 'ongoing') return;
    resultShown = true;
    // Release battle listeners before the result region owns keyboard scrolling.
    movement.dispose(); dashInput.dispose(); attackInput.dispose(); events.abort();
    const terminalOutcome: BattleOutcome = outcome;
    const title = terminalOutcome === 'player_win' ? '勝利'
      : terminalOutcome === 'enemy_win' ? '敗北' : '引き分け';
    const resultReason: BattleResultReason = terminalOutcome === 'player_win' ? 'enemy_core_hit'
      : terminalOutcome === 'enemy_win' ? 'player_core_hit'
        : state.castles.player.core.hit && state.castles.enemy.core.hit ? 'simultaneous_core_hit' : 'time_limit';
    const reason = terminalOutcome === 'player_win' ? '敵コアへの有効命中'
      : terminalOutcome === 'enemy_win' ? '自陣コアへの有効命中'
        : state.castles.player.core.hit && state.castles.enemy.core.hit ? '同一更新内の同時コア命中' : '時間切れ';
    const elapsedSeconds = Math.floor(state.tick / 60);
    const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
    const outcomeClass = terminalOutcome === 'player_win' ? 'is-win' : terminalOutcome === 'enemy_win' ? 'is-loss' : 'is-draw';
    const resultRecord = sessionStore.finish(state.matchId, {
      matchId: state.matchId,
      outcome: terminalOutcome,
      reason: resultReason,
      endedTick: state.tick,
      enemyExteriorDestroyed: state.castles.enemy.destroyedPartIds.length,
      enemyGatesOpened: state.castles.enemy.openGateIds.length,
      playerOperatedLaunches,
      playerDashStarts,
      combatMetrics: projectBattleResultMetrics(state),
    });
    const savedResult = resultRecord.result!.payload;
    const combatMetrics = savedResult.combatMetrics!;
    app.innerHTML = `<section class="battle-result ${outcomeClass}" aria-label="通常戦の結果" data-flow="normal-result" data-outcome="${terminalOutcome}" data-match-id="${state.matchId}" data-tick="${state.tick}" data-player-dash-starts="${playerDashStarts}" data-start-record-id="${resultRecord.start.id}" data-result-submission-id="${resultRecord.result?.submissionId ?? ''}" data-record-connection="${resultRecord.connection}" data-record-persistence="${sessionStore.persistent ? 'session' : 'memory'}" data-start-record-status="${resultRecord.start.status}" data-result-record-status="${resultRecord.result?.status ?? 'idle'}">
      <div class="result-scroll" tabindex="0" role="region" aria-label="結果の詳細">
      <p class="eyebrow">通常戦の結果</p><h1>${title}</h1><p class="result-reason" data-result-reason>${reason}</p>
      <p class="result-player">プレイヤー：<strong data-result-player-name></strong></p>
      <dl class="result-metrics" aria-label="実戦の記録">
        <div><dt>経過時間</dt><dd>${elapsed}</dd></div>
        <div><dt>敵外装</dt><dd>${savedResult.enemyExteriorDestroyed}/7 破壊</dd></div>
        <div><dt>敵の門</dt><dd>${savedResult.enemyGatesOpened}/7 開放</dd></div>
        <div><dt>主人公の砲撃</dt><dd>${savedResult.playerOperatedLaunches} 発</dd></div>
        <div><dt>倒した敵の延べ回数</dt><dd data-result-enemy-defeats-total>${combatMetrics.enemyDefeatsTotal} 回</dd></div>
        <div><dt>一度でも倒した敵</dt><dd data-result-enemy-unique-defeats>${combatMetrics.enemyUniqueDefeats}/30 人</dd></div>
        <div><dt>主人公が倒れた回数</dt><dd data-result-player-deaths>${combatMetrics.playerDeaths} 回</dd></div>
      </dl>
      <p class="result-detail-note">敵を倒した記録は味方全体の合計です。同じ敵を復活後に倒した分は、延べ回数だけに加えます。</p>
      <section class="result-section" aria-labelledby="result-score-title"><h2 id="result-score-title">スコア</h2><p data-result-score-status="pending">得点式の承認待ちです。現在は表示しません。</p></section>
      <section class="result-section" aria-labelledby="result-ranking-title"><h2 id="result-ranking-title">ランキング・共有</h2><p data-result-ranking-status="unavailable">共有側のゲーム登録値（game_id / game_slug / URL）確認待ちです。外部送信は行いません。開始・結果のローカル記録は同じ試合IDに保持します。</p></section>
      <p class="result-note">次の試合は新しい試合状態として開始され、今回の入力・物体・復活状態を持ち越しません。</p>
      </div>
      <div class="result-actions"><button id="restart-battle" class="primary">再戦の準備へ</button><button id="result-home">ホームへ戻る</button><button id="download-replay" type="button">戦闘記録を保存</button></div>
    </section>`;
    app.querySelector<HTMLElement>('[data-result-player-name]')!.textContent = name;
    const replayData = JSON.stringify(recorder.snapshot());
    try { localStorage.setItem('semekome-last-replay', replayData); } catch { /* Download remains available when storage is full. */ }
    app.querySelector('#download-replay')!.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([replayData], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `semekome-replay-${state.matchId}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    app.querySelector<HTMLButtonElement>('#restart-battle')!.addEventListener('click', onReplay, { once: true });
    app.querySelector<HTMLButtonElement>('#result-home')!.addEventListener('click', goHome, { once: true });
  };
  const loop = (now: number) => {
    if (disposed) return;
    if (!paused && state.phase !== 'ended') {
      const step = clock.advance(now);
      if (step.interrupted) stop();
      else for (let index = 0; index < step.ticks; index++) {
        if (countdown > 0) { countdown--; if (countdown === 0) clearInput(); }
        else {
          const wasAlive = state.actors.P1.alive;
          if (!wasAlive) {
            releaseInput(); movement.setEnabled(false); dashInput.setEnabled(false); attackInput.setEnabled(false);
            state = recorder.step(state, undefined);
            if (state.actors.P1.alive) { clearInput(false); lastHud = ''; }
          } else {
            const allyCommand = allyCommandQueue.take(state);
            const intent: BattleIntent = {
              ...pending,
              ...(pendingDash ? { dash: { ...pendingDash } } : {}),
              ...(pendingAttack ? { attack: true } : {}),
              ...(allyCommand ? { allyCommand } : {}),
              matchId: state.matchId,
              actorId: 'P1',
              generation: pending?.generation ?? state.actors.P1.generation,
              direction: movement.direction(),
              slot: pending?.slot ?? slot,
              route: pending?.route ?? route,
              part: pending?.part ?? part,
            };
            pending = undefined;
            pendingDash = undefined;
            pendingAttack = false;
            state = recorder.step(state, intent);
            if (state.lastStep.acceptedInputKinds.includes('dash')) playerDashStarts++;
          }
          render.observeStep(state);
          if (wasAlive && !state.actors.P1.alive) { clearInput(false); movement.setEnabled(false); dashInput.setEnabled(false); attackInput.setEnabled(false); lastHud = ''; }
          playerOperatedLaunches += state.lastStep.events.filter(event => event.type === 'projectile_launched' && event.sourceActorId === 'P1').length;
          if (state.phase === 'ended') {
            clearInput(); movement.setEnabled(false); dashInput.setEnabled(false); attackInput.setEnabled(false); lastHud = '';
            break;
          }
        }
      }
    } else clock.reset();
    updateOverlay(); updateHud(); render(state, part, slot);
    if (state.phase === 'ended') { showResult(); frame = 0; return; }
    frame = requestAnimationFrame(loop);
  };
  if (document.hidden) { state = setBattleVisibility(state, false); stop(); }
  updateOverlay(); updateHud(); render(state, part, slot);
  frame = requestAnimationFrame(loop);
  return () => { disposed = true; cancelAnimationFrame(frame); movement.dispose(); dashInput.dispose(); attackInput.dispose(); events.abort(); pending = undefined; pendingDash = undefined; pendingAttack = false; allyCommandQueue.clear(); };
}
