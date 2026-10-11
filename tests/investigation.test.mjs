import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceRegistry, captureEvidence } from '../src/evidence.mjs';
import { processInvestigationRequests, validateInvestigationResponse, validateProposedPatch, MAX_RETRIEVAL_BYTES } from '../src/investigation.mjs';

test('validates bounded investigation requests and rejects unsafe controls', () => {
  const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
  const id = captureEvidence(registry, { type: 'runtime', outcome: 'captured' });
  assert.doesNotThrow(() => validateInvestigationResponse({ action: 'request', rationale: 'Need the entry point', requests: [{ type: 'source_read', paths: ['src/app.mjs'] }] }, registry));
  assert.doesNotThrow(() => validateInvestigationResponse({ action: 'request', rationale: 'No further evidence needed', requests: [] }, registry));
  assert.doesNotThrow(() => validateInvestigationResponse({ action: 'request', rationale: 'Need the captured failure', requests: [{ type: 'runtime_evidence', evidence_ids: [id] }] }, registry));
  assert.doesNotThrow(() => validateInvestigationResponse({ action: 'request', rationale: 'Need the captured runtime bundle', requests: [{ type: 'runtime_evidence', evidence_ids: null }] }, registry));
  assert.throws(() => validateInvestigationResponse({ action: 'request', rationale: 'escape', requests: [{ type: 'source_read', paths: ['../../secret'] }] }, registry), /not allowed/);
  assert.throws(() => validateInvestigationResponse({ action: 'request', rationale: 'arbitrary', requests: [{ type: 'experiment', experiment: 'shell' }] }, registry), /pre-approved/);
  assert.throws(() => validateInvestigationResponse({ action: 'request', rationale: 'forge', requests: [{ type: 'runtime_evidence', evidence_ids: ['ev-0000000000000000'] }] }, registry), /unknown evidence ID/);
  assert.throws(() => validateInvestigationResponse({ action: 'request', rationale: 'unsafe patch', requests: [{ type: 'correction_verification', reason: 'try it', patch: '--- a/../../outside\n+++ b/../../outside\n' }] }, registry), /not allowed/);
});

test('controller retrieves requested source and records immutable evidence', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'takaven-investigation-'));
  try {
    mkdirSync(join(checkout, 'src'));
    writeFileSync(join(checkout, 'src', 'app.mjs'), 'export const typography = {};\n');
    writeFileSync(join(checkout, 'README.md'), 'typography documentation\n');
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
    const sourceResult = processInvestigationRequests({
      checkout, registry,
      requests: [
        { type: 'source_read', paths: ['src/app.mjs'] },
        { type: 'source_search', query: 'typography' },
        { type: 'experiment', experiment: 'browser_smoke' },
      ],
    });
    assert.equal(sourceResult.results[0].files[0].path, 'src/app.mjs');
    assert.match(sourceResult.results[0].files[0].content, /typography/);
    assert.ok(sourceResult.results[0].files[0].evidence_id.startsWith('ev-'));
    assert.ok(sourceResult.results[1].matches.length >= 1);
    assert.equal(sourceResult.results[2].outcome, 'not_available');
    assert.ok(sourceResult.retrievedBytes <= MAX_RETRIEVAL_BYTES);
    assert.ok(sourceResult.retrievedPaths.includes('src/app.mjs'));
    assert.ok(registry.records.every(record => Object.isFrozen(record)));
    assert.equal(registry.records.some(record => record.type === 'experiment' && record.outcome === 'not_available'), true);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('patch validation is limited to safe repository-relative unified diffs', () => {
  assert.deepEqual(validateProposedPatch('--- a/src/app.mjs\n+++ b/src/app.mjs\n@@\n-const x = 1;\n+const x = 2;'), { paths: ['src/app.mjs'] });
  assert.throws(() => validateProposedPatch('--- a/../../outside\n+++ b/../../outside\n'), /not allowed/);
  assert.throws(() => validateProposedPatch('const x = 2;'), /unified-diff/);
});
