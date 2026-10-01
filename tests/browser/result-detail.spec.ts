import { test, expect } from '@playwright/test';

test('結果の集計と保存値が一致し、短い画面や文字拡大でも再戦とホームを押せる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // A result-display boundary fixture, not a standard-battle victory test.
  // Seed cumulative actor counts and shorten the active battle to one second.
  // The real stepBattle still commits the time-limit draw and result record.
  await page.route('**/src/simulation/physical-battle.ts', async route => {
    const response = await route.fetch();
    let body = await response.text();
    expect(body).toContain('export function createBattle(');
    body = body.replace('export function createBattle(', 'function fixtureCreateBattle(');
    body += `
      export function createBattle(options) {
        const state = fixtureCreateBattle(options);
        state.matchLimitTicks = 60;
        if (!globalThis.__resultDetailFixtureStarted) {
          state.actors.E01.deathCount = 3;
          state.actors.E30.deathCount = 1;
          state.actors.P1.deathCount = 2;
          state.actors.P2.deathCount = 7;
          globalThis.__resultDetailFixtureStarted = true;
        }
        return state;
      }
    `;
    await route.fulfill({ response, body });
  });
  await page.clock.install({ time: new Date('2026-10-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-01T00:01:00Z'));
  await page.goto('/');
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill('結果の詳細検査');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await page.clock.runFor(4_200);
  const result = page.locator('.battle-result');
  await expect(result).toHaveAttribute('data-outcome', 'draw');
  await expect(result.locator('[data-result-enemy-defeats-total]')).toHaveText('4 回');
  await expect(result.locator('[data-result-enemy-unique-defeats]')).toHaveText('2/30 人');
  await expect(result.locator('[data-result-player-deaths]')).toHaveText('2 回');
  const matchId = await result.getAttribute('data-match-id');
  const stored = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), `semekome:battle-session:${matchId}`);
  expect(stored.result.payload.combatMetrics).toEqual({ enemyDefeatsTotal: 4, enemyUniqueDefeats: 2, playerDeaths: 2 });

  const restart = page.getByRole('button', { name: '再戦の準備へ' });
  const home = page.getByRole('button', { name: 'ホームへ戻る', exact: true });
  const detail = page.getByRole('region', { name: '結果の詳細' });
  for (const viewport of [
    { width: 360, height: 480 }, { width: 390, height: 664 },
    { width: 402, height: 700 }, { width: 430, height: 932 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
    for (const button of [restart, home]) {
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(48);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 664 });
  await detail.evaluate(element => { element.scrollTop = 0; });
  await detail.focus();
  await expect(detail).toBeFocused();
  const spacePrevented = await detail.evaluate(element => !element.dispatchEvent(
    new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }),
  ));
  expect(spacePrevented).toBe(false);
  await page.keyboard.press('Space');
  await page.clock.runFor(600);
  await expect.poll(() => detail.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Tab');
  await expect(restart).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(home).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(restart).toBeFocused();
  await page.addStyleTag({ content: ':root { font-size: 200%; }' });
  for (const button of [restart, home]) {
    const bounds = await button.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(664);
  }
  await restart.click();
  await expect(page.locator('.battle-setup')).toBeVisible();
  await page.getByLabel('あなたの名前').fill('新しい試合');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await page.clock.runFor(4_200);
  await expect(result).not.toHaveAttribute('data-match-id', matchId!);
  await expect(result.locator('[data-result-enemy-defeats-total]')).toHaveText('0 回');
  await expect(result.locator('[data-result-enemy-unique-defeats]')).toHaveText('0/30 人');
  await expect(result.locator('[data-result-player-deaths]')).toHaveText('0 回');
  await home.click();
  await expect(page.getByRole('button', { name: '通常戦を始める' })).toBeVisible();
  expect(errors).toEqual([]);
});
