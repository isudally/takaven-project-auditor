import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseArgs } from '../src/core.mjs';
import { createEvidenceRegistry, deriveRuntimeEvidenceStatus, isEligibleFindingEvidence, isEligibleRuntimeEvidence } from '../src/evidence.mjs';
import { KNIP_VERSION, NPM_CI_TIMEOUT_MS, runKnip, summarizeKnipFindings } from '../src/knip.mjs';
import { applyControllerRuntimeResults } from '../src/runtime.mjs';

const source = 'https://github.com/example/project.git';
const commit = 'a'.repeat(40);

function createFixture({ lock = true, npmrc = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'takaven-knip-test-'));
  const scratch = join(root, 'scratch');
  const checkout = join(root, 'repo');
  mkdirSync(scratch);
  mkdirSync(checkout);
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'npm@11.0.0' }));
  if (lock) writeFileSync(join(checkout, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' } } }));
  writeFileSync(join(checkout, 'index.mjs'), 'export const marker = true;\n');
  if (npmrc !== null) writeFileSync(join(checkout, '.npmrc'), npmrc);
  return { root, scratch, checkout, registry: createEvidenceRegistry({ source, commit }) };
}

function completedRunner({ output = { issues: [] }, exitCode = 0, version = KNIP_VERSION, installResult = null, ciResult = null, analysisResult = null, observed = [] } = {}) {
  return (file, args, options) => {
    observed.push({ file, args, options });
    const npmCommand = `${file} ${args.join(' ')}`;
    if (npmCommand.includes('npm.cmd') || file.toLowerCase() === 'npm') {
      if (options.cwd.endsWith('scratch')) {
        if (installResult) return installResult;
        const toolDir = join(options.cwd, 'knip-tool');
        const tool = join(toolDir, 'node_modules', 'knip');
        mkdirSync(join(tool, 'bin'), { recursive: true });
        writeFileSync(join(tool, 'package.json'), JSON.stringify({ version, bin: 'bin/knip.js' }));
        writeFileSync(join(tool, 'bin', 'knip.js'), '');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (ciResult) return ciResult;
      mkdirSync(join(options.cwd, 'node_modules'), { recursive: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (analysisResult) return analysisResult;
    return { status: exitCode, stdout: JSON.stringify(output), stderr: '' };
  };
}

function analyze(fixture, options = {}) {
  const run = options.run ?? completedRunner(options);
  return runKnip({ ...fixture, source, commit, trustedTarget: true, run, ...options });
}

test('Knip CLI requires explicit opt-in and explicit trusted-target acknowledgement', () => {
  assert.equal(parseArgs(['--path', '.', '--knip']).trustedTarget, undefined);
  assert.equal(parseArgs(['--path', '.', '--knip', '--trusted-target']).trustedTarget, true);
  assert.throws(() => parseArgs(['--path', '.', '--trusted-target']), /requires --knip/);
  assert.throws(() => parseArgs(['--path', '.', '--knip-synthetic-database-url']), /requires --knip --trusted-target/);
});

test('Knip requested without trusted-target records INCOMPLETE and executes nothing', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let calls = 0;
  const result = runKnip({ ...fixture, source, commit, run: () => { calls++; throw new Error('must not execute'); } });
  assert.equal(result.state, 'INCOMPLETE');
  assert.equal(calls, 0);
  assert.match(fixture.registry.records[0].reason, /UNTRUSTED_TARGET/);
});

test('missing lockfile is INCOMPLETE before tool or dependency execution', t => {
  const fixture = createFixture({ lock: false });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let calls = 0;
  const result = analyze(fixture, { run: () => { calls++; throw new Error('must not execute'); } });
  assert.equal(result.state, 'INCOMPLETE');
  assert.equal(calls, 0);
});

test('project npmrc is not inherited by dependency preparation', t => {
  const fixture = createFixture({ npmrc: 'always-auth=true\n' });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let calls = 0;
  const result = analyze(fixture, { run: () => { calls++; throw new Error('must not execute'); } });
  assert.equal(result.state, 'INCOMPLETE');
  assert.equal(calls, 0);
});

test('uses pinned Knip and exact lifecycle-disabled npm ci arguments', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const observed = [];
  const result = analyze(fixture, { observed, run: completedRunner({ observed }) });
  assert.equal(result.state, 'PASS_NO_FINDINGS');
  const commands = observed.map(call => call.args.join(' '));
  assert.ok(commands.some(command => command.includes(`knip@${KNIP_VERSION}`) && command.includes('--ignore-scripts')));
  assert.ok(commands.some(command => command.includes('ci --ignore-scripts --no-audit --no-fund')));
  assert.ok(observed.some(call => call.options.cwd === fixture.checkout && call.options.timeout === NPM_CI_TIMEOUT_MS));
  const npmEnv = observed[0].options.env;
  assert.notEqual(npmEnv.NPM_CONFIG_USERCONFIG, npmEnv.NPM_CONFIG_GLOBALCONFIG);
  assert.match(readFileSync(npmEnv.NPM_CONFIG_USERCONFIG, 'utf8'), /registry=https:\/\/registry\.npmjs\.org\//);
  assert.equal(readFileSync(npmEnv.NPM_CONFIG_GLOBALCONFIG, 'utf8').trim(), '');
});

test('exit zero with complete empty JSON is PASS_NO_FINDINGS', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(analyze(fixture).state, 'PASS_NO_FINDINGS');
});

test('exit one with valid structured findings is FINDINGS_PRESENT', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = analyze(fixture, { output: { issues: [{ file: 'package.json', dependencies: [{ name: 'unused-package' }], unlisted: [] }] }, exitCode: 1 });
  assert.equal(result.state, 'FINDINGS_PRESENT');
  assert.equal(result.finding_count, 1);
});

test('model receives bounded analyzer summary with undeclared dependencies prioritized', () => {
  const findings = [
    ...Array.from({ length: 60 }, (_, index) => ({ category: 'files', file: `src/${index}.ts`, name: `unused-${index}` })),
    { category: 'unlisted', file: 'package.json', name: 'server-only' },
  ];
  const summary = summarizeKnipFindings(findings);
  assert.equal(summary.total_findings, 61);
  assert.equal(summary.findings_by_category.unlisted, 1);
  assert.equal(summary.sample[0].name, 'server-only');
  assert.ok(summary.sample.length <= 40);
  assert.equal(summary.sample_truncated, true);
  assert.ok(JSON.stringify(summary).length < 13_000);
});

test('valid JSON with configuration-load error is INCOMPLETE, never clean', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = analyze(fixture, { output: { issues: [] }, exitCode: 2, analysisResult: { status: 2, stdout: '{"issues":[]}', stderr: 'Failed to load Knip configuration' } });
  assert.equal(result.state, 'INCOMPLETE');
});

test('malformed JSON, timeout and version mismatch fail closed', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(analyze(fixture, { analysisResult: { status: 0, stdout: 'not json', stderr: '' } }).state, 'TOOL_FAILURE');
  assert.equal(analyze(fixture, { analysisResult: { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT', message: 'timed out' } } }).state, 'TOOL_FAILURE');
  assert.equal(analyze(fixture, { version: '6.41.0' }).state, 'TOOL_FAILURE');
});

test('npm dependency preparation failure is INCOMPLETE, not analyzer-clean', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = analyze(fixture, { ciResult: { status: 1, stdout: '', stderr: 'registry unavailable' } });
  assert.equal(result.state, 'INCOMPLETE');
});

test('synthetic DATABASE_URL is loopback-only and arbitrary host secrets are not forwarded', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeFileSync(join(fixture.checkout, '.env'), 'DATABASE_URL=postgresql://production.invalid/private\n');
  const oldSecret = process.env.TAKAVEN_KNIP_TEST_SECRET;
  process.env.TAKAVEN_KNIP_TEST_SECRET = 'not-for-child';
  t.after(() => { if (oldSecret === undefined) delete process.env.TAKAVEN_KNIP_TEST_SECRET; else process.env.TAKAVEN_KNIP_TEST_SECRET = oldSecret; });
  const observed = [];
  analyze(fixture, { syntheticDatabaseUrl: true, observed, run: completedRunner({ observed }) });
  for (const call of observed) {
    assert.equal(call.options.env.DATABASE_URL, call.file === process.execPath ? 'postgresql://takaven_static:takaven_static@127.0.0.1:1/takaven_static' : undefined);
    assert.equal(call.options.env.TAKAVEN_KNIP_TEST_SECRET, undefined);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
  }
  assert.equal(existsSync(join(fixture.checkout, '.env')), false);
});

test('Windows uses the controlled npm command shim path', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const observed = [];
  const result = analyze(fixture, { platform: 'win32', observed, run: completedRunner({ observed }) });
  assert.equal(result.state, 'PASS_NO_FINDINGS');
  assert.ok(observed.slice(0, 2).every(call => /cmd(?:\.exe)?$/i.test(call.file) && call.args[0] === '/d' && call.args.join(' ').includes('npm.cmd')));
});

test('analyzer evidence can support findings but never becomes runtime evidence', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = analyze(fixture, { output: { issues: [{ file: 'package.json', unlisted: [{ name: 'nanoid' }] }] }, exitCode: 1 });
  const record = fixture.registry.records.find(item => item.evidence_id === result.evidence_id);
  assert.equal(isEligibleFindingEvidence(fixture.registry, result.evidence_id), true);
  assert.equal(deriveRuntimeEvidenceStatus(record), null);
  assert.equal(isEligibleRuntimeEvidence(fixture.registry, result.evidence_id), false);
});

test('clean analyzer result is retained as static evidence but cannot support a defect finding or runtime PASS', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = analyze(fixture);
  assert.equal(result.state, 'PASS_NO_FINDINGS');
  const record = fixture.registry.records.find(item => item.evidence_id === result.evidence_id);
  assert.equal(record.state, 'PASS_NO_FINDINGS');
  assert.equal(isEligibleFindingEvidence(fixture.registry, result.evidence_id), false);
  assert.equal(isEligibleRuntimeEvidence(fixture.registry, result.evidence_id), false);
  const reconciled = applyControllerRuntimeResults({ verdict: 'INCONCLUSIVE', runtime_status: 'NOT RUN', runtime_evidence: [], executive_summary: 'Static analysis only.' }, fixture.registry, { mode: 'inspect' });
  assert.equal(reconciled.runtime_status, 'NOT RUN');
});

test('dependency preparation leaves committed project source files unchanged', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const packageBefore = readFileSync(join(fixture.checkout, 'package.json'), 'utf8');
  const lockBefore = readFileSync(join(fixture.checkout, 'package-lock.json'), 'utf8');
  analyze(fixture);
  assert.equal(readFileSync(join(fixture.checkout, 'package.json'), 'utf8'), packageBefore);
  assert.equal(readFileSync(join(fixture.checkout, 'package-lock.json'), 'utf8'), lockBefore);
});
