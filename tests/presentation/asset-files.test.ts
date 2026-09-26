import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GAME_ART_NAMES, GAME_ART_URLS, type GameArtName } from '../../src/presentation/game-art.ts';

test('every registered game image ships with matching content and transparent sprites', () => {
  const root = new URL('../../', import.meta.url);
  const register = JSON.parse(readFileSync(new URL('docs/ART_ASSET_REGISTER.json', root), 'utf8'));
  assert.deepEqual(register.assets.map((a: { id: string }) => a.id).sort(), [...GAME_ART_NAMES].sort());
  let total = 0;
  for (const asset of register.assets) {
    assert.equal(`public${GAME_ART_URLS[asset.id as GameArtName]}`, asset.runtime_file, `${asset.id} runtime URL must match the verified file`);
    const bytes = readFileSync(new URL(asset.runtime_file, root));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', asset.id);
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', asset.id);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.runtime_sha256, asset.id);
    assert.equal(bytes.length, asset.bytes, asset.id);
    if (asset.transparent_expected) {
      assert.equal(bytes.toString('ascii', 12, 16), 'VP8X', asset.id);
      assert.ok(bytes[20] & 0x10, `${asset.id} must retain its alpha channel`);
    }
    total += bytes.length;
  }
  assert.equal(total, register.total_runtime_bytes);
  assert.ok(total < 1024 * 1024, 'keep the complete runtime art set below 1 MiB');
});
