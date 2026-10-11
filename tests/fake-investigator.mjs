import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
const schema = args[args.indexOf('--output-schema') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
const ids = [...prompt.matchAll(/ev-[a-f0-9]{16}/g)].map(match => match[0]);
if (schema.endsWith('investigation-request.schema.json')) {
  const round = output.includes('investigation-1') ? 'request' : 'final';
  writeFileSync(output, JSON.stringify(round === 'request'
    ? { action: 'request', rationale: 'The entry point needs direct confirmation.', requests: [{ type: 'source_read', paths: ['app.mjs'] }] }
    : { action: 'final', rationale: 'The bounded source evidence is sufficient.', requests: [] }));
} else {
  if (ids.length === 0) throw new Error('No controller evidence ID was supplied');
  writeFileSync(output, JSON.stringify({
    project: 'fake', commit: 'model-commit', verdict: 'CONTINUE', executive_summary: 'Investigation completed.',
    runtime_status: 'NOT RUN', runtime_evidence: [],
    findings: [{ title: 'Observed source', severity: 'INFO', evidence_type: 'OBSERVED', evidence: 'The source was retrieved by the controller.', location: 'app.mjs:1', recommended_fix: 'None.', evidence_ids: [ids[0]] }],
    proposed_patch: '--- a/app.mjs\n+++ b/app.mjs\n@@\n-export const app = true;\n+export const app = true;',
    reuse_assessment: [], commercial_risks: [], unverified: ['Runtime not run.'], next_actions: [],
  }));
}
