import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('all 82 requirements and 135 acceptance plans retain status and have release-stage review references', () => {
  const requirements = JSON.parse(readFileSync('docs/plans/current/REQUIREMENTS.json', 'utf8')).requirements;
  const plans = JSON.parse(readFileSync('docs/plans/current/ACCEPTANCE_TESTS.json', 'utf8')).tests;
  assert.equal(requirements.length, 82);
  assert.equal(plans.length, 135);
  const stageById = new Map(requirements.map((row: any) => [row.id, row.release_stage]));
  for (const row of requirements) {
    assert.ok(row.release_stage >= 1 && row.release_stage <= 5, row.id);
    assert.equal(row.evidence_review.status, 'partial_or_pending_acceptance');
  }
  for (const row of plans) {
    assert.equal(row.execution_status, 'not_run', row.id);
    assert.deepEqual(row.release_stages, [...new Set(row.requirement_ids.map((id: string) => stageById.get(id)))].sort(), row.id);
  }
  for (const row of [...requirements, ...plans]) {
    assert.ok(row.evidence_review.references.length > 0, row.id);
    for (const path of row.evidence_review.references) assert.ok(existsSync(path), `${row.id}: ${path}`);
  }
});
