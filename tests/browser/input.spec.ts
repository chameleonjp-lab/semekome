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
