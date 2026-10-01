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

test('次の戦闘更新前のP2/P3連続指示は両方届き、片方の取消しが他方を消さない', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await freezeBrowserClock(page);
  const battle = await startBattle(page, '二人への指示');
  const p2 = page.locator('#ally-p2-command');
  const p3 = page.locator('#ally-p3-command');

  const before = await battle.getAttribute('data-tick');
  await p3.click();
  await p2.click();
  await expect(battle).toHaveAttribute('data-tick', before!);
  await expect(p2).toHaveAttribute('data-pending-order', 'hold');
  await expect(p3).toHaveAttribute('data-pending-order', 'hold');
  await expect(p2).toContainText('守備の指示を取り消す');
  await expect(p3).toContainText('守備の指示を取り消す');
  await page.clock.runFor(100);
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'hold');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'hold');
  await expect(p2).toHaveAttribute('data-pending-order', '');
  await expect(p3).toHaveAttribute('data-pending-order', '');

  // Cancel only P2's pending supply command while retaining P3's.
  await p2.click();
  await p3.click();
  await p2.click();
  await expect(p2).toHaveAttribute('data-pending-order', '');
  await expect(p3).toHaveAttribute('data-pending-order', 'supply');
  await page.clock.runFor(100);
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'hold');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'supply');

  // Different commands can coexist without replacing the other actor's command.
  await p2.click();
  await p3.click();
  await expect(p2).toHaveAttribute('data-pending-order', 'supply');
  await expect(p3).toHaveAttribute('data-pending-order', 'hold');
  await page.clock.runFor(100);
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'supply');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'hold');
  expect(errors).toEqual([]);
});

test('待機中の二人への指示は停止・説明で取り消され、新しい試合へ持ち越さない', async ({ page }) => {
  test.setTimeout(60_000);
  await freezeBrowserClock(page);
  const battle = await startBattle(page, '指示の取消し');
  const matchId = await battle.getAttribute('data-match-id');
  const p2 = page.locator('#ally-p2-command');
  const p3 = page.locator('#ally-p3-command');
  const queueBoth = async () => { await p2.click(); await p3.click(); };
  const expectSupply = async () => {
    await expect(battle).toHaveAttribute('data-ally-p2-order', 'supply');
    await expect(battle).toHaveAttribute('data-ally-p3-order', 'supply');
    await expect(p2).toHaveAttribute('data-pending-order', '');
    await expect(p3).toHaveAttribute('data-pending-order', '');
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
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'hold');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'hold');
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
          for (const [id, x] of [['P1', 63000], ['E29', 63500]]) {
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
    await expect(battle).toHaveAttribute('data-attack-target', 'E29');
    const before = await battle.getAttribute('data-tick');
    await page.locator('#ally-p2-command').click();
    await page.locator('#ally-p3-command').click();
    // Leave the command button so keyboard action keys target the battlefield.
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    await page.keyboard.press(first === 'attack' ? 'x' : 'Space');
    await page.keyboard.press(first === 'attack' ? 'Space' : 'x');
    await expect(battle).toHaveAttribute('data-tick', before!);
    await page.clock.runFor(100);
    await expect(battle).toHaveAttribute('data-ally-p2-order', 'hold');
    await expect(battle).toHaveAttribute('data-ally-p3-order', 'hold');
    await expect(battle).toHaveAttribute('data-player-dash-starts', first === 'dash' ? '1' : '0');
    await expect(page.locator('#ally-p2-command')).toHaveAttribute('data-pending-order', '');
    await expect(page.locator('#ally-p3-command')).toHaveAttribute('data-pending-order', '');
    expect(errors).toEqual([]);
  });
}

test('同型の補助員を選び、正式な防衛・砲撃命令を別々に送れる', async ({ page }) => {
  await freezeBrowserClock(page);
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill('編成と正式命令');
  await page.locator('[data-support-type]').nth(0).selectOption('mechanic');
  await page.locator('[data-support-type]').nth(1).selectOption('mechanic');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  const battle = page.locator('.battle');
  for (let attempt = 0; attempt < 40 && await battle.getAttribute('data-phase') !== 'running'; attempt++) await page.clock.runFor(100);
  await page.locator('.ally-orders summary').click();
  await page.locator('[data-ally-kind="P2"]').selectOption('defense');
  await page.locator('[data-ally-room="P2"]').selectOption('repair');
  await page.locator('[data-ally-submit="P2"]').click();
  await page.locator('[data-ally-kind="P3"]').selectOption('artillery');
  await page.locator('[data-ally-submit="P3"]').click();
  await page.clock.runFor(100);
  await expect(page.locator('#ally-order-status')).toContainText('P2 整備型：防衛');
  await expect(page.locator('#ally-order-status')).toContainText('P3 整備型：砲撃');
  await expect(page.locator('#battle-dash')).toBeInViewport();
  await page.locator('[data-ally-kind="P2"]').selectOption('supply');
  await page.locator('[data-ally-submit="P2"]').click();
  await page.clock.runFor(100);
  await expect(page.locator('#ally-order-status')).toContainText('P2 整備型：通常業務');
  await expect(page.locator('#ally-order-status')).toContainText('P3 整備型：砲撃');
});
