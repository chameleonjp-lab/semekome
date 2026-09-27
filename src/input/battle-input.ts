import type { BattleDirection } from '../simulation/physical-battle.ts';

/** One movement pointer; action pointers never replace it. */
export function bindMovement(pad: HTMLElement): { direction: () => BattleDirection; lastDirection: () => BattleDirection; clear: () => void; setEnabled: (enabled: boolean) => void; dispose: () => void } {
  let pointer: number | null = null;
  let enabled = true;
  let value: BattleDirection = { x: 0, y: 0 };
  let lastValue: BattleDirection = { x: 1, y: 0 };
  const keys = new Set<string>();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const movementKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'];
  const fromKeys = (): BattleDirection => ({
    x: (Number(keys.has('ArrowRight') || keys.has('d')) - Number(keys.has('ArrowLeft') || keys.has('a'))) as -1 | 0 | 1,
    y: (Number(keys.has('ArrowDown') || keys.has('s')) - Number(keys.has('ArrowUp') || keys.has('w'))) as -1 | 0 | 1,
  });
  const current = (): BattleDirection => pointer !== null ? value : fromKeys();
  const remember = (direction: BattleDirection) => {
    if (direction.x !== 0 || direction.y !== 0) lastValue = { ...direction };
  };
  const resetPad = () => {
    pad.style.setProperty('--stick-x', '0px'); pad.style.setProperty('--stick-y', '0px');
  };
  const update = (event: PointerEvent) => {
    const box = pad.getBoundingClientRect();
    const x = (event.clientX - box.x - box.width / 2) / (box.width / 2);
    const y = (event.clientY - box.y - box.height / 2) / (box.height / 2);
    value = { x: Math.abs(x) < .22 ? 0 : x > 0 ? 1 : -1, y: Math.abs(y) < .22 ? 0 : y > 0 ? 1 : -1 };
    remember(value);
    pad.style.setProperty('--stick-x', `${Math.max(-30, Math.min(30, x * 30))}px`);
    pad.style.setProperty('--stick-y', `${Math.max(-30, Math.min(30, y * 30))}px`);
  };
  const releasePointer = () => {
    const held = pointer;
    remember(current());
    pointer = null; value = { x: 0, y: 0 };
    if (held !== null && pad.hasPointerCapture(held)) pad.releasePointerCapture(held);
    resetPad(); remember(current());
  };
  const clear = () => {
    remember(current());
    releasePointer(); keys.clear();
  };
  pad.addEventListener('pointerdown', event => {
    if (!enabled || pointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointer = event.pointerId; pad.setPointerCapture(pointer); update(event); event.preventDefault();
  }, options);
  pad.addEventListener('pointermove', event => { if (pointer === event.pointerId) update(event); }, options);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    pad.addEventListener(name, event => { if (event.pointerId === pointer) releasePointer(); }, options);
  }
  window.addEventListener('keydown', event => {
    if (!movementKeys.includes(event.key) || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.repeat) { if (enabled) event.preventDefault(); return; }
    if (!enabled) return;
    keys.add(event.key); remember(current()); event.preventDefault();
  }, options);
  window.addEventListener('keyup', event => {
    if (!movementKeys.includes(event.key)) return;
    remember(current()); keys.delete(event.key); remember(current());
  }, options);
  window.addEventListener('blur', clear, options);
  document.addEventListener('visibilitychange', clear, options);
  return {
    direction: () => enabled ? { ...current() } : { x: 0, y: 0 },
    lastDirection: () => ({ ...lastValue }),
    clear,
    setEnabled: (next) => { enabled = next; if (!enabled) clear(); },
    dispose: () => { clear(); controller.abort(); },
  };
}

/** One edge-triggered dash input, independent from the movement pointer. */
export function bindDashInput(button: HTMLButtonElement, onPress: () => void): { clear: () => void; setEnabled: (enabled: boolean) => void; dispose: () => void } {
  let enabled = true;
  let pointer: number | null = null;
  let spaceDown = false;
  let suppressSpaceUntilKeyup = false;
  let suppressKeyboardClick = false;
  let clickResetTimer: number | undefined;
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const resetKeyboardClickSuppression = () => {
    if (clickResetTimer !== undefined) window.clearTimeout(clickResetTimer);
    clickResetTimer = window.setTimeout(() => {
      suppressKeyboardClick = false;
      clickResetTimer = undefined;
    }, 0);
  };
  const clear = () => {
    const held = pointer; pointer = null;
    if (held !== null && button.hasPointerCapture(held)) button.releasePointerCapture(held);
    if (spaceDown) { spaceDown = false; suppressSpaceUntilKeyup = true; }
    // A keyup may be lost outside the document. Keep same-task Space-click
    // deduplication, but never lock out later Enter/assistive clicks.
    if (suppressKeyboardClick) resetKeyboardClickSuppression();
  };
  button.addEventListener('pointerdown', event => {
    if (!enabled || button.disabled || pointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointer = event.pointerId;
    button.setPointerCapture(pointer);
    event.preventDefault();
    onPress();
  }, options);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    button.addEventListener(name, event => {
      if (event.pointerId !== pointer) return;
      const held = pointer; pointer = null;
      if (held !== null && button.hasPointerCapture(held)) button.releasePointerCapture(held);
    }, options);
  }
  // Pointer presses are handled on pointerdown; detail 0 keeps Enter and
  // assistive-technology activation available without duplicating pointer input.
  button.addEventListener('click', event => {
    if (event.detail !== 0 || suppressKeyboardClick || !enabled || button.disabled) return;
    onPress();
  }, options);
  window.addEventListener('keydown', event => {
    if (event.code !== 'Space' && event.key !== ' ' && event.key !== 'Spacebar') return;
    const target = event.target;
    if (target instanceof Element && target !== button && target.closest('input, textarea, select, button, [contenteditable="true"], [role="button"]')) return;
    event.preventDefault();
    if (!enabled || button.disabled || event.repeat || spaceDown || suppressSpaceUntilKeyup) return;
    spaceDown = true;
    suppressKeyboardClick = true;
    onPress();
  }, options);
  window.addEventListener('keyup', event => {
    if (event.code !== 'Space' && event.key !== ' ' && event.key !== 'Spacebar') return;
    spaceDown = false;
    suppressSpaceUntilKeyup = false;
    resetKeyboardClickSuppression();
  }, options);
  window.addEventListener('blur', clear, options);
  document.addEventListener('visibilitychange', clear, options);
  return {
    clear,
    setEnabled: next => { enabled = next; if (!enabled) clear(); },
    dispose: () => {
      clear();
      if (clickResetTimer !== undefined) window.clearTimeout(clickResetTimer);
      controller.abort();
    },
  };
}
