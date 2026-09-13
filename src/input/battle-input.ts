import type { BattleDirection } from '../simulation/physical-battle.ts';

/** One movement pointer; action pointers never replace it. */
export function bindMovement(pad: HTMLElement): { direction: () => BattleDirection; clear: () => void; dispose: () => void } {
  let pointer: number | null = null;
  let value: BattleDirection = { x: 0, y: 0 };
  const keys = new Set<string>();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const update = (event: PointerEvent) => {
    const box = pad.getBoundingClientRect();
    const x = (event.clientX - box.x - box.width / 2) / (box.width / 2);
    const y = (event.clientY - box.y - box.height / 2) / (box.height / 2);
    value = { x: Math.abs(x) < .22 ? 0 : x > 0 ? 1 : -1, y: Math.abs(y) < .22 ? 0 : y > 0 ? 1 : -1 };
    pad.style.setProperty('--stick-x', `${Math.max(-30, Math.min(30, x * 30))}px`);
    pad.style.setProperty('--stick-y', `${Math.max(-30, Math.min(30, y * 30))}px`);
  };
  const clear = () => {
    const held = pointer; pointer = null; value = { x: 0, y: 0 }; keys.clear();
    if (held !== null && pad.hasPointerCapture(held)) pad.releasePointerCapture(held);
    pad.style.setProperty('--stick-x', '0px'); pad.style.setProperty('--stick-y', '0px');
  };
  pad.addEventListener('pointerdown', event => {
    if (pointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointer = event.pointerId; pad.setPointerCapture(pointer); update(event); event.preventDefault();
  }, options);
  pad.addEventListener('pointermove', event => { if (pointer === event.pointerId) update(event); }, options);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    pad.addEventListener(name, event => { if (event.pointerId === pointer) clear(); }, options);
  }
  const movementKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'];
  window.addEventListener('keydown', event => {
    if (!movementKeys.includes(event.key) || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    keys.add(event.key); event.preventDefault();
  }, options);
  window.addEventListener('keyup', event => { keys.delete(event.key); }, options);
  window.addEventListener('blur', clear, options);
  document.addEventListener('visibilitychange', clear, options);
  return {
    direction: () => pointer !== null ? { ...value } : {
      x: (Number(keys.has('ArrowRight') || keys.has('d')) - Number(keys.has('ArrowLeft') || keys.has('a'))) as -1 | 0 | 1,
      y: (Number(keys.has('ArrowDown') || keys.has('s')) - Number(keys.has('ArrowUp') || keys.has('w'))) as -1 | 0 | 1,
    },
    clear,
    dispose: () => { clear(); controller.abort(); },
  };
}
