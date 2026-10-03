import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ACTOR_ART_NAMES } from '../../src/presentation/game-art.ts';

test('all twenty-four directional assets match their origin record and original role references', () => {
  const manifest = JSON.parse(readFileSync('docs/DIRECTIONAL_ART_REGISTER.json', 'utf8'));
  assert.equal(manifest.assets.length, 24);
  const ids = new Set(manifest.assets.map((asset: { id: string }) => asset.id));
  for (const role of ACTOR_ART_NAMES) for (const facing of ['front', 'back', 'left', 'right']) assert.ok(ids.has(`${role}-${facing}`));
  for (const asset of manifest.assets) {
    const bytes = readFileSync(asset.runtime_file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.runtime_sha256);
    assert.equal(createHash('sha256').update(readFileSync(asset.reference_file)).digest('hex'), asset.reference_sha256);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    assert.equal(bytes.length, asset.bytes);
    assert.equal(asset.width, 256);
    assert.equal(asset.height, 256);
    assert.equal(asset.has_alpha, true);
    assert.equal(asset.independently_generated, true);
    assert.equal(asset.mirrored, false);
    assert.ok(asset.alpha_pixels.transparent > 0);
    assert.ok(asset.opaque_bounds.left > 0 && asset.opaque_bounds.right < 256);
    assert.ok(asset.opaque_bounds.top > 0 && asset.opaque_bounds.bottom < 256);
  }
});
