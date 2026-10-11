import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync } from 'node:fs';
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
  return source;
}

function fullFlowScenario(){
  const tmp=makeTemp('auditor-wrapper-test');
  try{
    const source=initFixture(tmp);
    const out=join(tmp,'report');
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--mode','inspect','--out',out],{env:{...process.env,TAKAVEN_CODEX_BIN:join(project,'tests','fake-codex.mjs'),TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.equal(result.status,0, result.stderr);
    assert.equal(existsSync(join(out,'report.md')),true);
    assert.match(readFileSync(join(out,'report.md'),'utf8'),/Synthetic output from contract test/);
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
    assert.equal(report.project,'source');
    assert.notEqual(report.commit,'fake-model-commit');
    assert.equal(report.audit_mode,'inspect');
    assert.equal(existsSync(join(source,'report.md')),false);
    const sourceLog=run('git',['-C',source,'status','--porcelain']);
    assert.equal(sourceLog.stdout.trim(),'');
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

test('controller integration scenarios', { concurrency: false }, () => {
  fullFlowScenario();
  reportGuardScenario();
});
