#!/usr/bin/env node
// Trusted lifecycle-test helper. It reports whether a deliberately excluded
// parent environment variable reached the model process.
import { writeFileSync } from 'node:fs';

const args=process.argv.slice(2);
const output=args[args.indexOf('-o')+1];
let prompt='';
for await (const chunk of process.stdin) prompt+=chunk.toString();
if (!prompt.includes('Current audit target')) process.exit(12);
const report={
  project:'fixture',
  commit:'fake-model-commit',
  verdict:'INCONCLUSIVE',
  technical_verdict:'INCONCLUSIVE',
  viability_assessment:{project_type:'UNKNOWN',status:'UNKNOWN',problem:'Fixture only.',beneficiary:'Fixture test',evidence_for_value:[],evidence_against_value:[],substitutes:[],unique_value:'Fixture only.',proof_gap:'No value assessment.',strongest_stop_case:'Fixture only.',strongest_continue_case:'Fixture only.',would_start_today:'UNKNOWN',next_validation:{title:'Run the real engine',substeps:[]},override:null},
  executive_summary:process.env.TAKAVEN_TEST_SECRET ? 'secret-present' : 'secret-absent',
  runtime_status:'NOT RUN',
  runtime_evidence:[],
  findings:[],
  product_assessment:{purpose_fit:'UNKNOWN',strengths:[],opportunities:[],reuse_or_simplify:[]},
  complexity_assessment:{status:'UNKNOWN',summary:'Environment probe only.',items:[]},
  decision_control:{gate_context:{current_gate:null,gate_question:null,pass_criteria:[]},evidence_ceiling:'UNKNOWN',audit_loop_risk:'UNKNOWN',blocking_finding_ids:[],deferred_finding_ids:[],primary_next_action:{title:'Run the real engine',substeps:[]}},
  reuse_assessment:[],
  commercial_risks:[],
  unverified:['Environment probe only'],
  next_actions:[]
};
writeFileSync(output,JSON.stringify(report));
