import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Every discovered test belongs to exactly one suite. New scenarios default to long.
export function testSuites() {
  const files = ['rules', 'input', 'scenarios', 'presentation', 'ci'].flatMap(directory =>
    readdirSync(`tests/${directory}`).filter(name => name.endsWith('.test.ts')).map(name => `tests/${directory}/${name}`)).sort();
  return {
    short: files.filter(path => !path.startsWith('tests/scenarios/')),
    long: files.filter(path => path.startsWith('tests/scenarios/')),
    all: files,
  };
}

if (process.argv[1]?.endsWith('/test-suites.mjs')) {
  const mode = process.argv[2] ?? 'all';
  const files = testSuites()[mode];
  if (!files) throw new Error(`Unknown test suite: ${mode}`);
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
