import { test, expect } from '@playwright/test';

test('承認済み接続のstubではカウントダウン後に開始し、確定結果を自動送信して同じ番号で再送する', async ({ page }) => {
  const calls: { name: string; args: any }[] = []; let loseResponse = true;
  const playId = '00000000-0000-4000-8000-000000000001';
  await page.route('**/src/ranking/runtime-ranking.ts', async route => {
    await route.fulfill({ contentType:'application/javascript', body:`import { createRankingClient } from '/src/ranking/ranking-client.ts'; export function loadRankingRuntime() { return { client:createRankingClient({endpoint:'https://ranking-fixture.test/rest/v1',publishableKey:'sb_publishable_fixture',gameSlug:'fixture',clientVersion:'fixture-1',scoreMin:0,scoreMax:111800},localStorage),canonicalUrl:'https://ranking-fixture.test/game/',labUrl:'https://ranking-fixture.test/ranking.html?game=fixture'}; }` });
  });
  await page.route('https://ranking-fixture.test/rest/v1/rpc/**', async route => {
    if (route.request().method() === 'OPTIONS') { await route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'}}); return; }
    const name = route.request().url().split('/').at(-1)!, args = route.request().postDataJSON(); calls.push({name,args});
    const common = { headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'} };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({...common,status:204}); return; }
    if (name === 'start_game_play_v1') { await route.fulfill({...common,json:{accepted:true,start_id:args.p_start_id,play_id:playId,game_slug:args.p_game_slug,display_name:args.p_display_name,client_version:args.p_client_version}}); return; }
    if (name === 'finish_game_play_v1') { await route.fulfill({...common,json:{accepted:true,play_id:playId,game_slug:args.p_game_slug,result_type:args.p_result_type,reached_wave:args.p_reached_wave,score:args.p_score}}); return; }
    if (name === 'get_game_ranking') { await route.fulfill({...common,json:[]}); return; }
    if (loseResponse) { loseResponse = false; await route.abort('failed'); return; }
    await route.fulfill({...common,json:[{accepted:true,result_play_id:playId,result_submission_id:args.p_submission_id,result_display_name:args.p_display_name,result_first_score:args.p_score,result_best_score:args.p_score,result_play_count:1,was_duplicate:true}]});
  });
  // Timeout boundary only: this test checks external flow, not a complete battle.
  await page.route('**/src/simulation/physical-battle.ts', async route => {
    const response = await route.fetch(); let body = await response.text();
    body = body.replace('export function createBattle(', 'function timedCreateBattle(');
    body += '\nexport function createBattle(options) { const state = timedCreateBattle(options); state.tick = state.matchLimitTicks - 1; return state; }';
    await route.fulfill({response,body});
  });
  await page.clock.install({time:new Date('2026-10-01T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-10-01T00:01:00Z'));
  await page.goto('/');
  await page.getByRole('button',{name:'通常戦を始める'}).click();
  await page.getByLabel('あなたの名前').fill('接続検査');
  await page.getByRole('button',{name:'確認を開始する'}).click();
  await page.clock.runFor(2000); expect(calls.filter(call => call.name === 'start_game_play_v1')).toHaveLength(0);
  await page.clock.runFor(1100);
  await expect.poll(() => calls.filter(call => call.name === 'start_game_play_v1').length).toBe(1);
  for (let attempt = 0; attempt < 10 && !await page.locator('.battle-result').count(); attempt++) { await page.clock.runFor(100); await page.waitForTimeout(10); }
  await expect(page.locator('.battle-result')).toBeVisible();
  await expect(page.getByRole('button',{name:'同じ結果を再送する'})).toBeVisible();
  const first = calls.find(call => call.name === 'submit_score_idempotent_v1')!.args;
  await page.getByRole('button',{name:'同じ結果を再送する'}).click();
  await expect(page.getByText('ランキングへ登録しました',{exact:true})).toBeVisible();
  const submissions = calls.filter(call => call.name === 'submit_score_idempotent_v1'); expect(submissions).toHaveLength(2); expect(submissions[1].args).toEqual(first);
  expect(calls.filter(call => call.name === 'finish_game_play_v1')).toHaveLength(1);
  await expect(page.getByText('まだランキングの記録がありません')).toBeVisible();
  await expect(page.getByRole('link',{name:'実験場の詳細ランキング'})).toHaveAttribute('href','https://ranking-fixture.test/ranking.html?game=fixture');
  await expect(page.getByRole('button',{name:'結果を共有する'})).toBeVisible();
  await expect(page.getByRole('button',{name:'結果をコピーする'})).toBeVisible();
  await page.evaluate(() => Object.defineProperty(navigator,'share',{value:async () => { throw new DOMException('cancelled','AbortError'); }}));
  await page.getByRole('button',{name:'結果を共有する'}).click();
  expect(calls.filter(call => call.name === 'submit_score_idempotent_v1')).toHaveLength(2);
  expect(calls.filter(call => call.name === 'start_game_play_v1')).toHaveLength(1);
});
