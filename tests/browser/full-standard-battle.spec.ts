import { test, expect } from '@playwright/test';

test('通常の初期配置から画面入力だけで7門を越え、P1のコア突進で結果まで進む @full-playthrough', async ({ page }) => {
  test.setTimeout(600000);
  // Observe the physical coordinator without changing positions, health, gates,
  // actors, or outcomes. Deterministic seed is the sole initial test condition.
  await page.route('**/src/simulation/physical-battle.ts', async route => {
    const response = await route.fetch();
    let body = await response.text();
    body = body.replace('export function createBattle(', 'function observedCreateBattle(').replace('export function stepBattle(', 'function observedStepBattle(');
    body += `\nexport function createBattle(options) { const state = observedCreateBattle(options); globalThis.__observedBattle = state; return state; }\nexport function stepBattle(state,intent) { const next = observedStepBattle(state,intent); globalThis.__observedBattle = next; return next; }`;
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => { const original = crypto.getRandomValues.bind(crypto); Object.defineProperty(crypto, 'getRandomValues', { value(array: any) { original(array); if (array instanceof Uint32Array && array.length === 1) array[0] = 20260913; return array; } }); });
  await page.clock.install({ time: new Date('2026-10-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-01T01:00:00Z'));
  await page.goto('/');
  await page.getByRole('button', { name: '通常戦を始める' }).click();
  await page.getByLabel('あなたの名前').fill('通常画面一戦');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await page.evaluate(async () => {
    const modulePath = '/tests/scenarios/standard-player-driver.ts';
    const { createStandardPlayerDriver } = await import(modulePath);
    const driver = createStandardPlayerDriver(4, true);
    const held = new Set<string>();
    let lastTick = -1;
    const keyboard = (key: string, down: boolean) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key, code: key === 'Space' ? 'Space' : key, bubbles: true, cancelable: true }));
    const setDirection = (x: number, y: number) => {
      for (const [key, active] of [['ArrowRight',x>0],['ArrowLeft',x<0],['ArrowDown',y>0],['ArrowUp',y<0]] as const) {
        if (active && !held.has(key)) { held.add(key); keyboard(key,true); }
        if (!active && held.has(key)) { held.delete(key); keyboard(key,false); }
      }
    };
    const drive = () => {
      const state = (globalThis as any).__observedBattle;
      const battle = document.querySelector<HTMLElement>('.battle');
      if (!battle || state.phase === 'ended') { for (const key of held) keyboard(key,false); return; }
      if (battle.dataset.phase === 'running' && state.tick !== lastTick) {
        lastTick = state.tick;
        const intent = driver(state);
        (globalThis as any).__lastPilotIntent = intent;
        (document.activeElement as HTMLElement)?.blur();
        const direction = intent?.dash ?? intent?.direction ?? {x:0,y:0};
        setDirection(direction.x, direction.y);
        if (intent?.route && document.querySelector('#route-toggle')?.getAttribute('data-route') !== intent.route) {
          const toggle = document.querySelector<HTMLButtonElement>('#route-toggle')!;
          if (toggle.textContent?.includes('直通') && intent.route === 'detour') toggle.click();
        }
        if (intent?.part) { const select = document.querySelector<HTMLSelectElement>('#target-part')!; if (select.value !== intent.part) { select.value = intent.part; select.dispatchEvent(new Event('change',{bubbles:true})); } }
        if (intent?.handle) document.querySelector<HTMLButtonElement>('#battle-action')!.click();
        if (intent?.attack) { keyboard('x',true); keyboard('x',false); }
        if (intent?.dash) { keyboard('Space',true); keyboard('Space',false); setDirection(0,0); }
      }
      requestAnimationFrame(drive);
    };
    requestAnimationFrame(drive);
  });
  for (let segment = 0; segment < 43 && await page.locator('.battle').count(); segment++) {
    await page.clock.runFor(10000);
    console.log(await page.evaluate(() => { const state = (globalThis as any).__observedBattle; return JSON.stringify({ tick:state.tick, outcome:state.outcome, room:state.actors.P1.currentRoomId, position:state.fixedActors.P1.position, alive:state.actors.P1.alive, gates:state.castles.enemy.openGateIds.length, lastInput:(globalThis as any).__lastPilotIntent, rejected:state.lastStep.rejected }); }));
  }
  await expect(page.locator('.battle-result')).toHaveAttribute('data-outcome','player_win');
  const result = await page.evaluate(() => {
    const state = (globalThis as any).__observedBattle;
    return { tick:state.tick, gates:state.actors.P1.location.pathGates, hit:state.castles.enemy.core.hit, actors:Object.keys(state.actors).length };
  });
  expect(result.gates).toEqual(['G1','G2','G3','G4','G5','G6','G7']);
  expect(result.hit).toBe(true); expect(result.actors).toBe(33);
  await test.info().attach('normal-ui-playthrough.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
});
