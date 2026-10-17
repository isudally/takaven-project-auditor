import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
const schema = args[args.indexOf('--output-schema') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
const ids = [...prompt.matchAll(/ev-[a-f0-9]{16}/g)].map(match => match[0]);

if (schema.endsWith('investigation-request.schema.json')) {
  const request = output.includes('investigation-1');
  writeFileSync(output, JSON.stringify(request
    ? { action: 'request', rationale: 'The browser check is needed to validate the configured UI behavior.', requests: [{ type: 'experiment', query: null, paths: null, evidence_ids: null, experiment: 'browser_smoke', reason: 'Need the controller-bound browser assertion.', continuation: null, ranges: null }] }
    : { action: 'final', rationale: 'The controller browser result is available.', requests: [] }));
} else {
  writeFileSync(output, JSON.stringify({
    project: 'model-project', commit: 'model-commit', verdict: 'CONTINUE', executive_summary: 'The model report is reconciled against controller browser evidence.',
    runtime_status: 'PASS', runtime_evidence: [],
    findings: [], product_assessment:{purpose_fit:'Fixture',strengths:[],opportunities:[],reuse_or_simplify:[]}, complexity_assessment:{status:'CLEAR',summary:'No additional architecture is evidenced.',items:[]}, decision_control:{gate_context:{current_gate:null,gate_question:null,pass_criteria:[]},evidence_ceiling:'MOVE_TO_CONTROLLED_RUNTIME',audit_loop_risk:'UNKNOWN',blocking_finding_ids:[],deferred_finding_ids:[],primary_next_action:{title:'Review the browser assertion.',substeps:[]}}, proposed_patch: null, reuse_assessment: [], commercial_risks: [], unverified: [], next_actions: [],
  }));
}
