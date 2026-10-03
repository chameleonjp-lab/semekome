import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('publication checker validates static artifacts while paused without reading connection config or contacting ranking', () => {
  const directory = mkdtempSync(join(tmpdir(), 'semekome-publish-check-'));
  const fixture = join(directory, 'fixture.mjs');
  try {
    writeFileSync(fixture, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const manifest = JSON.parse(fs.readFileSync('ranking-manifest.json', 'utf8'));
      const originalRead = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        if (path === '.env.production') throw new Error('Suspension must not read connection configuration');
        if (typeof path === 'string' && path.startsWith('dist/')) return Buffer.from('fixture-static-asset');
        return originalRead.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      globalThis.fetch = async raw => {
        const url = new URL(raw);
        const base = new URL(manifest.canonical_url);
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('Unexpected external request');
        const path = url.pathname.slice(base.pathname.length);
        if (path.includes('rest/v1') || path.includes('rpc/')) throw new Error('Ranking must not be queried');
        if (!path) return new Response('<title>セメコメ</title><link href="' + base.href + '"><meta content="' + manifest.client_version + '"><script src="./assets/fixture.js"></script><link href="./assets/fixture.css">');
        if (path === 'ranking-manifest.json') return Response.json(manifest);
        if (path === 'commit.txt') return new Response('a'.repeat(40));
        if (path === 'THIRD_PARTY_LICENSES.txt') return new Response('MIT');
        return new Response('fixture-static-asset');
      };
    `);
    const output = execFileSync(process.execPath, ['--import', fixture, 'scripts/verify-publication.mjs', 'a'.repeat(40)], { encoding: 'utf8' });
    const report = JSON.parse(output);
    assert.equal(report.result, 'passed');
    assert.equal(report.rankingStatus, 'suspended_not_contacted');
    assert.equal(report.builtAssets, 2);
    assert.equal(report.images, 22);
    assert.equal(report.activeGame, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
