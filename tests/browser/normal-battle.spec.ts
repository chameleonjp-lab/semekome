import { test, expect } from '@playwright/test';

test('通常戦はホームから名前・カウントダウンを経て実戦の勝敗表示まで進む', async ({ page }) => {
  test.setTimeout(180_000);
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

  const walk = async (key: string, milliseconds: number) => {
    await page.keyboard.down(key);
    await page.clock.runFor(milliseconds);
    await page.keyboard.up(key);
  };
  const walkTo = async (axis: 'x' | 'y', target: number) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const position = Number(await battle.getAttribute(`data-player-${axis}`));
      const distance = target - position;
      if (Math.abs(distance) < 25) return;
      const key = axis === 'x' ? distance > 0 ? 'ArrowRight' : 'ArrowLeft' : distance > 0 ? 'ArrowDown' : 'ArrowUp';
      const ticks = Math.max(1, Math.min(120, Math.floor(Math.abs(distance) / 50) - 1));
      await walk(key, ticks === 1 ? 16 : ticks * 1000 / 60);
    }
    expect(Number(await battle.getAttribute(`data-player-${axis}`))).toBe(target);
  };

  // Use the public movement and action controls for one real supply delivery.
  // The test never replaces actors, gates, positions, or battle state.
  await walkTo('x', 94500);
  await walkTo('y', 13500);
  await walk('ArrowLeft', 200);
  await expect(page.locator('#battle-action')).toContainText('拾う');
  await page.locator('#battle-action').click();
  await page.clock.runFor(34);
  await expect(page.locator('[data-slot="0"]')).not.toHaveText('左：空');
  await walkTo('y', 11500);
  await walkTo('x', 106500);
  await walkTo('y', 12800);
  await expect(page.locator('#battle-action')).toContainText(/砲台/);
  await page.locator('#battle-action').click();
  await page.clock.runFor(1_000);
  await expect(battle).toHaveAttribute('data-player-operated-launches', /[1-9]/);

  // The authored enemy assault now reaches the player's core in this
  // production initial battle. No fixture state or terminal result is added.
  await page.clock.runFor(105_000);

  await expect(battle).toHaveAttribute('data-phase', 'ended');
  await expect(battle).toHaveAttribute('data-outcome', 'enemy_win');
  await expect(page.locator('.battle-overlay')).toContainText('敗北');
  await expect(page.locator('.overlay-title')).toHaveText('通常戦を終了しました');
  expect(errors).toEqual([]);
});
