import { test, expect } from '@playwright/test';

test('設定と名前を戻し、練習は通常戦の保存記録へ混ぜない', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill('前回の編成');
  await page.locator('#match-preset').selectOption('repair');
  await page.locator('#match-difficulty').selectOption('easy');
  await page.locator('[data-support-type]').first().selectOption('mechanic');
  await page.locator('#practice').selectOption('transport');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await expect(page.locator('.battle')).toHaveAttribute('data-flow', 'practice');
  await expect(page.locator('.battle')).toHaveAttribute('data-preset', 'repair');
  await expect(page.locator('.battle')).toHaveAttribute('data-difficulty', 'easy');
  const persisted = await page.evaluate(() => Object.keys(sessionStorage));
  expect(persisted.filter(key => key.includes('battle-session'))).toEqual([]);
  await page.waitForTimeout(400);
  await page.locator('#leave-battle').click();
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await expect(page.getByLabel('あなたの名前')).toHaveValue('前回の編成');
  await expect(page.locator('#match-preset')).toHaveValue('repair');
  await expect(page.locator('#match-difficulty')).toHaveValue('easy');
  await expect(page.locator('[data-support-type]').first()).toHaveValue('mechanic');
});

test('運搬と砲撃の練習を通常操作で達成し、やり直しと終了を表示する', async ({ page }) => {
  test.setTimeout(60000);
  await page.clock.install({ time: new Date('2026-09-13T00:00:00Z') });
  await page.goto('/');
  await page.clock.pauseAt(new Date('2026-09-13T01:00:00Z'));
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill('<svg/onload=alert()>');
  await page.locator('#practice').selectOption('transport');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await page.clock.runFor(3100);
  await expect(page.locator('.battle svg')).toHaveCount(0);
  await expect(page.locator('.player-label')).toHaveText('<svg/onload=alert()>');
  const battle = page.locator('.battle');
  const match = await battle.getAttribute('data-match-id');
  const walk = async (key: string, milliseconds: number) => {
    await page.keyboard.down(key); await page.clock.runFor(milliseconds); await page.keyboard.up(key);
  };
  const walkTo = async (axis: 'x' | 'y', target: number) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const position = Number(await battle.getAttribute(`data-player-${axis}`));
      const distance = target - position;
      if (Math.abs(distance) < 25) return;
      const key = axis === 'x' ? distance > 0 ? 'ArrowRight' : 'ArrowLeft' : distance > 0 ? 'ArrowDown' : 'ArrowUp';
      const ticks = Math.max(1, Math.min(120, Math.floor(Math.abs(distance) / 50) - 1));
      await walk(key, ticks === 1 ? 16 : ticks * 1000 / 60);
    }
    expect(Number(await battle.getAttribute(`data-player-${axis}`)), `normal movement reaches ${axis}=${target}`).toBe(target);
  };
  // Follow the authored A-room passages, never teleport or inject world events.
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
  await page.clock.runFor(1000);
  await expect(page.getByRole('heading', { name: '練習達成' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'やり直す' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ホームへ戻る' })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('semekome-preferences')!).practiceCompleted)).toContain('transport');
});

test('迎撃練習でP1が実際に発射した弾と敵弾の接触を達成する', async ({ page }) => {
  test.setTimeout(60000);
  await page.clock.install({ time: new Date('2026-09-13T00:00:00Z') });
  await page.goto('/');
  await page.clock.pauseAt(new Date('2026-09-13T01:00:00Z'));
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill('<svg/onload=alert()>');
  await page.locator('#practice').selectOption('interception');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await page.clock.runFor(3100);
  await expect(page.locator('.battle svg')).toHaveCount(0);
  await expect(page.locator('.player-label')).toHaveText('<svg/onload=alert()>');
  const battle = page.locator('.battle');
  const match = await battle.getAttribute('data-match-id');
  const walk = async (key: string, milliseconds: number) => {
    await page.keyboard.down(key); await page.clock.runFor(milliseconds); await page.keyboard.up(key);
  };
  const walkTo = async (axis: 'x' | 'y', target: number) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const position = Number(await battle.getAttribute(`data-player-${axis}`));
      const distance = target - position;
      if (Math.abs(distance) < 25) return;
      const key = axis === 'x' ? distance > 0 ? 'ArrowRight' : 'ArrowLeft' : distance > 0 ? 'ArrowDown' : 'ArrowUp';
      const ticks = Math.max(1, Math.min(120, Math.floor(Math.abs(distance) / 50) - 1));
      await walk(key, ticks === 1 ? 16 : ticks * 1000 / 60);
    }
    expect(Number(await battle.getAttribute(`data-player-${axis}`)), `normal movement reaches ${axis}=${target}`).toBe(target);
  };
  // Follow the authored A-room passages, never teleport or inject world events.
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
  await page.clock.runFor(10000);
  await expect(page.getByRole('heading', { name: '練習達成' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'やり直す' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ホームへ戻る' })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('semekome-preferences')!).practiceCompleted)).toContain('interception');
});
