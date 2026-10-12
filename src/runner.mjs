import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { captureEvidence, redactEvidenceText } from './evidence.mjs';

const ALLOWED_EXECUTABLES = new Set(['node', 'npm', 'npx', 'python', 'python3', 'pnpm', 'yarn', 'go', 'cargo', 'pytest']);
const SENSITIVE_ENV = /(?:token|secret|password|private|credential|api[_-]?key)/i;

function validateCommand(command, operation) {
  if (!Array.isArray(command) || command.length === 0 || command.length > 32 || command.some(item => typeof item !== 'string' || item.length > 500)) throw new Error(`Invalid approved command for ${operation}`);
  const executable = command[0].split(/[\\/]/).at(-1).replace(/\.(?:cmd|exe)$/i, '').toLowerCase();
  if (!ALLOWED_EXECUTABLES.has(executable)) throw new Error(`Executable is not approved for ${operation}: ${command[0]}`);
}

function expand(value, checkout) {
  return value.replaceAll('{checkout}', checkout).replaceAll('{target}', checkout);
}

function runnerEnv(config) {
  const env = { CI: 'true', PATH: process.env.PATH, Path: process.env.Path, NODE_ENV: 'test' };
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || SENSITIVE_ENV.test(key) || typeof value !== 'string') throw new Error(`Runner environment variable is not allowed: ${key}`);
    env[key] = value;
  }
  return env;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function runCommand({ operation, spec, checkout, registry, timeoutMs }) {
  validateCommand(spec.command, operation);
  const cwd = resolve(checkout, spec.cwd ?? '.');
  const command = spec.command.map(item => expand(item, checkout));
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  const result = spawnSync(command[0], command.slice(1), {
    cwd, env: runnerEnv(spec), encoding: 'utf8', shell: false,
    timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const exitCode = timedOut ? 124 : (result.status ?? 1);
  const stdout = redactEvidenceText(result.stdout ?? '');
  const stderr = redactEvidenceText(result.stderr ?? '');
  const outcome = timedOut ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed';
  const evidenceId = captureEvidence(registry, {
    type: 'runner_execution', action: 'approved_runner', operation, command: command.join(' '), cwd,
    started_at: startedAt, duration_ms: Math.round(durationMs), exit_code: exitCode,
    stdout, stderr, stdout_hash: sha256(stdout), stderr_hash: sha256(stderr),
    outcome, execution_verified: true, timeout_ms: timeoutMs,
  });
  return { evidence_id: evidenceId, outcome, exit_code: exitCode, duration_ms: Math.round(durationMs), stdout, stderr };
}

function applyAndVerifyPatch({ patch, checkout, config, registry, timeoutMs, scratch }) {
  if (typeof patch !== 'string' || patch.length === 0) throw new Error('Correction verification requires a patch');
  const patchPath = join(scratch, 'controller-proposed.patch');
  writeFileSync(patchPath, patch, { mode: 0o600 });
  const check = spawnSync('git', ['-C', checkout, 'apply', '--check', '--', patchPath], { encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs });
  const checkOutput = redactEvidenceText(`${check.stdout ?? ''}${check.stderr ?? ''}`);
  if (check.status !== 0) {
    const evidenceId = captureEvidence(registry, { type: 'runner_execution', action: 'patch_validation', operation: 'correction_verification', command: `git -C ${checkout} apply --check ${patchPath}`, exit_code: check.status ?? 1, stdout: checkOutput, patch_hash: sha256(patch), outcome: 'failed', execution_verified: true });
    return { evidence_id: evidenceId, outcome: 'failed', exit_code: check.status ?? 1, patch_hash: sha256(patch), stderr: checkOutput };
  }
  const applied = spawnSync('git', ['-C', checkout, 'apply', '--', patchPath], { encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs });
  if (applied.status !== 0) throw new Error(`Approved correction patch failed to apply: ${applied.stderr ?? applied.stdout ?? ''}`);
  const diff = spawnSync('git', ['-C', checkout, 'diff', '--no-ext-diff'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs });
  const appliedDiff = diff.stdout ?? '';
  const build = config.build ? runCommand({ operation: 'correction_build', spec: config.build, checkout, registry, timeoutMs }) : null;
  const browser = config.browser_smoke ? runCommand({ operation: 'correction_browser_smoke', spec: config.browser_smoke, checkout, registry, timeoutMs }) : null;
  const passed = Boolean(build?.outcome === 'passed' && (!config.browser_smoke || browser?.outcome === 'passed'));
  const evidenceId = captureEvidence(registry, {
    type: 'runner_execution', action: 'correction_verification', operation: 'correction_verification',
    patch_hash: sha256(patch), applied_diff_hash: sha256(appliedDiff), build_evidence_id: build?.evidence_id ?? null,
    browser_evidence_id: browser?.evidence_id ?? null, outcome: passed ? 'passed' : 'failed',
    execution_verified: true, exit_code: passed ? 0 : 1,
  });
  return { evidence_id: evidenceId, outcome: passed ? 'passed' : 'failed', exit_code: passed ? 0 : 1, patch_hash: sha256(patch), applied_diff_hash: sha256(appliedDiff), build_evidence_id: build?.evidence_id, browser_evidence_id: browser?.evidence_id };
}

export function loadRunnerConfig(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!config || config.version !== 1 || typeof config !== 'object') throw new Error('Runner config must declare version 1');
  for (const [operation, spec] of Object.entries({ build: config.build, declared_test: config.declared_test, browser_smoke: config.browser_smoke })) if (spec) validateCommand(spec.command, operation);
  return config;
}

export function createApprovedRunner({ config, registry, scratch, timeoutMs = 120000 }) {
  if (!config || config.version !== 1) throw new Error('Runner config must declare version 1');
  for (const [operation, spec] of Object.entries({ build: config.build, declared_test: config.declared_test, browser_smoke: config.browser_smoke })) if (spec) {
    validateCommand(spec.command, operation);
    runnerEnv(spec);
  }
  return ({ operation, checkout, patch }) => {
    if (operation === 'correction_verification') return applyAndVerifyPatch({ patch, checkout, config, registry, timeoutMs, scratch });
    const spec = config[operation === 'browser_smoke' ? 'browser_smoke' : operation];
    if (!spec) {
      const evidenceId = captureEvidence(registry, { type: 'runner_execution', action: 'approved_runner', operation, outcome: 'not_available', execution_verified: false, observation: `No ${operation} command is configured.` });
      return { evidence_id: evidenceId, outcome: 'not_available', exit_code: null };
    }
    return runCommand({ operation, spec, checkout, registry, timeoutMs });
  };
}
