import { test, expect, type Page } from '@playwright/test';

async function startBattle(page: Page, name: string) {
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill(name);
  await page.getByRole('button', { name: '確認を開始する' }).click();
  const battle = page.locator('.battle');
  for (let attempt = 0; attempt < 40 && await battle.getAttribute('data-phase') !== 'running'; attempt += 1) {
    await page.clock.runFor(100);
  }
  await expect(battle).toHaveAttribute('data-phase', 'running');
  await expect(page.locator('.battle-overlay')).toBeHidden();
  await page.locator('.ally-orders summary').click();
  return battle;
}

async function freezeBrowserClock(page: Page) {
  // Only the browser clock is controlled; actors and the battle use normal initial state.
  await page.clock.install({ time: new Date('2026-10-01T09:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-01T09:01:00Z'));
  await page.goto('/');
}

async function command(page: Page, ally: 'P2' | 'P3', kind: 'follow' | 'collect' | 'artillery') {
  await page.locator(`[data-ally-kind="${ally}"]`).selectOption(kind);
  await page.locator(`[data-ally-submit="${ally}"]`).click();
}

test('次の戦闘更新前のP2/P3連続指示は両方届き、片方の上書きが他方を消さない', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await freezeBrowserClock(page);
  const battle = await startBattle(page, '二人への指示');
  const status = page.locator('#ally-order-status');
  const before = await battle.getAttribute('data-tick');
  await command(page, 'P3', 'follow');
  await command(page, 'P2', 'follow');
  await expect(battle).toHaveAttribute('data-tick', before!);
  await expect(status).toContainText('P2：引率・同行を指示待ち');
  await expect(status).toContainText('P3：引率・同行を指示待ち');
  await page.clock.runFor(100);
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'follow');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'follow');
  await expect(status).not.toContainText('指示待ち');

  // Replace only P2's queued supply order; P3's queued supply survives.
  await page.locator('[data-squad-command="collect"]').click();
  await command(page, 'P2', 'follow');
  await expect(status).toContainText('P2：引率・同行を指示待ち');
  await expect(status).toContainText('P3：弾回収・運搬を指示待ち');
  await page.clock.runFor(100);
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'follow');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'collect');
  await expect(status).not.toContainText('指示待ち');

  // Different commands coexist in either submission order.
  await command(page, 'P2', 'collect');
  await command(page, 'P3', 'follow');
  await page.clock.runFor(100);
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'collect');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'follow');
  await expect(status).not.toContainText('指示待ち');
  expect(errors).toEqual([]);
});

test('待機中の二人への指示は停止・説明で取り消され、新しい試合へ持ち越さない', async ({ page }) => {
  test.setTimeout(60_000);
  await freezeBrowserClock(page);
  const battle = await startBattle(page, '指示の取消し');
  const matchId = await battle.getAttribute('data-match-id');
  const queueBoth = async () => {
    await page.locator('[data-squad-command="follow"]').click();
    await expect(page.locator('#ally-order-status')).toContainText('P2：引率・同行を指示待ち');
    await expect(page.locator('#ally-order-status')).toContainText('P3：引率・同行を指示待ち');
  };
  const expectSupply = async () => {
    await expect(battle).toHaveAttribute('data-ally-p2-order', 'supply');
    await expect(battle).toHaveAttribute('data-ally-p3-order', 'supply');
    await expect(page.locator('#ally-order-status')).not.toContainText('指示待ち');
  };

  await queueBoth();
  await page.locator('#pause-battle').click();
  await page.clock.runFor(100);
  await expect(battle).toHaveAttribute('data-phase', 'paused');
  await expectSupply();
  await page.getByRole('button', { name: '再開する' }).click();
  await page.clock.runFor(100);
  await expectSupply();

  await queueBoth();
  await page.getByRole('button', { name: '操作説明' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.clock.runFor(100);
  await expectSupply();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: '再開する' }).click();
  await page.clock.runFor(100);
  await expectSupply();

  await queueBoth();
  await page.clock.runFor(100);
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'follow');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'follow');
  await page.locator('#pause-battle').click();
  await page.getByRole('button', { name: 'ホームへ戻る', exact: true }).click();
  await expect(page.getByRole('button', { name: '通常戦を始める' })).toBeVisible();
  await startBattle(page, '次の試合');
  await expect(battle).not.toHaveAttribute('data-match-id', matchId!);
  await expectSupply();
});

for (const first of ['attack', 'dash'] as const) {
  test(`${first === 'attack' ? '攻撃' : '突進'}を先に押した同時入力でも二人への指示が失われない`, async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // A contact/input boundary fixture, separate from normal initial-battle tests.
    await page.route('**/src/simulation/physical-battle.ts', async route => {
      const response = await route.fetch();
      let body = await response.text();
      expect(body).toContain('export function createBattle(');
      body = body.replace('export function createBattle(', 'function fixtureCreateBattle(');
      body += `
        export function createBattle(options) {
          const state = fixtureCreateBattle(options);
          for (const actor of Object.values(state.actors)) actor.protectedUntilTick = 10000;
          for (const [id, x] of [['P1', 63000], ['E29', 67000]]) {
            const actor = state.actors[id];
            actor.location = { area: 'plaza', pathRooms: [], pathGates: [] };
            actor.currentRoomId = 'plaza';
            actor.position = { x: Math.floor(x / 1000), y: 35 };
            actor.protectedUntilTick = null;
            actor.damageImmuneUntilTick = null;
            state.fixedActors[id] = { position: { x, y: 35000 }, remainder: { x: 0, y: 0 } };
          }
          // Keep the contact boundary stable while the screen leaves its countdown.
          state.enemyDecisions.E29 = {
            generation: state.actors.E29.generation,
            nextDecisionTick: 10000,
            intent: { kind: 'wait', reason: 'input-composition-fixture' }
          };
          return state;
        }
      `;
      await route.fulfill({ response, body });
    });
    await freezeBrowserClock(page);
    const battle = await startBattle(page, '行動と二人への指示');
    const before = await battle.getAttribute('data-tick');
    await page.locator('[data-squad-command="follow"]').click();
    // Leave the command button so keyboard action keys target the battlefield.
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    await page.keyboard.press(first === 'attack' ? 'x' : 'Space');
    await page.keyboard.press(first === 'attack' ? 'Space' : 'x');
    await expect(battle).toHaveAttribute('data-tick', before!);
    await page.clock.runFor(100);
    await expect(battle).toHaveAttribute('data-ally-p2-order', 'follow');
    await expect(battle).toHaveAttribute('data-ally-p3-order', 'follow');
    await expect(battle).toHaveAttribute('data-player-dash-starts', first === 'dash' ? '1' : '0');
    await expect(battle).toHaveAttribute('data-player-shots', first === 'attack' ? '1' : '0');
    await expect(page.locator('#ally-order-status')).not.toContainText('指示待ち');
    expect(errors).toEqual([]);
  });
}

test('同型の補助員を選び、同行・砲撃命令を別々に送れる', async ({ page }) => {
  await freezeBrowserClock(page);
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill('編成と正式命令');
  await page.locator('[data-support-type]').nth(0).selectOption('mechanic');
  await page.locator('[data-support-type]').nth(1).selectOption('mechanic');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  const battle = page.locator('.battle');
  for (let attempt = 0; attempt < 40 && await battle.getAttribute('data-phase') !== 'running'; attempt++) await page.clock.runFor(100);
  await page.locator('.ally-orders summary').click();
  await page.locator('[data-ally-kind="P2"]').selectOption('follow');
  await page.locator('[data-ally-submit="P2"]').click();
  await page.locator('[data-ally-kind="P3"]').selectOption('artillery');
  await page.locator('[data-ally-submit="P3"]').click();
  await page.clock.runFor(100);
  await expect(page.locator('#ally-order-status')).toContainText('P2：引率・同行');
  await expect(page.locator('#ally-order-status')).toContainText('P3：砲撃');
  await expect(page.locator('#battle-dash')).toBeInViewport();
  await page.locator('[data-ally-kind="P2"]').selectOption('collect');
  await page.locator('[data-ally-submit="P2"]').click();
  await page.clock.runFor(100);
  await expect(page.locator('#ally-order-status')).toContainText('P2：弾回収・運搬');
  await expect(page.locator('#ally-order-status')).toContainText('P3：砲撃');
});
