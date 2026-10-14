import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function run(bin,args,opts={}){return spawnSync(bin,args,{encoding:'utf8',...opts});}
function makeTemp(prefix){return mkdtempSync(join(project,`${prefix}-`));}
function initFixture(tmp){
  const source=join(tmp,'source');
  cpSync(join(project,'fixtures','clean-repo'),source,{recursive:true});
  assert.equal(run('git',['init','-q',source]).status,0);
  assert.equal(run('git',['-C',source,'add','.']).status,0);
  assert.equal(run('git',['-C',source,'-c','user.email=test@example.com','-c','user.name=test','commit','-qm','fixture']).status,0);
  assert.equal(run('git',['-C',source,'branch','-M','main']).status,0);
  return source;
}

function fullFlowScenario(){
  const tmp=makeTemp('auditor-wrapper-test');
  try{
    const source=initFixture(tmp);
    const brief=join(tmp,'brief.json');
    writeFileSync(brief,JSON.stringify({purpose:'Fixture product.',intended_users:['Testers'],major_workflows:['Review'],business_objectives:['Evidence'],constraints:['Read only']}));
    const out=join(tmp,'report');
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--ref','main','--brief',brief,'--brief-provenance','repository-derived','--mode','inspect','--out',out],{env:{...process.env,TAKAVEN_CODEX_BIN:join(project,'tests','fake-codex.mjs'),TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.equal(result.status,0, result.stderr);
    assert.equal(existsSync(join(out,'report.md')),true);
    assert.match(readFileSync(join(out,'report.md'),'utf8'),/Synthetic output from contract test/);
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
    assert.equal(report.project,'source');
    assert.notEqual(report.commit,'fake-model-commit');
    assert.equal(report.audit_mode,'inspect');
    const metadata=JSON.parse(readFileSync(join(out,'audit-metadata.json'),'utf8'));
    assert.equal(metadata.brief_provenance,'repository-derived');
    const evidence=JSON.parse(readFileSync(join(out,'evidence-registry.json'),'utf8'));
    assert.equal(evidence.registry.brief_provenance,'repository-derived');
    assert.equal(existsSync(join(source,'report.md')),false);
    const sourceLog=run('git',['-C',source,'status','--porcelain']);
    assert.equal(sourceLog.stdout.trim(),'');
  } finally {rmSync(tmp,{recursive:true,force:true});}
}

function dirtyWorkingTreeScenario(){
  const tmp=makeTemp('auditor-dirty-tree-test');
  try{
    const source=initFixture(tmp);
    writeFileSync(join(source,'local-only.txt'),'uncommitted\n');
    const out=join(tmp,'report');
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--mode','inspect','--out',out],{env:{...process.env,TAKAVEN_CODEX_BIN:join(project,'tests','fake-codex.mjs'),TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
    assert.equal(report.coverage.working_tree.uncommitted_changes_excluded,true);
    assert.equal(report.coverage.working_tree.uncommitted_change_count,1);
    assert.match(readFileSync(join(out,'report.md'),'utf8'),/WARNING: Local uncommitted changes were excluded/);
  } finally {rmSync(tmp,{recursive:true,force:true});}
}

function reportGuardScenario(){
  const tmp=makeTemp('auditor-guard-test');
  try {
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',tmp,'--out',join(tmp,'reports')]);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/outside the original project/);
  }finally{rmSync(tmp,{recursive:true,force:true});}
}

function investigationScenario(){
  const tmp=makeTemp('auditor-investigation-test');
  try{
    const source=initFixture(tmp);
    const out=join(tmp,'report');
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--mode','inspect','--investigate','--out',out],{env:{...process.env,TAKAVEN_CODEX_BIN:join(project,'tests','fake-investigator.mjs'),TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
    assert.equal(report.findings[0].evidence_ids.length,1);
    assert.equal(report.coverage.follow_up_read_files.includes('app.mjs'),true);
    assert.equal(report.coverage.bytes_examined > report.coverage.initial_bytes_examined,true);
    const evidence=JSON.parse(readFileSync(join(out,'evidence-registry.json'),'utf8'));
    assert.equal(evidence.investigation.length >= 1,true);
    assert.equal(evidence.registry.records.some(record=>record.type==='source' && record.action==='source_read'),true);
  } finally {rmSync(tmp,{recursive:true,force:true});}
}

function malformedFinalPatchScenario(){
  const tmp=makeTemp('auditor-malformed-final-patch-test');
  try{
    const source=initFixture(tmp);
    const out=join(tmp,'report');
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--mode','inspect','--investigate','--out',out],{env:{...process.env,TAKAVEN_CODEX_BIN:join(project,'tests','fake-investigator-malformed-report.mjs'),TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
    assert.equal(report.proposed_patch,null);
    assert.match(report.unverified.at(-1),/Correction remains unverified/);
    const evidence=JSON.parse(readFileSync(join(out,'evidence-registry.json'),'utf8'));
    assert.equal(evidence.registry.records.some(record=>record.type==='model_report' && record.outcome==='failed_validation'),true);
    assert.equal(evidence.registry.records.some(record=>record.type==='controller_validation' && record.outcome==='retry_requested'),true);
  } finally {rmSync(tmp,{recursive:true,force:true});}
}

function malformedCorrectionRetryScenario(){
  const tmp=makeTemp('auditor-malformed-correction-retry-test');
  try{
    const source=initFixture(tmp);
    const config=join(tmp,'runner.json');
    writeFileSync(config, JSON.stringify({version:1,scenario:'correction-retry',required_checks:['build'],build:{command:['node','-e','process.stdout.write("build")']}}));
    const out=join(tmp,'report');
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--mode','verify','--investigate','--runner-config',config,'--out',out],{env:{...process.env,TAKAVEN_CODEX_BIN:join(project,'tests','fake-investigator-correction-retry.mjs'),TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
    assert.equal(report.runtime_status,'PASS');
    const evidence=JSON.parse(readFileSync(join(out,'evidence-registry.json'),'utf8'));
    assert.equal(evidence.registry.records.some(record=>record.type==='model_request' && record.outcome==='failed_validation'),true);
    assert.equal(evidence.registry.records.some(record=>record.type==='controller_validation' && record.action==='policy_gate' && record.outcome==='rejected'),true);
    assert.equal(evidence.registry.records.some(record=>record.type==='runner_execution' && record.operation==='correction_verification'),false);
    assert.equal(run('git',['-C',source,'status','--porcelain']).stdout.trim(),'');
  } finally {rmSync(tmp,{recursive:true,force:true});}
}

function executionHandoffScenario(){
  const tmp=makeTemp('auditor-execution-handoff-test');
  try{
    const source=initFixture(tmp);
    const config=join(tmp,'runner.json');
    writeFileSync(config, JSON.stringify({version:1,scenario:'fixture-build',required_checks:['build'],build:{command:['node','-e','process.stdout.write("controller-build")']}}));
    const out=join(tmp,'report');
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--mode','verify','--investigate','--runner-config',config,'--out',out],{env:{...process.env,TAKAVEN_CODEX_BIN:join(project,'tests','fake-investigator-execution.mjs'),TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
    assert.equal(report.runtime_status,'PASS');
    assert.equal(report.runtime_evidence[0].status,'PASS');
    assert.match(report.unverified.at(-1),/failed attempt/);
    const evidence=JSON.parse(readFileSync(join(out,'evidence-registry.json'),'utf8'));
    assert.equal(evidence.registry.records.some(record=>record.type==='runner_execution' && record.outcome==='passed'),true);
    assert.equal(evidence.registry.records.some(record=>record.type==='model_runtime_contradiction' && record.outcome==='failed_attempt'),true);
  } finally {rmSync(tmp,{recursive:true,force:true});}
}

function browserAcceptanceHandoffScenario(){
  const tmp=makeTemp('auditor-browser-handoff-test');
  try{
    const source=initFixture(tmp);
    const browserScript=join(source,'browser-check.mjs');
    writeFileSync(browserScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.TAKAVEN_BROWSER_ASSERTION_PATH, JSON.stringify({ version: 1, execution_id: process.env.TAKAVEN_BROWSER_EXECUTION_ID, ui_passed: true }));\n`);
    const config=join(tmp,'runner.json');
    writeFileSync(config, JSON.stringify({version:1,scenario:'fixture-browser',required_checks:['browser_smoke'],browser_smoke:{command:['node',browserScript],assertion:{path:'.controller/ui-assertion.json'}}}));
    const out=join(tmp,'report');
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--mode','verify','--investigate','--runner-config',config,'--out',out],{env:{...process.env,TAKAVEN_CODEX_BIN:join(project,'tests','fake-investigator-browser.mjs'),TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
    assert.equal(report.runtime_status,'PASS');
    assert.equal(report.runtime_evidence[0].check,'browser_smoke');
    assert.equal(report.runtime_evidence[0].status,'PASS');
    const evidence=JSON.parse(readFileSync(join(out,'evidence-registry.json'),'utf8'));
    const browserRecord=evidence.registry.records.find(record=>record.operation==='browser_smoke');
    assert.equal(browserRecord.assertion_status,'valid');
    assert.equal(browserRecord.ui_passed,true);
    assert.equal(typeof browserRecord.assertion_hash,'string');
  } finally {rmSync(tmp,{recursive:true,force:true});}
}

function omittedAcceptanceCheckScenario(){
  const tmp=makeTemp('auditor-omitted-check-test');
  try{
    const source=initFixture(tmp);
    const config=join(tmp,'runner.json');
    writeFileSync(config, JSON.stringify({version:1,scenario:'fixture-checks',build:{command:['node','-e','process.stdout.write("controller-build")']},declared_test:{command:['node','-e','process.stdout.write("controller-test")']}}));
    const out=join(tmp,'report');
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--mode','verify','--investigate','--runner-config',config,'--out',out],{env:{...process.env,TAKAVEN_CODEX_BIN:join(project,'tests','fake-investigator-execution.mjs'),TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
    assert.equal(report.runtime_status,'PARTIAL');
    assert.equal(report.verdict,'INCONCLUSIVE');
    assert.equal(report.runtime_evidence.find(entry=>entry.check==='declared_test').status,'NOT RUN');
  } finally {rmSync(tmp,{recursive:true,force:true});}
}

test('controller integration scenarios', { concurrency: false }, () => {
  fullFlowScenario();
  dirtyWorkingTreeScenario();
  reportGuardScenario();
  investigationScenario();
  malformedFinalPatchScenario();
  malformedCorrectionRetryScenario();
  executionHandoffScenario();
  browserAcceptanceHandoffScenario();
  omittedAcceptanceCheckScenario();
});
