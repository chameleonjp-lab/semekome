import { test, expect, type Page } from '@playwright/test';

async function start(page: Page) {
  await page.clock.install({ time: new Date('2026-09-27T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-27T00:01:00Z'));
  await page.goto('/');
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill('突進検査');
  await page.getByRole('button', { name: '確認を開始する' }).click();
}

// Test-only module interception. No fixture controls or mutable state are
// exposed by the production app. These are boundary tests, not a complete
// playthrough from the standard initial position.
async function fixture(page: Page, mode: 'core' | 'spectator' | 'enemy_win' | 'double_core' | 'timeout') {
  await page.route('**/src/simulation/physical-battle.ts', async route => {
    const response = await route.fetch();
    let body = await response.text();
    expect(body).toContain('export function createBattle(');
    expect(body).toContain('export function stepBattle(');
    body = body.replace('export function createBattle(', 'function fixtureCreateBattle(')
      .replace('export function stepBattle(', 'function fixtureStepBattle(');
    body += `
      export function createBattle(options) {
        const state = fixtureCreateBattle(options);
        globalThis.__battleTrace = { deadIntents: 0, stepsAfterEnd: 0, outcomes: 0, generation: 0 };
        const mode = ${JSON.stringify(mode)};
        if (mode === 'core') {
          const castle = state.castles.enemy;
          const layout = state.layout.enemy;
          for (const part of Object.values(castle.exterior)) { part.health = 0; part.destroyed = true; }
          castle.destroyedPartIds = Object.keys(castle.exterior);
          for (const gate of Object.values(castle.gates)) gate.open = true;
          castle.openGateIds = [...layout.coreRouteGates];
          const room = layout.rooms.find(room => room.id === 'core');
          const point = { x: (room.rect.x0 + room.rect.x1) * 500 - 1700, y: (room.rect.y0 + room.rect.y1) * 500 };
          const actor = state.actors.P1;
          actor.currentRoomId = 'core';
          actor.location = { area: 'castle', castleTeam: 'enemy', roomId: 'core', pathRooms: [...layout.coreRouteRooms], pathGates: [...layout.coreRouteGates] };
          actor.position = { x: Math.floor(point.x / 1000), y: Math.floor(point.y / 1000) };
          state.fixedActors.P1.position = point;
          state.fixedActors.P1.remainder = { x: 0, y: 0 };
        } else if (mode === 'spectator') {
          const actor = state.actors.P1;
          actor.alive = false; actor.health = 0; actor.respawnAtTick = 300;
        } else if (mode === 'timeout') {
          state.tick = state.matchLimitTicks - 1;
        } else {
          state.phase = 'ended';
          state.outcome = mode === 'enemy_win' ? 'enemy_win' : 'draw';
          state.castles.player.core.hit = true;
          state.castles.enemy.core.hit = mode === 'double_core';
        }
        return state;
      }
      export function stepBattle(state, intent) {
        const trace = globalThis.__battleTrace;
        if (!state.actors.P1.alive && intent) trace.deadIntents++;
        if (state.phase === 'ended') trace.stepsAfterEnd++;
        const next = fixtureStepBattle(state, intent);
        trace.outcomes += next.lastStep.events.filter(event => event.type === 'outcome').length;
        trace.generation = next.actors.P1.generation;
        return next;
      }
    `;
    await route.fulfill({ response, body });
  });
}

const trace = (page: Page) => page.evaluate(() => (globalThis as unknown as {
  __battleTrace: { deadIntents: number; stepsAfterEnd: number; outcomes: number; generation: number };
}).__battleTrace);

test('画面の突進は初期右向き・一押し一回で、待機中とSpace長押しでは再発動しない', async ({ page }) => {
  await start(page);
  await expect(page.locator('#battle-dash')).toBeDisabled();
  await page.clock.runFor(3100);
  const battle = page.locator('.battle');
  const initialX = Number(await battle.getAttribute('data-player-x'));
  // Native keyboard input, with focus outside all form/button controls.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.down('Space');
  await page.clock.runFor(250);
  await expect(battle).toHaveAttribute('data-player-x', String(initialX + 1200));
  await expect(page.locator('#battle-dash')).toBeDisabled();
  await page.keyboard.down('Space'); // repeat
  await page.clock.runFor(1000);
  await expect(battle).toHaveAttribute('data-player-x', String(initialX + 1200));
  await page.keyboard.up('Space');
  await page.keyboard.press('Space');
  await page.clock.runFor(250);
  await expect(battle).toHaveAttribute('data-player-x', String(initialX + 2400));
});

test('停止中は最後の移動方向へ突進し、停止・説明・非表示で予約入力を消す', async ({ page }) => {
  await start(page);
  await page.clock.runFor(3100);
  const battle = page.locator('.battle');
  await page.keyboard.down('ArrowLeft');
  await page.clock.runFor(100);
  await page.keyboard.up('ArrowLeft');
  const x = Number(await battle.getAttribute('data-player-x'));
  await page.locator('#battle-dash').click();
  await page.clock.runFor(250);
  await expect(battle).toHaveAttribute('data-player-x', String(x - 1200));
  await page.clock.runFor(900);
  await page.locator('#battle-dash').click(); // queued, no frame yet
  await page.locator('#pause-battle').click();
  await page.clock.runFor(500);
  await page.getByRole('button', { name: '再開する' }).click();
  await page.clock.runFor(250);
  await expect(battle).toHaveAttribute('data-player-x', String(x - 1200));
  await page.locator('#battle-help').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: '再開する' }).click();
  await page.clock.runFor(250);
  await expect(battle).toHaveAttribute('data-player-x', String(x - 1200));
  await page.locator('#battle-dash').click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(100);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: '再開する' }).click();
  await page.clock.runFor(250);
  await expect(battle).toHaveAttribute('data-player-x', String(x - 1200));
});

test('実核手前の境界fixtureから画面の突進で一度だけ勝利し、同フレームの残り更新も止まる', async ({ page }) => {
  await fixture(page, 'core');
  await start(page);
  await page.clock.runFor(3100);
  await expect(page.locator('.battle')).toHaveAttribute('data-phase', 'running');
  await page.locator('#battle-dash').click();
  await page.clock.runFor(250);
  await expect(page.locator('.battle')).toHaveAttribute('data-phase', 'ended');
  await expect(page.locator('.battle-overlay')).toContainText('勝利');
  await expect(page.getByRole('button', { name: '再開する' })).toBeHidden();
  const tick = await page.locator('.battle').getAttribute('data-tick');
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.clock.runFor(500);
  await expect(page.locator('.battle')).toHaveAttribute('data-tick', tick!);
  expect(await trace(page)).toMatchObject({ stepsAfterEnd: 0, outcomes: 1 });
  const match = await page.locator('.battle').getAttribute('data-match-id');
  await page.getByRole('button', { name: 'ホームへ戻る' }).click();
  await expect(page.locator('.battle')).toHaveCount(0);
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill('次の試合');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await expect(page.locator('.battle')).not.toHaveAttribute('data-match-id', match!);
  await expect(page.locator('.battle')).toHaveAttribute('data-tick', '0');
  await expect(page.locator('.battle')).toHaveAttribute('data-player-dash-starts', '0');
});

test('観戦中は入力を送らず世界が進み、5秒復活と保護期間を経て新しい押下だけ受け付ける', async ({ page }) => {
  await fixture(page, 'spectator');
  await start(page);
  await page.clock.runFor(3100);
  const battle = page.locator('.battle');
  await expect(battle).toHaveAttribute('data-spectating', 'true');
  await expect(page.locator('#battle-dash')).toBeDisabled();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('Space');
  await page.clock.runFor(4700);
  await expect(battle).toHaveAttribute('data-spectating', 'true');
  expect(Number(await battle.getAttribute('data-tick'))).toBeGreaterThan(270);
  expect((await trace(page)).deadIntents).toBe(0);
  await page.clock.runFor(300);
  await expect(battle).toHaveAttribute('data-spectating', 'false');
  await expect(page.locator('#battle-dash')).toBeDisabled();
  const x = await battle.getAttribute('data-player-x');
  await page.clock.runFor(1100);
  await expect(battle).toHaveAttribute('data-player-x', x!);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.up('Space');
  await page.locator('#battle-dash').click();
  await page.clock.runFor(250);
  expect(Number(await battle.getAttribute('data-player-x'))).toBeGreaterThan(Number(x));
  expect((await trace(page)).generation).toBe(1);
});

for (const [mode, label] of [['enemy_win', '敗北'], ['double_core', '同時'], ['timeout', '時間切れ']] as const) {
  test(`終局状態の表示fixture：${label}と操作停止`, async ({ page }) => {
    await fixture(page, mode);
    await start(page);
    await page.clock.runFor(3100);
    await expect(page.locator('.battle-overlay')).toContainText(label);
    await expect(page.locator('#battle-dash')).toBeDisabled();
    const tick = await page.locator('.battle').getAttribute('data-tick');
    await page.clock.runFor(500);
    await expect(page.locator('.battle')).toHaveAttribute('data-tick', tick!);
    expect((await trace(page)).stepsAfterEnd).toBe(0);
  });
}
