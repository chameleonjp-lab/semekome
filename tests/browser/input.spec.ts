import { test, expect } from '@playwright/test';

test('移動用pointerを固定し、別の指と解除イベントを混同しない', async ({ page }) => {
  // An isolated adapter fixture. Synthetic pointer IDs cannot acquire real
  // browser capture, so capture bookkeeping is replaced only in this fixture.
  await page.route('http://127.0.0.1:4173/', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="pad" style="width:120px;height:120px"></div><output id="direction"></output><script type="module">
    import { bindMovement } from '/src/input/battle-input.ts';
    const pad = document.querySelector('#pad');
    const captured = new Set();
    pad.setPointerCapture = id => captured.add(id);
    pad.hasPointerCapture = id => captured.has(id);
    pad.releasePointerCapture = id => captured.delete(id);
    const input = bindMovement(pad);
    window.readDirection = input.direction;
    window.disposeInput = input.dispose;
    document.body.dataset.ready = 'true';
  </script></body></html>` }));
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const pad = page.locator('#pad');
  const box = (await pad.boundingBox())!;
  const read = () => page.evaluate(() => (window as unknown as { readDirection: () => { x: number; y: number } }).readDirection());
  const right = { pointerId: 1, pointerType: 'touch', button: 0, clientX: box.x + 115, clientY: box.y + 60 };
  await pad.dispatchEvent('pointerdown', right);
  expect(await read()).toEqual({ x: 1, y: 0 });
  await pad.dispatchEvent('pointerdown', { ...right, pointerId: 2, clientX: box.x + 5 });
  await pad.dispatchEvent('pointermove', { ...right, pointerId: 2, clientX: box.x + 5 });
  await pad.dispatchEvent('pointerup', { ...right, pointerId: 2 });
  expect(await read()).toEqual({ x: 1, y: 0 });
  await pad.dispatchEvent('pointercancel', right);
  expect(await read()).toEqual({ x: 0, y: 0 });
  await page.keyboard.down('ArrowUp');
  expect(await read()).toEqual({ x: 0, y: -1 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect(await read()).toEqual({ x: 0, y: 0 });
  await page.keyboard.up('ArrowUp');
  await page.evaluate(() => (window as unknown as { disposeInput: () => void }).disposeInput());
  await pad.dispatchEvent('pointerdown', right);
  expect(await read()).toEqual({ x: 0, y: 0 });
});

test('突進は移動と別pointerで一回だけ発火し、押下時方向と解除境界を保つ', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { bindMovement, bindDashInput } = await new Function('return import("/src/input/battle-input.ts")')();
    const pad = document.createElement('div');
    const button = document.createElement('button');
    const field = document.createElement('input');
    pad.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:120px';
    document.body.append(pad, button, field);
    for (const node of [pad, button]) {
      const captured = new Set<number>();
      node.setPointerCapture = id => { captured.add(id); };
      node.hasPointerCapture = id => captured.has(id);
      node.releasePointerCapture = id => { captured.delete(id); };
    }
    const movement = bindMovement(pad);
    const pressed: { x: number; y: number }[] = [];
    const dash = bindDashInput(button, () => pressed.push(movement.lastDirection()));
    const touch = (node: HTMLElement, type: string, id: number, x = 115) => node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: 60 }));
    touch(pad, 'pointerdown', 1);
    touch(button, 'pointerdown', 2);
    touch(button, 'pointerdown', 3);
    touch(button, 'pointerup', 3);
    const whileAttackHeld = movement.direction();
    touch(pad, 'pointermove', 1, 5);
    const capturedFirstDirection = { ...pressed[0] };
    touch(button, 'pointerup', 2);
    touch(button, 'pointerdown', 3);
    touch(button, 'pointercancel', 3);
    touch(pad, 'pointercancel', 1);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    const countAfterFormSpace = pressed.length;
    movement.setEnabled(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true }));
    movement.setEnabled(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true }));
    const repeatedAfterResume = movement.direction();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: true }));
    dash.setEnabled(false);
    dash.setEnabled(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: true }));
    const countWhileHeld = pressed.length;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    dash.dispose(); movement.dispose();
    touch(button, 'pointerdown', 4);
    pad.remove(); button.remove(); field.remove();
    return { pressed, whileAttackHeld, capturedFirstDirection, countAfterFormSpace, repeatedAfterResume, countWhileHeld };
  });
  expect(result.whileAttackHeld).toEqual({ x: 1, y: 0 });
  expect(result.capturedFirstDirection).toEqual({ x: 1, y: 0 });
  expect(result.pressed).toEqual([{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: -1 }]);
  expect(result.countAfterFormSpace).toBe(2);
  expect(result.repeatedAfterResume).toEqual({ x: 0, y: 0 });
  expect(result.countWhileHeld).toBe(3);
});

test('Space押下中の画面離脱でkeyupを失っても支援技術のクリックは復帰できる', async ({ page }) => {
  await page.goto('/');
  const presses = await page.evaluate(async () => {
    const { bindDashInput } = await new Function('return import("/src/input/battle-input.ts")')();
    const button = document.createElement('button');
    document.body.append(button);
    let count = 0;
    const dash = bindDashInput(button, () => { count++; });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    window.dispatchEvent(new Event('blur'));
    dash.setEnabled(false);
    dash.setEnabled(true);
    // The old physical keyup happened outside the document. A fresh AT click
    // must not be blocked indefinitely by native Space-click deduplication.
    await new Promise(resolve => window.setTimeout(resolve, 0));
    button.click();
    dash.dispose(); button.remove();
    return count;
  });
  expect(presses).toBe(2);
});
