import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
const report = {
  project: 'model-project', commit: 'model-commit', verdict: 'INCONCLUSIVE',
  executive_summary: 'Semantic retry failure fixture.', runtime_status: 'NOT RUN', runtime_evidence: [], findings: [],
  product_assessment: { purpose_fit: 'UNKNOWN', strengths: [], opportunities: [], reuse_or_simplify: [] },
  complexity_assessment: { status: 'UNKNOWN', summary: 'No runtime was requested.', items: [] },
  decision_control: {
    gate_context: { current_gate: null, gate_question: null, pass_criteria: [] }, evidence_ceiling: 'UNKNOWN', audit_loop_risk: 'HIGH',
    blocking_finding_ids: [], deferred_finding_ids: [], primary_next_action: { title: 'Review the source evidence.', substeps: [] },
  },
  reuse_assessment: [], commercial_risks: [], unverified: ['Fixture output only.'], next_actions: [], proposed_patch: null,
};
void prompt;
writeFileSync(output, JSON.stringify(report));
