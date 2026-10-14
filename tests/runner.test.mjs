import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createEvidenceRegistry, isEligibleRuntimeEvidence } from '../src/evidence.mjs';
import { createApprovedRunner, requiredChecksForConfig } from '../src/runner.mjs';

function initGitCheckout(directory) {
  writeFileSync(join(directory, 'app.mjs'), 'export const broken = true;\n');
  const init = spawnSync('git', ['-C', directory, 'init', '-q'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.equal(spawnSync('git', ['-C', directory, 'add', 'app.mjs'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', directory, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'fixture'], { encoding: 'utf8' }).status, 0);
}

test('approved runner captures independent command evidence', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'takaven-runner-'));
  try {
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
    const runner = createApprovedRunner({ config: { version: 1, build: { command: ['node', '-e', 'process.stdout.write("ok")'] } }, registry, scratch, timeoutMs: 5000 });
    const result = runner({ operation: 'build', checkout: scratch });
    assert.equal(result.outcome, 'passed', JSON.stringify(registry.records, null, 2));
    assert.equal(result.exit_code, 0);
    assert.equal(isEligibleRuntimeEvidence(registry, result.evidence_id, { status: 'PASS', commit: 'abc' }), true);
    assert.match(registry.records[0].stdout, /ok/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('runner derives acceptance checks without treating setup as an acceptance check', () => {
  assert.deepEqual(requiredChecksForConfig({ version: 1, setup: { command: ['node', '-e', 'true'] }, build: { command: ['node', '-e', 'true'] }, declared_test: { command: ['node', '-e', 'true'] } }), {
    configured: ['build', 'declared_test'],
    required: ['build', 'declared_test'],
  });
  assert.throws(() => requiredChecksForConfig({ version: 1, build: { command: ['node', '-e', 'true'] }, required_checks: [] }), /must not be empty/);
  assert.throws(() => requiredChecksForConfig({ version: 1, build: { command: ['node', '-e', 'true'] }, required_checks: ['declared_test'] }), /configured acceptance checks/);
});

test('runner rejects unapproved executables and secret environment names', () => {
  const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
  assert.throws(() => createApprovedRunner({ config: { version: 1, build: { command: ['sh', '-c', 'true'] } }, registry, scratch: tmpdir() }), /not approved/);
  assert.throws(() => createApprovedRunner({ config: { version: 1, build: { command: ['node', '-e', 'true'], env: { API_TOKEN: 'x' } } }, registry, scratch: tmpdir() }), /not allowed/);
});

test('runner records a failed launch separately from a command failure', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'takaven-runner-launch-'));
  try {
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
    const missingExecutable = join(scratch, process.platform === 'win32' ? 'node.exe' : 'node');
    const launchRunner = createApprovedRunner({ config: { version: 1, build: { command: [missingExecutable, '--version'] } }, registry, scratch, timeoutMs: 5000 });
    const launch = launchRunner({ operation: 'build', checkout: scratch });
    assert.equal(launch.outcome, 'launch_failed');
    assert.equal(launch.started, false);
    assert.equal(launch.exit_code, null);
    assert.equal(launch.signal, null);
    assert.equal(registry.records[0].spawn_error.code, 'ENOENT');
    assert.equal(registry.records[0].executable, missingExecutable);
    assert.deepEqual(registry.records[0].arguments, ['--version']);
    assert.equal(registry.records[0].cwd, scratch);

    const commandRunner = createApprovedRunner({ config: { version: 1, declared_test: { command: ['node', '-e', 'process.exit(7)'] } }, registry, scratch, timeoutMs: 5000 });
    const command = commandRunner({ operation: 'declared_test', checkout: scratch });
    assert.equal(command.outcome, 'failed');
    assert.equal(command.started, true);
    assert.equal(command.exit_code, 7);
    assert.equal(command.signal, null);
    assert.equal(registry.records[1].spawn_error, null);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('runner performs setup once and preserves isolated command evidence', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'takaven-runner-setup-'));
  try {
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc', requiredChecks: ['setup', 'build'] });
    const runner = createApprovedRunner({
      config: {
        version: 1,
        setup: { command: ['node', '-e', 'process.stdout.write("setup")'] },
        build: { command: ['node', '-e', 'process.stdout.write("build")'] },
      },
      registry, scratch, timeoutMs: 5000,
    });
    assert.equal(runner({ operation: 'setup', checkout: scratch }).outcome, 'passed');
    assert.equal(runner({ operation: 'build', checkout: scratch }).outcome, 'passed');
    assert.equal(runner({ operation: 'build', checkout: scratch }).outcome, 'passed');
    assert.deepEqual(registry.records.map(record => record.operation), ['setup', 'build', 'build']);
    assert.match(registry.records[0].stdout, /setup/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('runner requires an explicit server readiness URL before browser checks', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'takaven-runner-browser-'));
  try {
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc', requiredChecks: ['browser_smoke'] });
    assert.throws(() => createApprovedRunner({
      config: {
        version: 1,
        browser_smoke: {
          command: ['node', '-e', 'process.stdout.write("CLICK_ASSERTION_PASSED")'],
          server: {
            command: ['node', '-e', 'setTimeout(() => {}, 5000)'],
            ready_wait_ms: 100,
          },
        },
      },
      registry, scratch, timeoutMs: 10000,
    }), /requires an http\(s\) ready_url/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('browser execution without a controller assertion is PARTIAL, not NOT RUN', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'takaven-runner-browser-partial-'));
  try {
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc', requiredChecks: ['browser_smoke'] });
    const runner = createApprovedRunner({ config: { version: 1, browser_smoke: { command: ['node', '-e', 'process.exit(0)'] } }, registry, scratch, timeoutMs: 5000 });
    const result = runner({ operation: 'browser_smoke', checkout: scratch });
    assert.equal(result.outcome, 'partial');
    assert.equal(isEligibleRuntimeEvidence(registry, result.evidence_id, { status: 'PARTIAL', commit: 'abc' }), true);
    assert.match(registry.records[0].observation, /execution completed successfully.*UI assertion.*not verified/i);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('browser assertion is controller-bound and supports true and false outcomes', () => {
  for (const [label, uiPassed, expectedOutcome, expectedStatus] of [['pass', true, 'passed', 'PASS'], ['fail', false, 'failed', 'FAIL']]) {
    const scratch = mkdtempSync(join(tmpdir(), `takaven-runner-browser-${label}-`));
    try {
      const script = join(scratch, 'browser-assertion.mjs');
      writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.TAKAVEN_BROWSER_ASSERTION_PATH, JSON.stringify({ version: 1, execution_id: process.env.TAKAVEN_BROWSER_EXECUTION_ID, ui_passed: ${uiPassed} }));\n`);
      const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc', requiredChecks: ['browser_smoke'] });
      const runner = createApprovedRunner({ config: { version: 1, browser_smoke: { command: ['node', script], assertion: { path: '.controller/ui-assertion.json' } } }, registry, scratch, timeoutMs: 5000 });
      const result = runner({ operation: 'browser_smoke', checkout: scratch });
      assert.equal(result.outcome, expectedOutcome, `${label} ${JSON.stringify(registry.records)}`);
      assert.equal(registry.records[0].ui_passed, uiPassed, label);
      assert.equal(registry.records[0].assertion_status, 'valid', label);
      assert.equal(typeof registry.records[0].assertion_hash, 'string', label);
      assert.equal(isEligibleRuntimeEvidence(registry, result.evidence_id, { status: expectedStatus, commit: 'abc' }), true, label);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
});

test('missing, malformed, stale and conflicting browser assertions cannot PASS', () => {
  const cases = [
    ['missing', 'process.exit(0)', 'missing', 'partial'],
    ['malformed', `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.TAKAVEN_BROWSER_ASSERTION_PATH, '{}');`, 'invalid', 'partial'],
    ['wrong-id', `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.TAKAVEN_BROWSER_ASSERTION_PATH, JSON.stringify({ version: 1, execution_id: 'stale-execution', ui_passed: true }));`, 'invalid', 'partial'],
    ['command-fails', `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.TAKAVEN_BROWSER_ASSERTION_PATH, JSON.stringify({ version: 1, execution_id: process.env.TAKAVEN_BROWSER_EXECUTION_ID, ui_passed: true })); process.exit(7);`, 'valid', 'partial'],
  ];
  for (const [label, scriptBody, assertionStatus, expectedOutcome] of cases) {
    const scratch = mkdtempSync(join(tmpdir(), `takaven-runner-browser-${label}-`));
    try {
      const script = join(scratch, 'browser-assertion.mjs');
      writeFileSync(script, scriptBody);
      const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc', requiredChecks: ['browser_smoke'] });
      const runner = createApprovedRunner({ config: { version: 1, browser_smoke: { command: ['node', script], assertion: { path: '.controller/ui-assertion.json' } } }, registry, scratch, timeoutMs: 5000 });
      const result = runner({ operation: 'browser_smoke', checkout: scratch });
      assert.equal(result.outcome, expectedOutcome, label);
      assert.equal(registry.records[0].assertion_status, assertionStatus, label);
      assert.notEqual(isEligibleRuntimeEvidence(registry, result.evidence_id, { status: 'PASS', commit: 'abc' }), true, label);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const staleScratch = mkdtempSync(join(tmpdir(), 'takaven-runner-browser-stale-file-'));
  try {
    mkdirSync(join(staleScratch, '.controller'));
    writeFileSync(join(staleScratch, '.controller', 'ui-assertion.json'), JSON.stringify({ version: 1, execution_id: 'old', ui_passed: true }));
    const script = join(staleScratch, 'browser-assertion.mjs');
    writeFileSync(script, 'process.exit(0);\n');
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc', requiredChecks: ['browser_smoke'] });
    const runner = createApprovedRunner({ config: { version: 1, browser_smoke: { command: ['node', script], assertion: { path: '.controller/ui-assertion.json' } } }, registry, staleScratch, timeoutMs: 5000 });
    const result = runner({ operation: 'browser_smoke', checkout: staleScratch });
    assert.equal(result.outcome, 'partial');
    assert.equal(registry.records[0].assertion_status, 'missing');
  } finally { rmSync(staleScratch, { recursive: true, force: true }); }
});

test('browser prerequisite failure remains NOT RUN', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'takaven-runner-browser-unavailable-'));
  try {
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc', requiredChecks: ['browser_smoke'] });
    const runner = createApprovedRunner({
      config: {
        version: 1,
        browser_smoke: {
          command: ['node', '-e', 'process.exit(0)'],
          server: { command: ['node', '-e', 'process.exit(1)'], ready_url: 'http://127.0.0.1:9', ready_timeout_ms: 500, poll_ms: 50 },
        },
      }, registry, scratch, timeoutMs: 2000,
    });
    const result = runner({ operation: 'browser_smoke', checkout: scratch });
    assert.equal(result.outcome, 'not_available');
    const browserRecord = registry.records.find(record => record.operation === 'browser_smoke');
    assert.equal(browserRecord.outcome, 'not_available');
    assert.equal(isEligibleRuntimeEvidence(registry, browserRecord.evidence_id, { status: 'PASS', commit: 'abc' }), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('browser assertion configuration is operator-bound and traversal-free', () => {
  const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
  assert.throws(() => createApprovedRunner({ config: { version: 1, browser_smoke: { command: ['node', '-e', 'true'], assertion: { path: '../ui.json' } } }, registry, scratch: tmpdir() }), /relative and traversal-free/);
  assert.throws(() => createApprovedRunner({ config: { version: 1, browser_smoke: { command: ['node', '-e', 'true'], assertion: { path: 'ui.json', expected: true } } }, registry, scratch: tmpdir() }), /contain only path/);
});

test('runner rejects correction execution at the runner boundary without modifying the target', () => {
  const scratch = mkdtempSync(join(process.cwd(), 'runner-correction-disabled-'));
  try {
    initGitCheckout(scratch);
    const controllerScratch = join(scratch, 'controller');
    mkdirSync(controllerScratch);
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
    const runner = createApprovedRunner({ config: { version: 1, build: { command: ['node', '-e', 'process.exit(0)'] } }, registry, scratch: controllerScratch, timeoutMs: 10000 });
    const patch = 'diff --git a/app.mjs b/app.mjs\n--- a/app.mjs\n+++ b/app.mjs\n@@ -1 +1 @@\n-export const broken = true;\n+export const broken = false;\n';
    const result = runner({ operation: 'correction_verification', checkout: scratch, patch });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.execution_verified, false);
    assert.equal(readFileSync(join(scratch, 'app.mjs'), 'utf8'), 'export const broken = true;\n');
    assert.deepEqual(registry.records.map(record => record.operation), ['correction_verification']);
    assert.equal(registry.records[0].action, 'policy_gate');
    assert.match(registry.records[0].observation, /disabled at the approved runner boundary/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('Windows resolves npm through its command shim without enabling a shell', { skip: process.platform !== 'win32' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'takaven-runner-npm-'));
  try {
    const registry = createEvidenceRegistry({ source: 'fixture', commit: 'abc' });
    const runner = createApprovedRunner({ config: { version: 1, build: { command: ['npm', '--version'] } }, registry, scratch, timeoutMs: 10000 });
    const result = runner({ operation: 'build', checkout: scratch });
    assert.equal(result.outcome, 'passed');
    assert.match(registry.records[0].executable, /npm\.cmd$/i);
    assert.equal(registry.records[0].requested_command, 'npm --version');
    assert.equal(registry.records[0].command.includes('npm.cmd'), true);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
