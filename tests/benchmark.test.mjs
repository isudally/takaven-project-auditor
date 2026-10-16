import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKnownAnswer } from '../benchmarks/evaluate-known-answer.mjs';

const manifest = {
  expected: [{
    id: 'KA-001', path: 'src/flows/account-setup.mjs', class: 'defect',
    finding_keywords: ['checklist', 'partial', 'success'],
    evidence_keywords: ['assigndefaults', 'ok: true'],
    reject_keywords: ['always assigned'],
  }],
  clean_controls: [{ id: 'CLEAN-001', path: 'src/controls/healthy.mjs', forbidden_keywords: ['broken'] }],
};

function evidence(records) { return { registry: { records } }; }
function source(id, location, content) { return { evidence_id: id, type: 'source', action: 'source_read', outcome: 'retrieved', location, content }; }

test('known-answer evaluator requires supported source evidence, not path and keywords alone', () => {
  const report = { verdict: 'MODIFY', findings: [{ id: 'F-001', evidence_ids: ['ev-1'], title: 'Checklist partial success risk', evidence: 'The checklist partial success is always assigned.' }] };
  const output = evaluateKnownAnswer({ report, evidence: evidence([source('ev-1', 'src/flows/account-setup.mjs', 'return { ok: true };')]), manifest });
  assert.deepEqual(output.missed, ['KA-001']);
  assert.deepEqual(output.unsupported_candidate_findings, ['F-001']);
  assert.deepEqual(output.findings_without_eligible_source_evidence, []);
});

test('known-answer evaluator credits a finding only when evidence and claim predicates agree', () => {
  const report = { verdict: 'MODIFY', findings: [{ id: 'F-001', evidence_ids: ['ev-1'], title: 'Partial checklist failure can be reported as success', evidence: 'assignDefaults can fail while ok: true is returned.' }] };
  const output = evaluateKnownAnswer({ report, evidence: evidence([source('ev-1', 'src/flows/account-setup.mjs', 'await db.checklists.assignDefaults(id); return { ok: true };')]), manifest });
  assert.equal(output.discovered, 1);
  assert.deepEqual(output.unsupported_candidate_findings, []);
});

test('clean controls expose findings that cite healthy code as broken', () => {
  const report = { verdict: 'MODIFY', findings: [{ id: 'F-002', evidence_ids: ['ev-2'], title: 'Healthy control is broken', evidence: 'broken workflow' }] };
  const output = evaluateKnownAnswer({ report, evidence: evidence([source('ev-2', 'src/controls/healthy.mjs', 'return Boolean(record && record.id);')]), manifest });
  assert.deepEqual(output.clean_control_false_positives, [{ control: 'CLEAN-001', finding_id: 'F-002' }]);
});
