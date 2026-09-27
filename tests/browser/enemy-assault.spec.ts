import { test, expect } from '@playwright/test';

test('敵AIの核への実突進で敗北し、停止中と終局後は世界も入力も進まない', async ({ page }) => {
  // Boundary fixture only: inject open gates and a traversed route near the
  // player core, but never an ended state, a dash or a core-hit bridge. The
  // separate initial-battle Node scenario proves the actual continuous route.
  await page.route('**/src/simulation/physical-battle.ts', async route => {
    const response = await route.fetch();
    let body = await response.text();
    expect(body).toContain('export function createBattle(');
    expect(body).toContain('export function stepBattle(');
    body = body.replace('export function createBattle(', 'function fixtureCreateBattle(')
      .replace('export function stepBattle(', 'function fixtureStepBattle(');
    body += `
      export function createBattle(options) {
        const state = fixtureCreateBattle(options);
        const castle = state.castles.player, layout = state.layout.home;
        for (const part of Object.values(castle.exterior)) { part.health = 0; part.destroyed = true; }
        castle.destroyedPartIds = Object.keys(castle.exterior);
        for (const gate of Object.values(castle.gates)) gate.open = true;
        castle.openGateIds = [...layout.coreRouteGates];
        const room = layout.rooms.find(room => room.id === 'core');
        const point = { x: (room.rect.x0 + room.rect.x1) * 500 + 3500, y: (room.rect.y0 + room.rect.y1) * 500 };
        const actor = state.actors.E29;
        actor.currentRoomId = 'core';
        actor.location = { area: 'castle', castleTeam: 'player', roomId: 'core', pathRooms: [...layout.coreRouteRooms], pathGates: [...layout.coreRouteGates] };
        actor.position = { x: Math.floor(point.x / 1000), y: Math.floor(point.y / 1000) };
        actor.protectedUntilTick = 90;
        state.fixedActors.E29 = { position: point, remainder: { x: 0, y: 0 } };
        globalThis.__enemyAssaultTrace = { outcomes: 0, coreHits: 0, stepsAfterEnd: 0, movement: 0 };
        return state;
      }
      export function stepBattle(state, intent) {
        const trace = globalThis.__enemyAssaultTrace;
        if (state.phase === 'ended') trace.stepsAfterEnd++;
        const next = fixtureStepBattle(state, intent);
        trace.outcomes += next.lastStep.events.filter(e => e.type === 'outcome').length;
        trace.coreHits += next.lastStep.events.filter(e => e.type === 'core_hit_candidate' && e.attackerId === 'E29' && e.targetTeam === 'player').length;
        trace.movement += Math.abs(next.fixedActors.E29.position.x - state.fixedActors.E29.position.x);
        return next;
      }
    `;
    await route.fulfill({ response, body });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-09-27T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-27T00:01:00Z'));
  await page.goto('/');
  await page.getByRole('button', { name: '運搬・砲撃を試す' }).click();
  await page.getByLabel('あなたの名前').fill('敵の核攻略検査');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await page.clock.runFor(3100);
  const battle = page.locator('.battle');
  await expect(battle).toHaveAttribute('data-phase', 'running');
  await page.locator('#pause-battle').click();
  const pausedTick = await battle.getAttribute('data-tick');
  await page.clock.runFor(3000);
  await expect(battle).toHaveAttribute('data-tick', pausedTick!);
  await page.getByRole('button', { name: '再開する' }).click();
  await page.clock.runFor(3000);
  await expect(battle).toHaveAttribute('data-phase', 'ended');
  await expect(page.locator('.battle-overlay')).toContainText('敗北');
  await expect(page.locator('#battle-dash')).toBeDisabled();
  const endedTick = await battle.getAttribute('data-tick');
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.clock.runFor(1000);
  await expect(battle).toHaveAttribute('data-tick', endedTick!);
  const trace = await page.evaluate(() => (globalThis as unknown as {
    __enemyAssaultTrace: { outcomes: number; coreHits: number; stepsAfterEnd: number; movement: number };
  }).__enemyAssaultTrace);
  expect(trace).toMatchObject({ outcomes: 1, coreHits: 1, stepsAfterEnd: 0 });
  expect(trace.movement).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
