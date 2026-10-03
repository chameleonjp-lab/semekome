import { test, expect } from '@playwright/test';

for (const pendingResult of [false, true]) {
  test(`停止中は開始・中止・結果・再戦・再読込で通信せず保留${pendingResult ? '結果' : '開始'}を保持`, async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/rest/v1/**', async route => { requests.push(route.request().url()); await route.abort(); });
    const pending = JSON.stringify({ version: 1, startId: '00000000-0000-4000-8000-000000000001', name: '保留検査', gameSlug: 'semekome_standard_v1', clientVersion: 'semekome-web-20261002-01', finished: false, submitted: false, ...(pendingResult ? { submissionId: '00000000-0000-4000-8000-000000000002', result: { resultType: 'game_over', reached: 0, score: 0, ranked: true } } : {}) });
    await page.addInitScript(value => localStorage.setItem('semekome-pending-ranking-v1', value), pending);
    // Only shorten the second battle; first exercises retirement. This is a
    // flow boundary test, not evidence of winning a normal battle.
    await page.route('**/src/simulation/physical-battle.ts', async route => {
      const response = await route.fetch(); let body = await response.text();
      body = body.replace('export function createBattle(', 'function fixtureCreateBattle(');
      body += '\nlet fixtureBattles = 0; export function createBattle(options) { const state = fixtureCreateBattle(options); if (++fixtureBattles >= 2) state.matchLimitTicks = 1; return state; }';
      await route.fulfill({ response, body });
    });
    await page.clock.install({ time: new Date('2026-10-03T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-03T00:01:00Z'));
    await page.goto('/');
    await expect(page.locator('.home-notice')).toContainText('ランキングは一時停止中');
    const start = async () => {
      await page.getByRole('button', { name: '通常戦を始める' }).click();
      await expect(page.locator('#name-hint')).toContainText('名前の外部送信は行いません');
      await page.getByLabel('あなたの名前').fill('停止検査');
      await page.getByRole('button', { name: '確認を開始する' }).click();
      await page.clock.runFor(3_200);
    };
    await start();
    await page.locator('#pause-battle').click();
    await page.getByRole('button', { name: 'ホームへ戻る', exact: true }).click();
    await start();
    await expect(page.locator('.battle-result')).toBeVisible();
    await expect(page.locator('[data-result-ranking-status]')).toContainText('ランキングは一時停止中');
    await expect(page.getByRole('button', { name: '同じ結果を再送する' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '実験場の詳細ランキング' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '結果を共有する' })).toBeVisible();
    await expect(page.getByRole('button', { name: '結果をコピーする' })).toBeVisible();
    await expect(page.getByLabel('結果の共有')).toContainText('ランキング対象外');
    await expect(page.getByLabel('結果の共有')).toContainText('https://chameleonjp-lab.github.io/semekome/');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw new DOMException('Canceled', 'AbortError'); } });
    });
    const match = await page.locator('.battle-result').getAttribute('data-match-id');
    await page.getByRole('button', { name: '結果を共有する' }).click();
    await expect(page.locator('.battle-result')).toHaveAttribute('data-match-id', match!);
    expect(requests).toEqual([]);
    await page.getByRole('button', { name: '再戦の準備へ' }).click();
    // Check before reload as well: the init script must not hide a mutated queue.
    expect(await page.evaluate(() => localStorage.getItem('semekome-pending-ranking-v1'))).toBe(pending);
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem('semekome-pending-ranking-v1'))).toBe(pending);
    expect(requests).toEqual([]);
  });
}
