import { test, expect } from '@playwright/test';
import blueprint from '../../docs/plans/current/INTERIOR_LAYOUTS.json' with { type: 'json' };

test('ホームからルールを閉じ、配置を確認してホームへ戻れる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'セメコメ', exact: true })).toBeVisible();
  await expect(page.getByText('対戦はまだ遊べません。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'ルール説明' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const dialogBox = (await page.getByRole('dialog').boundingBox())!;
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'ルール説明' })).toBeFocused();
  await page.getByRole('button', { name: '配置を確認する' }).click();
  await expect(page.getByRole('navigation', { name: '表示する場所' })).toBeVisible();
  await page.getByRole('button', { name: 'ホーム', exact: true }).click();
  await expect(page.getByRole('button', { name: '配置を確認する' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('敵陣は左右反転し、同じ名簿30人と7門を表示する', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '配置を確認する' }).click();
  await expect(page.locator('[data-actor-id]')).toHaveCount(3);
  const homePositions = await page.locator('[data-actor-id]').evaluateAll(nodes => nodes.map(node => `${node.getAttribute('x')},${node.getAttribute('y')}`));
  expect(new Set(homePositions).size).toBe(3);
  const homeRect = await page.locator('[data-room="battery_a"]').getAttribute('x');
  expect(Number(homeRect)).toBe(blueprint.rooms.find(room => room.id === 'battery_a')!.rect_cells[0]);
  await page.getByRole('button', { name: '敵陣', exact: true }).click();
  expect(Number(await page.locator('[data-room="battery_a"]').getAttribute('x'))).toBe(126 - blueprint.rooms.find(room => room.id === 'battery_a')!.rect_cells[2]);
  const ids = await page.locator('[data-actor-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-actor-id')));
  expect(new Set(ids).size).toBe(30);
  expect(ids.sort()).toEqual(Array.from({ length: 30 }, (_, i) => `E${String(i + 1).padStart(2, '0')}`));
  await expect(page.locator('[data-gate]')).toHaveCount(7);
  await expect(page.locator('[data-turret]')).toHaveCount(4);
  await expect(page.locator('[data-supply-port]')).toHaveCount(4);
  await expect(page.locator('[data-recovery-pad]')).toHaveCount(30);
  const roleShapes = await page.locator('[data-actor-id]').evaluateAll(nodes => {
    const result: Record<string, string> = {};
    for (const node of nodes) result[node.getAttribute('data-role')!] = `${node.tagName}:${node.getAttribute('points')?.trim().split(/\s+/).length ?? 0}`;
    return result;
  });
  expect(new Set(Object.values(roleShapes)).size).toBe(4);
  await page.getByLabel('見たい場所', { exact: true }).selectOption('battery_a');
  await expect(page.locator('.room-detail')).toContainText('射手1人');
  await expect(page.locator('.room-detail')).toContainText('護衛1人');
  await page.getByRole('button', { name: '広場', exact: true }).click();
  await expect(page.getByText('自陣 → 広場 ← 敵陣', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '敵陣', exact: true }).click();
  await expect(page.locator('[data-actor-id]')).toHaveCount(30);
  await expect(page.locator('.gate-status').first()).toHaveText('外装 0/7 破壊 · 門 0/7 開放');
});

test('拡大とドラッグが動き、中断後も新しい操作を受け付ける', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '配置を確認する' }).click();
  const map = page.locator('.map-viewport');
  const original = await map.getAttribute('viewBox');
  await page.getByRole('button', { name: '拡大', exact: true }).click();
  await expect(map).not.toHaveAttribute('viewBox', original!);
  await map.focus();
  const beforeKey = await map.getAttribute('viewBox');
  await page.keyboard.press('ArrowLeft');
  await expect(map).not.toHaveAttribute('viewBox', beforeKey!);
  const box = (await map.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 10);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  const interrupted = await map.getAttribute('viewBox');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 25, box.y + box.height / 2);
  await page.mouse.up();
  await expect(map).not.toHaveAttribute('viewBox', interrupted!);
});

test('短い縦画面と横画面で主要操作が収まり、ページがスクロールしない', async ({ page }) => {
  for (const viewport of [{ width: 360, height: 640 }, { width: 390, height: 664 }, { width: 402, height: 700 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: 'ルール説明' }).click();
    for (const control of [page.getByRole('dialog'), page.getByRole('button', { name: '閉じる', exact: true })]) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'ルール説明' })).toBeFocused();
    await page.getByRole('button', { name: '配置を確認する' }).click();
    for (const button of await page.getByRole('button').all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(48);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, x: scrollX, y: scrollY }));
    expect(size.width).toBeLessThanOrEqual(viewport.width);
    expect(size.height).toBeLessThanOrEqual(viewport.height);
    expect(size.x).toBe(0);
    expect(size.y).toBe(0);
    expect((await page.locator('.map-viewport').boundingBox())!.height).toBeGreaterThan(100);
    for (const selector of ['#room-select', '.map-caption', '.room-info']) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    const info = await page.locator('.room-info').evaluate(node => ({
      scroll: node.scrollHeight > node.clientHeight,
      overflow: getComputedStyle(node).overflowY,
    }));
    if (info.scroll) expect(info.overflow).toBe('auto');
  }
});
