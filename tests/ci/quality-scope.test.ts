import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error JavaScript CI tooling is exercised directly by Node.
import { qualityScope } from '../../scripts/quality-scope.mjs';
// @ts-expect-error JavaScript CI tooling is exercised directly by Node.
import { testSuites } from '../../scripts/test-suites.mjs';

test('only known documentation changes can skip runtime checks', () => {
  assert.equal(qualityScope(['docs/TEST_REPORT.md', 'README.md']).runLong, false);
  for (const path of ['src/presentation/battle-screen.ts', 'docs/plans/current/INITIAL_RULES.json',
    'package-lock.json', '.github/workflows/quality.yml', 'new-unknown-file', 'tests/scenarios/new.test.ts']) {
    assert.equal(qualityScope([path]).runLong, true, path);
    assert.equal(qualityScope(['docs/TEST_REPORT.md', path]).runGame, true, path);
  }
  assert.equal(qualityScope([]).runLong, true);
});

test('short and long suites partition every Node test without dropping scenarios', () => {
  const suites = testSuites();
  assert.deepEqual([...suites.short, ...suites.long].sort(), suites.all);
  assert.equal(new Set([...suites.short, ...suites.long]).size, suites.all.length);
  assert.ok(suites.long.includes('tests/scenarios/r2v-standard-player-g1-infiltration.test.ts'));
  assert.ok(suites.long.includes('tests/scenarios/r2a-flow.test.ts'));
});
