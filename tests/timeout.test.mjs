import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function run(bin,args,opts={}){return spawnSync(bin,args,{encoding:'utf8',...opts});}

test('terminates a hung Codex process before the deadline',()=>{
  const tmp=mkdtempSync(join(project,'auditor-timeout-test-'));
  try {
    const source=join(tmp,'source');
    cpSync(join(project,'fixtures','clean-repo'),source,{recursive:true});
    assert.equal(run('git',['init','-q',source]).status,0);
    assert.equal(run('git',['-C',source,'add','.']).status,0);
    assert.equal(run('git',['-C',source,'-c','user.email=test@example.com','-c','user.name=test','commit','-qm','fixture']).status,0);
    const result=run(process.execPath,[join(project,'src','audit.mjs'),'--path',source,'--mode','inspect','--out',join(tmp,'report')],{env:{...process.env,TAKAVEN_CODEX_BIN:join(project,'tests','slow-codex.mjs'),TAKAVEN_CODEX_TIMEOUT_MS:'100',TAKAVEN_SCRATCH_ROOT:join(tmp,'scratch')}});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/timed out after 100ms/);
    assert.match(result.stderr,/Temporary checkout removed/);
  } finally {rmSync(tmp,{recursive:true,force:true});}
});
