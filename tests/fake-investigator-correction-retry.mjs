import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
const schema = args[args.indexOf('--output-schema') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
const ids = [...prompt.matchAll(/ev-[a-f0-9]{16}/g)].map(match => match[0]);

if (schema.endsWith('investigation-request.schema.json')) {
  const round = Number((output.match(/investigation-(\d+)/) ?? [])[1] ?? 0);
  if (round === 1) {
    writeFileSync(output, JSON.stringify({ action: 'request', rationale: 'Run the approved build check first.', requests: [{ type: 'experiment', query: null, paths: null, evidence_ids: null, experiment: 'build', reason: 'Need the build result.', patch: null, continuation: null, ranges: null }] }));
  } else if (round === 2) {
    writeFileSync(output, JSON.stringify({ action: 'request', rationale: 'Verify the proposed correction.', requests: [{ type: 'correction_verification', query: null, paths: null, evidence_ids: null, experiment: null, reason: 'Apply the correction.', patch: '--- a/app.mjs\n+++ b/app.mjs\n@@\n-old\n+new', continuation: null, ranges: null }] }));
  } else if (round === 3 && prompt.includes('controller rejected the proposed correction')) {
    writeFileSync(output, JSON.stringify({ action: 'request', rationale: 'Retry with a valid bounded correction.', requests: [{ type: 'correction_verification', query: null, paths: null, evidence_ids: null, experiment: null, reason: 'Verify the corrected source.', patch: "diff --git a/app.mjs b/app.mjs\n--- a/app.mjs\n+++ b/app.mjs\n@@ -1,3 +1,3 @@\n-const face = 'system-ui';\n+const face = 'system-ui'; // verified correction\n if (face !== 'system-ui') process.exit(1);\n console.log('PASS: app starts');\n", continuation: null, ranges: null }] }));
  } else {
    writeFileSync(output, JSON.stringify({ action: 'final', rationale: 'The correction result is available.', requests: [] }));
  }
} else {
  const executionMatch = [...prompt.matchAll(/"evidence_id":\s*"(ev-[a-f0-9]{16})"[\s\S]{0,500}?"type":\s*"(?:runner_execution|executed_command|browser_execution)"/g)].at(-1);
  const evidenceId = executionMatch?.[1] ?? ids.at(-1);
  writeFileSync(output, JSON.stringify({
    project: 'model-project', commit: 'model-commit', verdict: 'CONTINUE', executive_summary: 'The explicitly requested correction passed the controller checks.',
    runtime_status: 'PASS', runtime_evidence: [{ check: 'build', status: 'PASS', command: 'node -e process.stdout.write("build")', observation: 'The approved disposable correction build passed.', negative_control: 'The baseline was separately executed before correction verification.', evidence_ids: [evidenceId] }],
    findings: [{ title: 'Correction verified', severity: 'INFO', evidence_type: 'OBSERVED', evidence: 'The controller recorded a successful correction verification.', location: 'app.mjs:1', recommended_fix: 'Retain the verified correction.', evidence_ids: [evidenceId] }],
    proposed_patch: null, reuse_assessment: [], commercial_risks: [], unverified: [], next_actions: [],
  }));
}
