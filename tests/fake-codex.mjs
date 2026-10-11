#!/usr/bin/env node
// Contract-test stub. Never contacts a model. Writes a synthetic report for wrapper testing only.
import { writeFileSync } from 'node:fs';
const args=process.argv.slice(2);
const path=args[args.indexOf('-o')+1];
let prompt=''; for await(const chunk of process.stdin) prompt+=chunk.toString();
if(!prompt.includes('Current audit target')) process.exit(12);
const report={project:'fixture',commit:'fake-model-commit',verdict:'INCONCLUSIVE',executive_summary:'Synthetic output from contract test. Not a real audit.',runtime_status:'NOT RUN',runtime_evidence:[],findings:[],reuse_assessment:[],commercial_risks:[],unverified:['No model run'],next_actions:['Run with authenticated Codex']};
writeFileSync(path,JSON.stringify(report));
