import { test, expect } from '@playwright/test';

test('名前の境界検証とカウントダウン中止、二重開始を防ぐ', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
  const name = page.getByLabel('あなたの名前');
  for (const invalid of ['   ', 'あ'.repeat(21), '😀'.repeat(21)]) {
    await name.fill(invalid);
    await page.getByRole('button', { name: '確認を開始する' }).click();
    await expect(page.getByRole('alert')).toContainText('1〜20文字');
    await expect(page.locator('.battle')).toHaveCount(0);
  }
  await name.fill('　 太郎  ');
  await page.getByRole('button', { name: '確認を開始する' }).dblclick();
  await expect(page.locator('.battle')).toHaveCount(1);
  await expect(page.locator('.player-label')).toHaveText('太郎');
  await expect(page.locator('.battle')).toHaveAttribute('data-tick', '0');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '準備を中止する' })).toBeFocused();
  expect(await page.locator('.battle-settings').evaluate(node => (node as HTMLElement).inert)).toBe(true);
  await page.clock.runFor(1500);
  await expect(page.locator('.battle')).toHaveAttribute('data-tick', '0');
  const previousMatch = await page.locator('.battle').getAttribute('data-match-id');
  await page.getByRole('button', { name: '準備を中止する' }).click();
  await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
  await page.getByLabel('あなたの名前').fill('😀'.repeat(20));
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await expect(page.locator('.battle')).not.toHaveAttribute('data-match-id', previousMatch!);
  await expect(page.locator('.battle')).toHaveAttribute('data-tick', '0');
});

test('連続移動、停止と明示再開、入力残留と時間の追いつきを防ぐ', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-09-13T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-13T00:01:00Z'));
  await page.goto('/');
  await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
  await page.getByLabel('あなたの名前').fill('操作検査');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await page.clock.runFor(3100);
  const battle = page.locator('.battle');
  await expect(battle).toHaveAttribute('data-phase', 'running');
  const match = await battle.getAttribute('data-match-id');
  const beforeX = Number(await battle.getAttribute('data-player-x'));
  const pad = page.getByRole('group', { name: /移動パッド/ });
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.runFor(1000);
  const afterX = Number(await battle.getAttribute('data-player-x'));
  expect(afterX - beforeX).toBeGreaterThan(2500);
  expect(afterX - beforeX).toBeLessThan(3500);
  await page.mouse.up();
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await page.clock.runFor(100);
  const tick = await battle.getAttribute('data-tick');
  await page.clock.runFor(30000);
  await expect(battle).toHaveAttribute('data-tick', tick!);
  await page.getByRole('button', { name: '再開する' }).click();
  await page.clock.runFor(500);
  await expect(battle).toHaveAttribute('data-player-x', String(afterX));
  await expect(battle).toHaveAttribute('data-match-id', match!);
  const resumedTick = Number(await battle.getAttribute('data-tick'));
  expect(resumedTick - Number(tick)).toBeLessThanOrEqual(31);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(100);
  const hiddenTick = await battle.getAttribute('data-tick');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(10000);
  await expect(battle).toHaveAttribute('data-tick', hiddenTick!);
  await expect(page.getByRole('button', { name: '再開する' })).toBeVisible();
  await page.getByRole('button', { name: '再開する' }).click();
  await page.clock.runFor(500);
  expect(Number(await battle.getAttribute('data-tick'))).toBeGreaterThan(Number(hiddenTick));
  await expect(battle).toHaveAttribute('data-player-x', String(afterX));
  expect(errors).toEqual([]);
});

test('縦横の小画面でも48px操作・地図・停止導線が収まる', async ({ page }) => {
  test.setTimeout(60000); // Five real three-second countdowns plus browser layout work.
  for (const viewport of [{ width: 360, height: 640 }, { width: 390, height: 664 }, { width: 402, height: 700 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
    await page.getByLabel('あなたの名前').fill('小画面');
    await page.getByRole('button', { name: '確認を開始する' }).click();
    await expect(page.locator('.battle-overlay')).toBeHidden({ timeout: 10000 });
    for (const selector of ['#pause-battle', '[data-slot="0"]', '[data-slot="1"]', '#battle-action', '#battle-drop', '#route-toggle', '#target-part', '#battle-help', '.movement-pad']) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.width, selector).toBeGreaterThanOrEqual(48);
      expect(box.height, selector).toBeGreaterThanOrEqual(48);
      expect(box.x, selector).toBeGreaterThanOrEqual(0);
      expect(box.y, selector).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, selector).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height, selector).toBeLessThanOrEqual(viewport.height + 1);
    }
    expect((await page.locator('canvas').boundingBox())!.height).toBeGreaterThan(110);
    const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    expect(size.width).toBeLessThanOrEqual(viewport.width);
    expect(size.height).toBeLessThanOrEqual(viewport.height);
    await page.getByRole('button', { name: '操作説明' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(page.getByRole('button', { name: '再開する' })).toBeVisible();
  }
});

test('通常の移動と作業ボタンだけで弾薬庫から砲台へ運び、主人公が発射する', async ({ page }) => {
  test.setTimeout(60000);
  await page.clock.install({ time: new Date('2026-09-13T00:00:00Z') });
  await page.goto('/');
  await page.clock.pauseAt(new Date('2026-09-13T01:00:00Z'));
  await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
  await page.getByLabel('あなたの名前').fill('<svg/onload=alert()>');
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
  await expect(page.locator('[data-slot="0"]')).toHaveText('左：空');
  expect(Number(await battle.getAttribute('data-player-operated-launches'))).toBeGreaterThan(0);
  await expect(battle).toHaveAttribute('data-match-id', match!);
});
