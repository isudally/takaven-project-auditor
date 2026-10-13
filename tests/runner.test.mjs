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
