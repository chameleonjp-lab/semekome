import { test, expect } from '@playwright/test';

test('補給の4種類と配分を選び、物理戦と次の2個の表示へ引き継ぐ', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
  const types = page.locator('[data-supply-type]');
  const counts = page.locator('[data-supply-count]');
  await page.getByLabel('あなたの名前').fill('補給編成');

  await types.nth(0).selectOption('split_payload');
  await expect(page.locator('.supply-row').nth(0).locator('[data-supply-art]')).toHaveAttribute('src', /split_payload\.webp/);
  await types.nth(1).selectOption('split_payload');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await expect(page.locator('#supply-error')).toContainText('異なる4種類');
  await expect(page.locator('.battle')).toHaveCount(0);

  await types.nth(1).selectOption('disruption_pack');
  await types.nth(2).selectOption('breach_lance');
  await types.nth(3).selectOption('adhesive_pod');
  await counts.nth(0).selectOption('2');
  await counts.nth(1).selectOption('3');
  await counts.nth(2).selectOption('1');
  await counts.nth(3).selectOption('2');
  await expect(page.locator('#supply-summary')).toHaveText('選択 4/4種類・合計 8/8個');
  await page.getByRole('button', { name: '確認を開始する' }).click();

  const battle = page.locator('.battle');
  await expect(battle).toHaveAttribute('data-player-supply-allocation', 'split_payload,split_payload,disruption_pack,disruption_pack,disruption_pack,breach_lance,adhesive_pod,adhesive_pod');
  const preview = (await battle.getAttribute('data-player-supply-preview'))?.split(',') ?? [];
  expect(preview).toHaveLength(2);
  expect(preview.every(type => ['split_payload', 'disruption_pack', 'breach_lance', 'adhesive_pod'].includes(type))).toBe(true);
  await expect(page.getByLabel('次に届く補給')).toContainText('次の補給：');
  await expect(page.locator('.supply-preview-item img')).toHaveCount(2);
  for (const icon of await page.locator('.supply-preview-item img').all()) await expect(icon).toHaveAttribute('src', /(?:split_payload|disruption_pack|breach_lance|adhesive_pod)\.webp/);
});

test('生成画像が読み込めなくてもCanvasの代替描画と移動操作を保つ', async ({ page }) => {
  await page.route('**/assets/generated/*.webp', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing test image' }));
  await page.clock.install({ time: new Date('2026-09-13T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-13T00:01:00Z'));
  await page.goto('/');
  await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
  await page.getByLabel('あなたの名前').fill('画像なし検査');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  const battle = page.locator('.battle');
  await page.clock.runFor(3100);
  await expect(battle).toHaveAttribute('data-phase', 'running');
  const beforeX = Number(await battle.getAttribute('data-player-x'));
  await page.keyboard.down('ArrowRight');
  await page.clock.runFor(1000);
  await page.keyboard.up('ArrowRight');
  const afterX = Number(await battle.getAttribute('data-player-x'));
  expect(afterX).toBeGreaterThan(beforeX);
  expect(await page.locator('.battle-map canvas').evaluate(node => {
    const canvas = node as HTMLCanvasElement;
    return canvas.width > 0 && canvas.height > 0 && canvas.getContext('2d') !== null;
  })).toBe(true);
});

test('敵役割表示と標的設定を正しく読み、設定変更だけでは戦場を進めない', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-13T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-13T00:01:00Z'));
  await page.goto('/');
  await page.getByRole('button', { name: '配置を確認する' }).click();
  await page.locator('[data-area="enemy"]').click();
  await page.getByLabel('見たい場所').selectOption('battery_a');
  await expect(page.locator('.room-detail')).toContainText('射手護衛1人');

  await page.getByRole('button', { name: 'ホーム' }).click();
  await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
  await page.getByLabel('あなたの名前').fill('状態表示');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  const battle = page.locator('.battle');
  await page.clock.runFor(3100);
  await expect(battle).toHaveAttribute('data-phase', 'running');
  const before = {
    tick: await battle.getAttribute('data-tick'),
    x: await battle.getAttribute('data-player-x'),
    y: await battle.getAttribute('data-player-y'),
  };
  await expect(page.locator('#target-part option').first()).toContainText('敵陣 外装1');
  await page.locator('#route-toggle').click();
  await page.getByLabel('狙う部位').selectOption('P7');
  await expect(page.locator('#route-toggle')).toHaveText('経路：迂回');
  await expect(page.locator('#target-part')).toHaveValue('P7');
  await expect(battle).toHaveAttribute('data-tick', before.tick!);
  await expect(battle).toHaveAttribute('data-player-x', before.x!);
  await expect(battle).toHaveAttribute('data-player-y', before.y!);
});

test('観戦・一時停止で入力を無効にすると、復帰後に古い移動が再開しない', async ({ page }) => {
  await page.goto('/');
  const vectors = await page.evaluate(async () => {
    const { bindMovement } = await new Function('return import("/src/input/battle-input.ts")')();
    const pad = document.createElement('div');
    document.body.append(pad);
    const movement = bindMovement(pad);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    const beforeDisabled = movement.direction();
    movement.setEnabled(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    const whileDisabled = movement.direction();
    movement.setEnabled(true);
    const afterResume = movement.direction();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    const freshInput = movement.direction();
    movement.setEnabled(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    const disabledAgain = movement.direction();
    movement.setEnabled(true);
    const afterSecondResume = movement.direction();
    movement.dispose();
    pad.remove();
    return [beforeDisabled, whileDisabled, afterResume, freshInput, disabledAgain, afterSecondResume];
  });
  expect(vectors).toEqual([
    { x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
    { x: -1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
  ]);
});

test('DOMとSVGの画像欠損は代替表示になり、弾アイコンも空荷物で消える', async ({ page }) => {
  await page.route('**/assets/generated/*.webp', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing test image' }));
  await page.clock.install({ time: new Date('2026-09-13T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-13T00:01:00Z'));
  await page.goto('/');
  await expect(page.locator('.home-stage .art-image-fallback')).toBeVisible();
  await page.getByRole('button', { name: '素材図鑑' }).click();
  await expect(page.locator('.atlas-card').first().locator('.art-image-fallback')).toBeVisible();
  await expect(page.locator('.atlas-card').first()).toContainText('主人公');

  await page.getByRole('button', { name: 'ホーム' }).click();
  await page.getByRole('button', { name: '配置を確認する' }).click();
  await page.locator('[data-area="enemy"]').click();
  await expect(page.locator('.map-viewport [data-art-fallback]').first()).toBeVisible();
  await page.getByRole('button', { name: 'ホーム' }).click();
  await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
  await page.getByLabel('あなたの名前').fill('代替画像');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  const battle = page.locator('.battle');
  await page.clock.runFor(3100);
  await expect(battle).toHaveAttribute('data-phase', 'running');
  await expect(page.locator('.supply-preview-item .art-image-fallback')).toHaveCount(2);

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
  await walkTo('x', 94500);
  await walkTo('y', 13500);
  await walk('ArrowLeft', 200);
  await expect(page.locator('#battle-action')).toContainText('拾う');
  await page.locator('#battle-action').click();
  await page.clock.runFor(34);
  await expect(page.locator('[data-slot="0"] .cargo-label')).not.toHaveText('左：空');
  await expect(page.locator('[data-slot="0"] .cargo-icon + .art-image-fallback')).toBeVisible();
  await page.locator('#battle-drop').click();
  await page.clock.runFor(34);
  await expect(page.locator('[data-slot="0"] .cargo-label')).toHaveText('左：空');
  await expect(page.locator('[data-slot="0"] .cargo-icon + .art-image-fallback')).toBeHidden();
});

test('名前の境界検証とカウントダウン中止、二重開始を防ぐ', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-13T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-13T00:01:00Z'));
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
  test.setTimeout(60000);
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
  await page.clock.fastForward(30000);
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
  await page.clock.fastForward(10000);
  await expect(battle).toHaveAttribute('data-tick', hiddenTick!);
  await expect(page.getByRole('button', { name: '再開する' })).toBeVisible();
  await page.getByRole('button', { name: '再開する' }).click();
  await page.clock.runFor(500);
  expect(Number(await battle.getAttribute('data-tick'))).toBeGreaterThan(Number(hiddenTick));
  await expect(battle).toHaveAttribute('data-player-x', String(afterX));
  expect(errors).toEqual([]);
});

test('縦横の小画面でも48px操作・地図・停止導線が収まる', async ({ page }) => {
  test.setTimeout(60000); // Five controlled countdowns plus browser layout work.
  await page.clock.install({ time: new Date('2026-09-13T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-13T00:01:00Z'));
  for (const viewport of [{ width: 360, height: 640 }, { width: 390, height: 664 }, { width: 402, height: 700 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
    await page.getByLabel('あなたの名前').fill('小画面');
    await page.getByRole('button', { name: '確認を開始する' }).click();
    await page.clock.runFor(3100);
    await expect(page.locator('.battle-overlay')).toBeHidden();
    const hintBox = (await page.locator('.battle-hint').boundingBox())!;
    const cargoBox = (await page.locator('.cargo-controls').boundingBox())!;
    expect(hintBox.y + hintBox.height, `battle hint overlaps cargo controls at ${viewport.width}px`).toBeLessThanOrEqual(cargoBox.y + 1);
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
