import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRankingRuntime } from '../../src/ranking/runtime-ranking.ts';

test('owner suspension returns before environment, client, storage or fetch access', () => {
  const originalFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let requests = 0, reads = 0;
  globalThis.fetch = async () => { requests++; throw new Error('No requests during suspension'); };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { reads++; throw new Error('Pending records must remain untouched'); } });
  try {
    // Node has no import.meta.env; reaching configuration would also throw.
    for (let attempt = 0; attempt < 5; attempt++) assert.equal(loadRankingRuntime(), undefined);
    assert.equal(requests, 0);
    assert.equal(reads, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
