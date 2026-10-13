import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
const schema = args[args.indexOf('--output-schema') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
const ids = [...prompt.matchAll(/ev-[a-f0-9]{16}/g)].map(match => match[0]);
const evidenceId = ids[0];

if (schema.endsWith('investigation-request.schema.json')) {
  const round = output.includes('investigation-1');
  writeFileSync(output, JSON.stringify(round
    ? { action: 'request', rationale: 'Read the entry point before finalising.', requests: [{ type: 'source_read', query: null, paths: ['app.mjs'], evidence_ids: null, experiment: null, reason: null, patch: null, continuation: null, ranges: null }] }
    : { action: 'final', rationale: 'The bounded evidence is sufficient.', requests: [] }));
} else {
  const retry = prompt.includes('proposed_patch field failed validation');
  writeFileSync(output, JSON.stringify({
    project: 'fake', commit: 'model-commit', verdict: 'MODIFY', executive_summary: 'The controller retained the invalid correction attempt and requested a bounded retry.',
    runtime_status: 'NOT RUN', runtime_evidence: [],
    findings: [{ title: 'Observed source', severity: 'INFO', evidence_type: 'OBSERVED', evidence: 'The source was retrieved by the controller.', location: 'app.mjs:1', recommended_fix: 'None.', evidence_ids: [evidenceId] }],
    proposed_patch: retry ? null : '--- a/app.mjs\n+++ b/app.mjs\n@@\n-old\n+new',
    reuse_assessment: [], commercial_risks: [],
    unverified: [retry ? 'Correction remains unverified.' : 'The first correction proposal was malformed.'],
    next_actions: [],
  }));
}
