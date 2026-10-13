import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceRegistry, captureEvidence } from '../src/evidence.mjs';
import { applyControllerRuntimeResults } from '../src/runtime.mjs';
import { validateReport, applyTrustedMetadata } from '../src/core.mjs';

const baseReport = {
  project: 'fixture', commit: 'model-commit', verdict: 'CONTINUE', executive_summary: 'Evidence review.',
  runtime_status: 'NOT RUN', runtime_evidence: [], findings: [], reuse_assessment: [], commercial_risks: [],
  unverified: [], next_actions: [],
};

test('retained mismatch reproduces the original validation failure before handoff', () => {
  const registry = createEvidenceRegistry({ source: 'fixture', commit: 'trusted-commit', scenario: 'web-proof' });
  const executionId = captureEvidence(registry, { type: 'runner_execution', operation: 'build', execution_verified: true, outcome: 'passed', exit_code: 0 });
  const contradictory = { ...baseReport, commit: 'trusted-commit', runtime_status: 'NOT RUN', runtime_evidence: [{ check: 'build', status: 'PASS', command: 'npm run build', observation: 'model claim', negative_control: 'none', evidence_ids: [executionId] }] };
  assert.throws(() => validateReport(contradictory, { mode: 'verify', evidenceRegistry: registry, requireEvidenceIds: true }), /Runtime NOT RUN cannot contain executed evidence/);
  const trusted = applyTrustedMetadata({ ...contradictory, commit: 'model-commit' }, { project: 'fixture', commit: 'trusted-commit', mode: 'verify', source: 'fixture', auditedAt: '2026-10-12T00:00:00.000Z' });
  const handedOff = applyControllerRuntimeResults(trusted, registry, { scenario: 'web-proof' });
  assert.equal(handedOff.report.runtime_status, 'PASS');
  assert.doesNotThrow(() => validateReport(handedOff.report, { mode: 'verify', evidenceRegistry: registry, requireEvidenceIds: true }));
});

test('controller derives PARTIAL when build passes but required browser check is absent', () => {
  const registry = createEvidenceRegistry({ source: 'fixture', commit: 'trusted-commit', scenario: 'web-proof', requiredChecks: ['build', 'browser_smoke'] });
  const buildId = captureEvidence(registry, { type: 'runner_execution', operation: 'build', command: 'npm run build', execution_verified: true, outcome: 'passed', exit_code: 0 });
  const result = applyControllerRuntimeResults(baseReport, registry, { scenario: 'web-proof' });
  assert.equal(result.report.runtime_status, 'PARTIAL');
  assert.equal(result.report.runtime_evidence.find(entry => entry.check === 'build').status, 'PASS');
  assert.equal(result.report.runtime_evidence.find(entry => entry.check === 'browser_smoke').status, 'NOT RUN');
  assert.equal(result.report.runtime_evidence.find(entry => entry.check === 'build').evidence_ids[0], buildId);
  assert.ok(result.contradictions.length > 0);
  const trusted = { ...result.report, commit: 'trusted-commit' };
  assert.doesNotThrow(() => validateReport(trusted, { mode: 'verify', evidenceRegistry: registry, requireEvidenceIds: true }));
});

test('controller status overrides contradictory model status and records the contradiction', () => {
  const registry = createEvidenceRegistry({ source: 'fixture', commit: 'trusted-commit', scenario: 'web-proof', requiredChecks: ['build'] });
  const buildId = captureEvidence(registry, { type: 'runner_execution', operation: 'build', command: 'npm run build', execution_verified: true, outcome: 'passed', exit_code: 0 });
  const model = { ...baseReport, commit: 'model-commit', runtime_status: 'NOT RUN', runtime_evidence: [{ check: 'build', status: 'NOT RUN', command: 'not executed', observation: 'Model said not run.', negative_control: 'none', evidence_ids: [buildId] }] };
  const result = applyControllerRuntimeResults(model, registry, { scenario: 'web-proof' });
  assert.equal(result.report.runtime_status, 'PASS');
  assert.equal(result.report.runtime_evidence[0].status, 'PASS');
  assert.equal(model.runtime_status, 'NOT RUN');
  assert.ok(result.contradictions.some(item => item.model_status === 'NOT RUN' && item.controller_status === 'PASS'));
  assert.match(result.report.unverified.at(-1), /failed attempt/);
});

test('source records, imports, and wrong patch identity cannot produce runtime PASS', () => {
  const registry = createEvidenceRegistry({ source: 'fixture', commit: 'trusted-commit', scenario: 'web-proof', requiredChecks: ['browser_smoke'] });
  captureEvidence(registry, { type: 'source', content: 'browser passed' });
  captureEvidence(registry, { type: 'external_unverified', content: { page_errors: [] }, execution_verified: true, outcome: 'passed' });
  captureEvidence(registry, { type: 'runner_execution', operation: 'browser_smoke', patch_hash: 'sha256:right', execution_verified: true, outcome: 'passed', exit_code: 0, ui_passed: true });
  const result = applyControllerRuntimeResults({ ...baseReport, runtime_status: 'PASS', runtime_evidence: [] }, registry, { scenario: 'web-proof', patchHash: 'sha256:wrong' });
  assert.equal(result.report.runtime_status, 'NOT RUN');
  assert.equal(result.eligible_evidence_ids.length, 0);
  assert.ok(result.contradictions.length > 0);
});
