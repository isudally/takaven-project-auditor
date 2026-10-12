import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceRegistry, isEligibleRuntimeEvidence } from '../src/evidence.mjs';
import { createApprovedRunner } from '../src/runner.mjs';

test('approved runner captures independent command evidence', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'takaven-runner-'));
  try {
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
    const runner = createApprovedRunner({ config: { version: 1, build: { command: ['node', '-e', 'process.stdout.write("ok")'] } }, registry, scratch, timeoutMs: 5000 });
    const result = runner({ operation: 'build', checkout: scratch });
    assert.equal(result.outcome, 'passed');
    assert.equal(result.exit_code, 0);
    assert.equal(isEligibleRuntimeEvidence(registry, result.evidence_id, { status: 'PASS', commit: 'abc' }), true);
    assert.match(registry.records[0].stdout, /ok/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('runner rejects unapproved executables and secret environment names', () => {
  const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
  assert.throws(() => createApprovedRunner({ config: { version: 1, build: { command: ['sh', '-c', 'true'] } }, registry, scratch: tmpdir() }), /not approved/);
  assert.throws(() => createApprovedRunner({ config: { version: 1, build: { command: ['node', '-e', 'true'], env: { API_TOKEN: 'x' } } }, registry, scratch: tmpdir() }), /not allowed/);
});
