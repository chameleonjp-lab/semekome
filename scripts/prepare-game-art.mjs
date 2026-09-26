/** Rebuild runtime WebP files from the original image-generation outputs.
 * node scripts/prepare-game-art.mjs /absolute/path/to/generated_images
 * Requires sharp (or CODEX_PRIMARY_RUNTIME_NODE_MODULES pointing to it).
 * This is an authoring tool, not a runtime/build dependency.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'sharp') : 'sharp');
const root = new URL('../', import.meta.url);
const manifestFile = new URL('docs/ART_ASSET_REGISTER.json', root);
const register = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
const sourceDirectory = process.argv[2];
if (!sourceDirectory) throw new Error('Specify the directory containing the original generated PNG files.');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
for (const asset of register.assets) {
  const source = await fs.readFile(path.join(sourceDirectory, asset.source_file));
  if (sha256(source) !== asset.source_sha256) throw new Error(`Original image hash mismatch: ${asset.id}`);
  const destination = new URL(asset.runtime_file, root);
  await fs.mkdir(path.dirname(destination.pathname), { recursive: true });
  await sharp(source).resize({ width: asset.id === 'stage' ? 1200 : 256, withoutEnlargement: true })
    .webp({ quality: asset.id === 'stage' ? 84 : 90, alphaQuality: 100 }).toFile(destination.pathname);
  const bytes = await fs.readFile(destination);
  const info = await sharp(bytes).metadata();
  asset.runtime_sha256 = sha256(bytes);
  asset.bytes = bytes.length;
  asset.width = info.width;
  asset.height = info.height;
  asset.has_alpha = info.hasAlpha;
}
register.total_runtime_bytes = register.assets.reduce((sum, a) => sum + a.bytes, 0);
register.conversion = { engine: 'sharp', version: sharp.versions.sharp, colour: 'unchanged',
  resize: 'stage width 1200; all other images width 256; preserve aspect ratio',
  format: 'WebP; quality stage 84 / others 90; alphaQuality 100; original alpha retained' };
await fs.writeFile(manifestFile, JSON.stringify(register, null, 2) + '\n');
console.log(`${register.assets.length} assets, ${register.total_runtime_bytes} bytes`);
