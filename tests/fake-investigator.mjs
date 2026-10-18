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
    ? { action: 'request', rationale: 'The entry point needs direct confirmation.', requests: [{ type: 'source_read', query: null, paths: ['app.mjs'], evidence_ids: null, experiment: null, reason: null, continuation: null, ranges: null }] }
    : { action: 'final', rationale: 'The bounded source evidence is sufficient.', requests: [] }));
} else {
  if (ids.length === 0) throw new Error('No controller evidence ID was supplied');
  writeFileSync(output, JSON.stringify({
    project: 'fake', commit: 'model-commit', verdict: 'CONTINUE', technical_verdict: 'CONTINUE', viability_assessment:{project_type:'UNKNOWN',status:'PLAUSIBLE',problem:'Fixture only.',beneficiary:'Fixture test',evidence_for_value:[],evidence_against_value:[],substitutes:[],unique_value:'Fixture only.',proof_gap:'No value assessment.',strongest_stop_case:'Fixture only.',strongest_continue_case:'Fixture only.',would_start_today:'UNKNOWN',next_validation:null,override:null}, executive_summary: 'Investigation completed.',
    runtime_status: 'NOT RUN', runtime_evidence: [],
    findings: [{ id:'F-001', title: 'Observed source', severity: 'INFO', evidence_type: 'OBSERVED', evidence: 'The source was retrieved by the controller.', location: 'app.mjs:1', recommended_fix: 'None.', materiality:'INFORMATIONAL', invariant:'The source is retrievable.', consequence:'None established.', smallest_correction:'None.', evidence_ids: [ids[0]] }],
    product_assessment:{purpose_fit:'Fixture',strengths:[],opportunities:[],reuse_or_simplify:[]},
    complexity_assessment:{status:'CLEAR',summary:'No additional architecture is evidenced.',items:[]},
    decision_control:{gate_context:{current_gate:null,gate_question:null,pass_criteria:[]},evidence_ceiling:'SOURCE_REVIEW_STILL_USEFUL',audit_loop_risk:'UNKNOWN',blocking_finding_ids:[],deferred_finding_ids:[],primary_next_action:{title:'Review the report.',substeps:[]}},
    proposed_patch: 'diff --git a/app.mjs b/app.mjs\n--- a/app.mjs\n+++ b/app.mjs\n@@ -1 +1 @@\n-export const app = true;\n+export const app = true;',
    reuse_assessment: [], commercial_risks: [], unverified: ['Runtime not run.'], next_actions: [],
  }));
}
