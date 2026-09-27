import { test, expect } from '@playwright/test';

test('通常戦はホームから名前・カウントダウンを経て実戦の勝敗表示まで進む', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  // The battle still starts from the production initial state. Fix only the
  // random seed so this long browser route has the same reproducible terminal
  // as the Node initial-battle scenario; no actors, gates, or positions are
  // injected.
  await page.addInitScript(() => {
    const random = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint32Array && array.length > 0) array[0] = 20_260_913;
      else if (array !== null) random(array);
      return array;
    };
  });
  await page.clock.install({ time: new Date('2026-09-27T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-27T00:01:00Z'));
  await page.goto('/');
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill('通常戦の開始検査');
  await page.getByRole('button', { name: '確認を開始する' }).click();

  const battle = page.locator('.battle');
  await expect(battle).toHaveAttribute('data-flow', 'normal');
  await expect(battle).toHaveAttribute('data-phase', 'countdown');
  await expect(battle).toHaveAttribute('data-tick', '0');

  await page.clock.runFor(3_100);
  await expect(battle).toHaveAttribute('data-phase', 'running');

  // Use a real public movement input before letting the authored AI finish
  // this initial match. The test never replaces the battle state.
  await page.keyboard.down('ArrowRight');
  await page.clock.runFor(1_000);
  await page.keyboard.up('ArrowRight');
  await page.clock.runFor(105_000);

  await expect(battle).toHaveAttribute('data-phase', 'ended');
  await expect(battle).toHaveAttribute('data-outcome', 'enemy_win');
  await expect(page.locator('.battle-overlay')).toContainText('敗北');
  await expect(page.locator('.overlay-title')).toHaveText('通常戦を終了しました');
  expect(errors).toEqual([]);
});
