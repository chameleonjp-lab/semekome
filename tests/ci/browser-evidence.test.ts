import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('browser evidence can run after a simulation failure without hiding the failed Quality check', () => {
  const workflow = readFileSync('.github/workflows/quality.yml', 'utf8');
  assert.match(workflow, /name: Full battle and endurance tests\n\s+if: steps.scope.outputs.run_long == 'true'\n\s+run: npm run test:long/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.match(workflow, /id: build\n\s+if: \$\{\{ !cancelled\(\) && steps.dependencies.outcome == 'success'/);
  assert.match(workflow, /id: browser_dependencies\n\s+if: \$\{\{ !cancelled\(\) && env.RUN_BROWSER == 'true' && steps.build.outcome == 'success'/);
  assert.match(workflow, /name: Run browser tests\n\s+if: \$\{\{ !cancelled\(\) && env.RUN_BROWSER == 'true' && steps.browser_fonts.outcome == 'success'/);
  const pages = readFileSync('.github/workflows/pages.yml', 'utf8');
  assert.ok(pages.includes("github.event.workflow_run.conclusion == 'success'"), 'failed Quality cannot trigger automatic deployment');
});
