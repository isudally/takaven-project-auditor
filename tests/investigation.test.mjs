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
  assert.throws(() => validateInvestigationResponse({ action: 'request', rationale: 'unsafe patch', requests: [{ type: 'correction_verification', reason: 'try it', patch: 'diff --git a/../../outside b/../../outside\n--- a/../../outside\n+++ b/../../outside\n@@ -1 +1 @@\n-x\n+y' }] }, registry), /not allowed/);
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
    assert.equal(sourceResult.results[0].files[0].completeness, 'complete');
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('controller sends correction verification to the approved runner and preserves its result', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'takaven-investigation-correction-'));
  try {
    writeFileSync(join(checkout, 'app.mjs'), 'export const broken = true;\n');
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc', scenario: 'correction', requiredChecks: ['build', 'browser_smoke'] });
    const patch = 'diff --git a/app.mjs b/app.mjs\n--- a/app.mjs\n+++ b/app.mjs\n@@ -1 +1 @@\n-export const broken = true;\n+export const broken = false;\n';
    let invocation;
    const result = processInvestigationRequests({
      checkout,
      registry,
      requests: [{ type: 'correction_verification', reason: 'Verify the proposed correction.', patch }],
      runner: request => {
        invocation = request;
        const evidenceId = captureEvidence(registry, {
          type: 'runner_execution', action: 'correction_verification', operation: 'correction_verification',
          outcome: 'failed', execution_verified: true, exit_code: 1,
          patch_hash: 'sha256:test', observation: 'Required browser check was unavailable.',
        });
        return { evidence_id: evidenceId, outcome: 'failed', exit_code: 1 };
      },
    });
    assert.equal(invocation.operation, 'correction_verification');
    assert.equal(invocation.patch, patch);
    assert.equal(result.results[0].outcome, 'failed');
    assert.equal(result.results[0].evidence_id.startsWith('ev-'), true);
    assert.equal(registry.records.some(record => record.operation === 'correction_verification' && record.outcome === 'failed'), true);
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test('follow-up retrieval rejects git metadata and redacts repository secrets', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'takaven-investigation-safe-'));
  try {
    mkdirSync(join(checkout, '.git'));
    writeFileSync(join(checkout, '.git', 'config'), 'url = https://user:password@example.invalid/repo\n');
    mkdirSync(join(checkout, 'src'));
    writeFileSync(join(checkout, 'src', 'secret.mjs'), 'const token = "ghp_123456789012345678";\n');
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
    const result = processInvestigationRequests({ checkout, registry, requests: [
      { type: 'source_read', paths: ['.git/config'] },
      { type: 'source_read', paths: ['src/secret.mjs'] },
    ] });
    assert.equal(result.results[0].files[0].outcome, 'unavailable');
    assert.doesNotMatch(JSON.stringify(registry.records), /ghp_123|password@example/);
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test('source search reports bounded coverage and continuation state', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'takaven-investigation-search-'));
  try {
    for (let index = 0; index < 505; index += 1) writeFileSync(join(checkout, `file-${String(index).padStart(3, '0')}.mjs`), 'needle\n');
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
    const result = processInvestigationRequests({ checkout, registry, requests: [{ type: 'source_search', query: 'needle' }] });
    assert.equal(result.results[0].truncated, true);
    assert.equal(typeof result.results[0].next_continuation, 'number');
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test('follow-up source reads never load a file beyond the controller byte budget', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'takaven-investigation-budget-'));
  try {
    const content = `${'x'.repeat(150 * 1024)}\nneedle at the end\n`;
    writeFileSync(join(checkout, 'large.mjs'), content);
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
    const result = processInvestigationRequests({ checkout, registry, requests: [{ type: 'source_read', paths: ['large.mjs'] }] });
    assert.equal(result.retrievedBytes, 128 * 1024);
    assert.equal(result.results[0].files[0].completeness, 'partial');
    assert.equal(result.results[0].files[0].content.length, 128 * 1024);
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test('patch validation is limited to safe repository-relative unified diffs', () => {
  assert.deepEqual(validateProposedPatch('diff --git a/src/app.mjs b/src/app.mjs\n--- a/src/app.mjs\n+++ b/src/app.mjs\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;'), { paths: ['src/app.mjs'] });
  assert.throws(() => validateProposedPatch('diff --git a/../../outside b/../../outside\n--- a/../../outside\n+++ b/../../outside\n@@ -1 +1 @@\n-x\n+y'), /not allowed/);
  assert.throws(() => validateProposedPatch('const x = 2;'), /unified-diff/);
  assert.throws(() => validateProposedPatch('diff --git a/src/app.mjs b/src/app.mjs\n--- a/src/app.mjs\n+++ b/src/app.mjs\n@@\n-x\n+y'), /valid unified-diff hunks/);
});

test('schema-valid null correction patches remain policy-gated instead of being rejected as malformed', () => {
  const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
  assert.doesNotThrow(() => validateInvestigationResponse({ action: 'request', rationale: 'Need a correction decision.', requests: [{ type: 'correction_verification', query: null, paths: null, evidence_ids: null, experiment: null, reason: 'No patch was proposed.', patch: null, continuation: null, ranges: null }] }, registry));
});
