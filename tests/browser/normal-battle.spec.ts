import { test, expect } from '@playwright/test';

test('通常戦はホームから名前・カウントダウンを経て結果画面と再戦準備まで進む', async ({ page }) => {
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
  await expect(battle).toHaveAttribute('data-record-connection', 'unconnected');
  await expect(battle).toHaveAttribute('data-start-record-status', 'idle');
  const startedMatchId = await battle.getAttribute('data-match-id');
  const startRecordId = await battle.getAttribute('data-start-record-id');
  expect(startedMatchId).toBeTruthy();
  expect(startRecordId).toBeTruthy();
  const startedRecord = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null') as {
    matchId: string;
    start: { id: string; status: string };
    result?: unknown;
  } | null, `semekome:battle-session:${startedMatchId}`);
  expect(startedRecord).toMatchObject({ matchId: startedMatchId, start: { id: startRecordId, status: 'idle' } });
  expect(startedRecord?.result).toBeUndefined();

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
      if (Math.abs(distance) < 100) return;
      const key = axis === 'x' ? distance > 0 ? 'ArrowRight' : 'ArrowLeft' : distance > 0 ? 'ArrowDown' : 'ArrowUp';
      const ticks = Math.max(1, Math.min(120, Math.floor(Math.abs(distance) / 100) - 1));
      await walk(key, ticks === 1 ? 16 : ticks * 1000 / 60);
    }
    expect(Number(await battle.getAttribute(`data-player-${axis}`))).toBe(target);
  };

  // Use the public movement and action controls for one real supply delivery.
  // The test never replaces actors, gates, positions, or battle state.
  await walkTo('x', 94500);
  await walkTo('y', 12500);
  await walk('ArrowLeft', 200);
  // Walking over the supply floor collects cargo without an action press.
  await expect(page.locator('[data-slot]')).toHaveCount(5);
  await expect(page.locator('#battle-action')).not.toContainText('拾う');
  await expect(page.locator('[data-slot="0"]')).not.toHaveText('1：空');
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

  const result = page.locator('.battle-result');
  await expect(result).toHaveAttribute('data-flow', 'normal-result');
  await expect(result).toHaveAttribute('data-outcome', 'enemy_win');
  await expect(result).toContainText('敗北');
  await expect(result).toContainText('自陣コアへの有効命中');
  await expect(result.locator('[data-result-score-status="confirmed"]')).toContainText('点');
  await expect(result.locator('[data-result-ranking-status="unavailable"]')).toContainText('ランキング対象外');
  await expect(result.locator('[data-result-player-name]')).toHaveText('通常戦の開始検査');
  await expect(result.locator('[data-result-enemy-defeats-total]')).toHaveText(/\d+ 回/);
  await expect(result.locator('[data-result-enemy-unique-defeats]')).toHaveText(/\d+\/30 人/);
  await expect(result.locator('[data-result-player-deaths]')).toHaveText(/\d+ 回/);

  const endedMatchId = await result.getAttribute('data-match-id');
  await expect(result).toHaveAttribute('data-start-record-id', startRecordId!);
  await expect(result).toHaveAttribute('data-record-connection', 'unconnected');
  await expect(result).toHaveAttribute('data-start-record-status', 'idle');
  await expect(result).toHaveAttribute('data-result-record-status', 'idle');
  const resultSubmissionId = await result.getAttribute('data-result-submission-id');
  expect(resultSubmissionId).toBeTruthy();
  const finishedRecord = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null') as {
    matchId: string;
    start: { id: string };
    result?: { submissionId: string; payload: { matchId: string; combatMetrics: { enemyDefeatsTotal: number; enemyUniqueDefeats: number; playerDeaths: number } } };
  } | null, `semekome:battle-session:${endedMatchId}`);
  expect(finishedRecord).toMatchObject({
    matchId: endedMatchId,
    start: { id: startRecordId },
    result: { submissionId: resultSubmissionId, payload: { matchId: endedMatchId } },
  });
  const metrics = finishedRecord!.result!.payload.combatMetrics;
  await expect(result.locator('[data-result-enemy-defeats-total]')).toHaveText(`${metrics.enemyDefeatsTotal} 回`);
  await expect(result.locator('[data-result-enemy-unique-defeats]')).toHaveText(`${metrics.enemyUniqueDefeats}/30 人`);
  await expect(result.locator('[data-result-player-deaths]')).toHaveText(`${metrics.playerDeaths} 回`);
  await page.getByRole('button', { name: '再戦の準備へ' }).click();
  await expect(page.locator('.battle-setup')).toBeVisible();
  await page.getByLabel('あなたの名前').fill('再戦の状態検査');
  await page.getByRole('button', { name: '確認を開始する' }).click();
  await expect(page.locator('.battle')).toHaveAttribute('data-tick', '0');
  await expect(page.locator('.battle')).not.toHaveAttribute('data-match-id', endedMatchId!);
  expect(errors).toEqual([]);
});
