import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export function qualityScope(paths) {
  // Only an explicit documentation allowlist can skip runtime checks. JSON and
  // unknown files deliberately fall through to the full suite.
  const docsOnly = paths.length > 0 && paths.every(path =>
    path === 'README.md' || path === 'AGENTS.md' ||
    (path.startsWith('docs/') && /\.(md|pdf|svg|webp|txt)$/.test(path)));
  return { docsOnly, runGame: !docsOnly, runLong: !docsOnly };
}

if (process.argv[1]?.endsWith('/quality-scope.mjs')) {
  let paths = [];
  try {
    const base = process.argv[2];
    const head = process.argv[3];
    if (!base || !head || /^0+$/.test(base)) throw new Error('No usable base');
    paths = execFileSync('git', ['diff', '--name-only', '--no-renames', base, head], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    console.log('Change range unavailable; using all runtime checks.');
  }
  const scope = qualityScope(paths);
  console.log(JSON.stringify(scope));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `run_game=${scope.runGame}\nrun_long=${scope.runLong}\n`);
}
