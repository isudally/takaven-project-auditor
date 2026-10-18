import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();

const retryRequested = prompt.includes('during semantic validation');
const mode = process.cwd().includes('retry-fail') ? 'retry-fail' : process.cwd().includes('retry-success') ? 'retry-success' : 'valid-first';
const invalid = mode === 'retry-success' ? !retryRequested : mode === 'retry-fail';
const report = {
  project: 'model-project', commit: 'model-commit', verdict: 'INCONCLUSIVE', technical_verdict: 'INCONCLUSIVE',
  viability_assessment: {project_type:'UNKNOWN',status:'PLAUSIBLE',problem:'Fixture only.',beneficiary:'Fixture test',evidence_for_value:[],evidence_against_value:[],substitutes:[],unique_value:'Fixture only.',proof_gap:'No value assessment.',strongest_stop_case:'Fixture only.',strongest_continue_case:'Fixture only.',would_start_today:'UNKNOWN',next_validation:null,override:null},
  executive_summary: 'Semantic retry contract fixture.', runtime_status: 'NOT RUN', runtime_evidence: [], findings: [],
  product_assessment: { purpose_fit: 'UNKNOWN', strengths: [], opportunities: [], reuse_or_simplify: [] },
  complexity_assessment: { status: 'UNKNOWN', summary: 'No runtime was requested.', items: [] },
  decision_control: {
    gate_context: { current_gate: null, gate_question: null, pass_criteria: [] },
    evidence_ceiling: 'UNKNOWN', audit_loop_risk: invalid ? 'HIGH' : 'UNKNOWN',
    blocking_finding_ids: [], deferred_finding_ids: [], primary_next_action: { title: 'Review the source evidence.', substeps: [] },
  },
  reuse_assessment: [], commercial_risks: [], unverified: ['Fixture output only.'], next_actions: [], proposed_patch: null,
};
writeFileSync(output, JSON.stringify(report));
