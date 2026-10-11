import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function run(bin,args,opts={}){return spawnSync(bin,args,{encoding:'utf8',...opts});}

test('does not forward an unrelated parent environment secret to Codex',()=>{
  const tmp=mkdtempSync(join(project,'auditor-environment-test-'));
  try {
    const source=join(tmp,'source');
    cpSync(join(project,'fixtures','clean-repo'),source,{recursive:true});
    assert.equal(run('git',['init','-q',source]).status,0);
    assert.equal(run('git',['-C',source,'add','.']).status,0);
    assert.equal(run('git',['-C',source,'-c','user.email=test@example.com','-c','user.name=test','commit','-qm','fixture']).status,0);
    const out=join(tmp,'report');
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--mode','inspect','--out',out],{env:{...process.env,TAKAVEN_TEST_SECRET:'do-not-forward',TAKAVEN_CODEX_BIN:join(project,'tests','env-probe-codex.mjs'),TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
    assert.equal(report.executive_summary,'secret-absent');
  } finally {rmSync(tmp,{recursive:true,force:true});}
});
