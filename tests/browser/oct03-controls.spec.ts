import { test, expect } from '@playwright/test';

test('automatic enemy tactics, five slots, directional shots, two-person follow and rapid taps', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-10-03T00:00:00Z') });
  await page.goto('/');
  await page.clock.pauseAt(new Date('2026-10-03T00:01:00Z'));
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await expect(page.locator('#match-preset')).toHaveCount(0);
  await expect(page.locator('.battle-setup')).toContainText('敵は戦況を見て自動で作戦を決めます');
  await page.getByLabel('あなたの名前').fill('操作検査');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await page.clock.runFor(3100);
  const battle = page.locator('.battle');
  await expect(battle).toHaveAttribute('data-phase', 'running');
  await expect(page.locator('[data-slot]')).toHaveCount(5);
  await page.keyboard.down('ArrowRight');
  await page.clock.runFor(100);
  await page.keyboard.up('ArrowRight');
  await expect(battle).toHaveAttribute('data-player-facing', '{"x":1,"y":0}');
  await page.locator('#battle-attack').tap();
  await page.clock.runFor(20);
  await expect(battle).toHaveAttribute('data-player-shots', '1');
  await expect(page.locator('#battle-attack')).toHaveAttribute('aria-label', /進行方向へ射撃/);
  const initialScale = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  for (let i = 0; i < 5; i++) {
    await page.locator('#battle-attack').tap();
    await page.clock.runFor(50);
  }
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(initialScale);
  const prevented = await page.locator('#battle-attack').evaluate(button => {
    const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await page.getByLabel('味方命令', { exact: true }).click();
  await page.getByRole('button', { name: '2人を引率する' }).click();
  await page.clock.runFor(50);
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'follow');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'follow');
  await page.getByRole('button', { name: '2人に弾回収を任せる' }).click();
  await page.clock.runFor(50);
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'collect');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'collect');
  await page.getByRole('button', { name: '2人に砲撃を任せる' }).click();
  await page.clock.runFor(50);
  await expect(battle).toHaveAttribute('data-ally-p2-order', 'artillery');
  await expect(battle).toHaveAttribute('data-ally-p3-order', 'artillery');
  await page.getByLabel('味方命令', { exact: true }).click();
  await testInfo.attach('oct03-gameplay-controls', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('visual fixture captures all six role sprites in four labeled facings', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const art = await new Function('return import("/src/presentation/game-art.ts")')();
    art.requestGameArtLoad();
  });
  await expect.poll(async () => page.evaluate(async () => {
    const art = await new Function('return import("/src/presentation/game-art.ts")')();
    return ['hero', 'helper', 'gunner', 'guard', 'carrier', 'soldier'].filter(role => art.getGameArt(role)).length;
  })).toBe(6);
  await page.evaluate(async () => {
    const art = await new Function('return import("/src/presentation/game-art.ts")')();
    // Renderer review fixture only: no battle state or victory is simulated.
    const canvas = document.createElement('canvas');
    canvas.id = 'directional-art-review'; canvas.width = 760; canvas.height = 1040;
    canvas.style.cssText = 'display:block;width:min(100%,380px);height:auto;margin:0 auto';
    canvas.setAttribute('aria-label', 'Visual fixture: six roles, four facings');
    document.body.replaceChildren(canvas);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#101c27'; context.fillRect(0, 0, 760, 1040);
    context.fillStyle = '#eff4ee'; context.font = '22px sans-serif'; context.textAlign = 'center';
    context.fillText('FOUR FACING VIEWS · RENDERER FIXTURE', 380, 35);
    const facings = ['up', 'down', 'left', 'right'];
    facings.forEach((facing, column) => context.fillText(facing.toUpperCase(), 190 + column * 158, 82));
    ['hero', 'helper', 'gunner', 'guard', 'carrier', 'soldier'].forEach((role, row) => {
      const y = 165 + row * 150;
      context.fillStyle = '#c9dad8'; context.textAlign = 'left'; context.font = '20px sans-serif';
      context.fillText(role, 12, y + 8);
      facings.forEach((facing, column) => {
        const x = 190 + column * 158;
        context.fillStyle = row % 2 ? '#263b45' : '#1d303b'; context.fillRect(x - 70, y - 64, 140, 130);
        art.drawDirectionalActorArt(context, role, facing, x, y, 110);
      });
    });
  });
  await expect(page.locator('#directional-art-review')).toBeVisible();
  await testInfo.attach('six-roles-four-facing-renderer-fixture', { body: await page.locator('#directional-art-review').screenshot(), contentType: 'image/png' });
});
