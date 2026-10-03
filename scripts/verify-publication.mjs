import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { rankingSuspended } from '../src/ranking/ranking-policy.ts';

const manifest = JSON.parse(readFileSync('ranking-manifest.json', 'utf8'));
const base = manifest.canonical_url;
const expectedCommit = process.argv[2];
const request = async (path, options) => {
  const response = await fetch(new URL(path,base), { ...options, signal:AbortSignal.timeout(10000) });
  assert.equal(response.ok,true,`HTTP ${response.status} for ${path}`);
  return response;
};
const html = await (await request('')).text();
assert.match(html,/<title>セメコメ<\/title>/);
assert.ok(html.includes(`href="${base}"`),'canonical URL mismatch');
assert.ok(html.includes(`content="${manifest.client_version}"`),'client version mismatch');
assert.deepEqual(await (await request('ranking-manifest.json')).json(),manifest);
const commit = (await (await request('commit.txt')).text()).trim();
assert.match(commit,/^[0-9a-f]{40}$/);
if (expectedCommit) assert.equal(commit,expectedCommit,'deployed commit mismatch');
const paths = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"\s]+\.(?:js|css))"/g)].map(match => match[1]);
assert.ok(paths.some(path => path.endsWith('.js')) && paths.some(path => path.endsWith('.css')),'missing built assets');
for (const path of paths) {
  const data = Buffer.from(await (await request(path)).arrayBuffer());
  const local = readFileSync(`dist/${path.replace('./','')}`);
  assert.equal(createHash('sha256').update(data).digest('hex'),createHash('sha256').update(local).digest('hex'),`asset mismatch: ${path}`);
}
const images = readdirSync('public/assets/generated').filter(path => path.endsWith('.webp'));
assert.equal(images.length,22);
for (const path of images) await request(`assets/generated/${path}`);
assert.ok((await (await request('THIRD_PARTY_LICENSES.txt')).text()).includes('MIT'));
// Verification must not treat the owner's suspension as a publication failure,
// or query ranking while the runtime intentionally remains offline.
let rankingCheck = { rankingStatus: 'suspended_not_contacted' };
if (!rankingSuspended()) {
  const env = Object.fromEntries(readFileSync('.env.production','utf8').trim().split('\n').filter(line => !line.trimStart().startsWith('#')).map(line => { const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }));
  const headers = {apikey:env.VITE_SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'};
  const slug = manifest.lab.representative_slug;
  const gamesResponse = await fetch(`${env.VITE_SUPABASE_REST_ENDPOINT}/games?game_slug=eq.${slug}&select=game_slug,game_url,is_active,score_order,score_unit,score_min,score_max,submission_mode`,{headers,signal:AbortSignal.timeout(8000)});
  assert.ok(gamesResponse.ok,`game registration HTTP ${gamesResponse.status}`);
  const games = await gamesResponse.json(); assert.equal(games.length,1);
  const entry = manifest.ranking_entries.find(entry => entry.game_slug===slug);
  for (const field of ['game_slug','score_order','score_unit','score_min','score_max']) assert.equal(games[0][field],entry[field],`registration ${field} mismatch`);
  assert.equal(games[0].game_url,base); assert.equal(games[0].is_active,true); assert.equal(games[0].submission_mode,'shared');
  const rankingResponse = await fetch(`${env.VITE_SUPABASE_REST_ENDPOINT}/rpc/get_game_ranking`,{method:'POST',headers,body:JSON.stringify({p_game_slug:slug,p_limit:10}),signal:AbortSignal.timeout(8000)});
  assert.ok(rankingResponse.ok,`ranking RPC HTTP ${rankingResponse.status}`);
  const ranking=await rankingResponse.json(); assert.ok(Array.isArray(ranking) && ranking.length<=10);
  rankingCheck = { rankingStatus: 'connected', activeGame: slug, rankingRows: ranking.length };
}
console.log(JSON.stringify({url:base,commit,clientVersion:manifest.client_version,builtAssets:paths.length,images:images.length,...rankingCheck,result:'passed'},null,2));
