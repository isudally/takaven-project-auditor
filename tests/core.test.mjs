import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, normalizeGithub, validateReport, renderMarkdown, promptForRun, applyTrustedMetadata } from '../src/core.mjs';

const sample = {project:'demo',commit:'123',verdict:'MODIFY',executive_summary:'Build is broken.',runtime_status:'FAIL',runtime_evidence:[{check:'web boot',status:'FAIL',command:'npm test',observation:'TypeError',negative_control:'not required'}],findings:[{title:'Boot fails',severity:'HIGH',evidence_type:'OBSERVED',evidence:'startup exception',location:'src/app.js:10',recommended_fix:'fix token'}],reuse_assessment:['reuse templates'],commercial_risks:['no buyer evidence'],unverified:['sales'],next_actions:['fix boot']};

test('requires one repo source',()=> {assert.throws(()=>parseArgs([]),/exactly one/);assert.throws(()=>parseArgs(['--repo','https://github.com/a/b','--path','.']),/exactly one/);});
test('supports exact HTTPS github repo',()=>assert.equal(normalizeGithub('https://github.com/isudally/playkin'), 'https://github.com/isudally/playkin.git'));
test('rejects credentials, unexpected domains and extra GitHub paths',()=>{for(const url of ['https://evil.com/a/b','https://u:p@github.com/a/b','https://github.com/a/b/tree/main','http://github.com/a/b','https://github.com/a/b?x=1']) assert.throws(()=>normalizeGithub(url));});
test('modes limited to inspect and verify',()=>{assert.equal(parseArgs(['--repo','https://github.com/a/b']).mode,'inspect');assert.throws(()=>parseArgs(['--repo','https://github.com/a/b','--mode','danger']),/must be/);});
test('validates required report contract',()=>{assert.equal(validateReport(sample).verdict,'MODIFY');assert.throws(()=>validateReport({...sample,runtime_evidence:undefined}),/must be an array/);});
test('rejects unsupported runtime success claims',()=>{
  const unsupported={...sample,runtime_status:'PASS',runtime_evidence:[]};
  assert.throws(()=>validateReport(unsupported),/Runtime PASS requires/);
  assert.throws(()=>validateReport({...sample,runtime_status:'PASS'},{mode:'inspect'}),/Runtime PASS requires/);
  assert.throws(()=>validateReport({...sample,runtime_status:'FAIL',runtime_evidence:[{...sample.runtime_evidence[0],status:'NOT RUN'}]}),/Runtime FAIL requires/);
});
test('rejects malformed nested evidence while preserving static findings',()=>{
  assert.throws(()=>validateReport({...sample,runtime_evidence:[{check:'x',status:'FAIL',command:'x',observation:'x'}]}),/negative_control/);
  const staticReport={...sample,runtime_status:'NOT RUN',runtime_evidence:[],findings:[{...sample.findings[0],evidence_type:'OBSERVED'}]};
  assert.equal(validateReport(staticReport,{mode:'inspect'}).findings[0].evidence_type,'OBSERVED');
});
test('controller metadata overrides model identity',()=>{
  const result=applyTrustedMetadata(sample,{project:'trusted',commit:'abc123',mode:'inspect',source:'repo',auditedAt:'2026-10-11T00:00:00.000Z'});
  assert.deepEqual({project:result.project,commit:result.commit,audit_mode:result.audit_mode},{project:'trusted',commit:'abc123',audit_mode:'inspect'});
});
test('renders findings, evidence, and unknowns',()=>{const md=renderMarkdown(sample,{source:'repo',mode:'inspect',timestamp:'2026-10-11'}); assert.match(md,/TypeError/);assert.match(md,/Not verified/);assert.match(md,/no buyer evidence/);});
test('inspect prompt never permits runtime',()=>assert.match(promptForRun({projectName:'x',commit:'abc',mode:'inspect',contract:'RULES',mission:'TASK'}),/Do not run repository scripts/));
test('prompt treats target instructions as untrusted evidence',()=>assert.match(promptForRun({projectName:'x',commit:'abc',mode:'inspect',contract:'RULES',mission:'TASK',targetPath:'target'}),/untrusted evidence/));
test('prompt includes controller snapshot as untrusted source evidence',()=>{
  const prompt=promptForRun({projectName:'x',commit:'abc',mode:'inspect',contract:'RULES',mission:'TASK',snapshot:'--- app.mjs ---\nsecret=<REDACTED>'});
  assert.match(prompt,/Controller-provided repository snapshot/);
  assert.match(prompt,/secret=<REDACTED>/);
  assert.match(prompt,/use this snapshot instead of shell commands/);
  assert.match(prompt,/Do not turn a title, README aspiration/);
});
test('verify prompt confines work to disposable clone',()=>assert.match(promptForRun({projectName:'x',commit:'abc',mode:'verify',contract:'RULES',mission:'TASK'}),/DISPOSABLE CLONE ONLY/));
