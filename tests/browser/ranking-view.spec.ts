import { test, expect } from '@playwright/test';

test('上位表示は読込・空・失敗・再取得を分け、返された同率順位と名前を文字として表示する', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const modulePath = '/src/ranking/ranking-view.ts';
    const { createRankingView } = await import(modulePath);
    const host = document.createElement('section'); host.id = 'ranking-fixture'; document.body.replaceChildren(host);
    let mode = 'pending'; let resolve: (value: any[]) => void = () => {};
    const pending = new Promise<any[]>(done => resolve = done);
    createRankingView(host, async () => {
      if (mode === 'pending') return pending;
      if (mode === 'failed') throw new Error('offline');
      return [1,1,3].map(rank_no => ({ rank_no, display_name: '<img src=x onerror=alert()>', best_score: 10, play_count: 1, best_score_at: '2026-10-01T00:00:00Z' }));
    });
    (window as any).rankingFixture = { empty() { mode = 'failed'; resolve([]); }, success() { mode = 'success'; } };
  });
  await expect(page.locator('#ranking-fixture')).toHaveAttribute('data-ranking-status', 'loading');
  await page.evaluate(() => (window as any).rankingFixture.empty());
  await expect(page.locator('#ranking-fixture')).toHaveAttribute('data-ranking-status', 'empty');
  await page.getByRole('button', { name: 'ランキングを再読込' }).click();
  await expect(page.locator('#ranking-fixture')).toHaveAttribute('data-ranking-status', 'failed');
  await page.evaluate(() => (window as any).rankingFixture.success());
  await page.getByRole('button', { name: 'ランキングを再読込' }).click();
  await expect(page.locator('#ranking-fixture')).toHaveAttribute('data-ranking-status', 'success');
  await expect(page.locator('#ranking-fixture li')).toHaveText(['1位 <img src=x onerror=alert()> 10点','1位 <img src=x onerror=alert()> 10点','3位 <img src=x onerror=alert()> 10点']);
  await expect(page.locator('#ranking-fixture img')).toHaveCount(0);
});
