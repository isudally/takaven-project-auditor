import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { captureEvidence, redactEvidenceText } from './evidence.mjs';

const ALLOWED_EXECUTABLES = new Set(['node', 'npm', 'npx', 'python', 'python3', 'pnpm', 'yarn', 'go', 'cargo', 'pytest']);
const WINDOWS_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn']);
const SENSITIVE_ENV = /(?:token|secret|password|private|credential|api[_-]?key)/i;
const COMMAND_OPERATIONS = ['setup', 'build', 'declared_test', 'server', 'browser_smoke'];

function executableName(command) {
  return command.split(/[\\/]/).at(-1).replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase();
}

function validateCommand(command, operation) {
  if (!Array.isArray(command) || command.length === 0 || command.length > 32 || command.some(item => typeof item !== 'string' || item.length > 500)) throw new Error(`Invalid approved command for ${operation}`);
  if (!ALLOWED_EXECUTABLES.has(executableName(command[0]))) throw new Error(`Executable is not approved for ${operation}: ${command[0]}`);
}

function resolveExecutable(command) {
  if (process.platform !== 'win32' || /[\\/]/.test(command) || /\.(?:cmd|exe|bat)$/i.test(command)) return command;
  const name = command.toLowerCase();
  if (!WINDOWS_SHIMS.has(name)) return command;
  // Node cannot spawn a .cmd shim directly with shell:false on Windows. Keep
  // the shim name on PATH and invoke it through the controlled cmd wrapper.
  return `${command}.cmd`;
}

function windowsCommandQuote(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

function resolveSpawnInvocation(command, args) {
  const executable = resolveExecutable(command);
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    const commandLine = [executable, ...args].map(windowsCommandQuote).join(' ');
    return { executable, launcher: process.env.ComSpec || 'cmd.exe', file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', commandLine] };
  }
  return { executable, launcher: null, file: executable, args };
}

function expand(value, checkout) {
  return value.replaceAll('{checkout}', checkout).replaceAll('{target}', checkout);
}

function resolveWorkingDirectory(checkout, value = '.') {
  const root = realpathSync(checkout);
  const cwd = resolve(root, value);
  if (cwd !== root && !cwd.startsWith(`${root}${sep}`)) throw new Error(`Runner working directory escapes checkout: ${value}`);
  if (!existsSync(cwd)) throw new Error(`Runner working directory does not exist: ${value}`);
  return cwd;
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

function errorRecord(error) {
  if (!error) return null;
  return { name: error.name, code: error.code, message: error.message, errno: error.errno, syscall: error.syscall };
}

function runCommand({ operation, spec, checkout, registry, timeoutMs }) {
  validateCommand(spec.command, operation);
  const cwd = resolveWorkingDirectory(checkout, spec.cwd ?? '.');
  const requestedCommand = spec.command.map(item => expand(item, checkout));
  const invocation = resolveSpawnInvocation(requestedCommand[0], requestedCommand.slice(1));
  const executable = invocation.executable;
  const args = requestedCommand.slice(1);
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  const result = spawnSync(invocation.file, invocation.args, {
    cwd, env: runnerEnv(spec), encoding: 'utf8', shell: false,
    timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const launchFailed = Boolean(result.error && !timedOut && result.status === null && result.signal === null);
  const started = !launchFailed;
  const exitCode = launchFailed ? null : timedOut ? 124 : (result.status ?? 1);
  const signal = result.signal ?? null;
  const stdout = redactEvidenceText(result.stdout ?? '');
  const stderr = redactEvidenceText(result.stderr ?? '');
  const outcome = timedOut ? 'timed_out' : launchFailed ? 'launch_failed' : exitCode === 0 ? 'passed' : 'failed';
  const observation = launchFailed
    ? `Command failed to start: ${result.error?.code ?? 'unknown spawn error'}.`
    : timedOut ? `Command timed out after ${timeoutMs} ms.`
      : `Command started and exited with status ${exitCode}${signal ? ` (${signal})` : ''}.`;
  const evidenceId = captureEvidence(registry, {
    type: 'runner_execution', action: 'approved_runner', operation,
    command: [executable, ...args].join(' '), requested_command: requestedCommand.join(' '),
    executable, launcher: invocation.launcher, arguments: args, launcher_arguments: invocation.args, cwd, working_directory: cwd,
    started_at: startedAt, duration_ms: Math.round(durationMs), started,
    status: result.status ?? null, exit_code: exitCode, signal,
    spawn_error: errorRecord(result.error), stdout, stderr,
    stdout_hash: sha256(stdout), stderr_hash: sha256(stderr),
    outcome, observation, execution_verified: started, timeout_ms: timeoutMs,
  });
  return { evidence_id: evidenceId, outcome, exit_code: exitCode, signal, started, duration_ms: Math.round(durationMs), stdout, stderr, executable, arguments: args, cwd };
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    try { child.kill(); } catch {}
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  }
}

function probeReady(url, timeoutMs) {
  const probe = spawnSync(process.execPath, ['-e', "fetch(process.argv[1]).then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))", url], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: Math.min(timeoutMs, 5000), stdio: ['ignore', 'pipe', 'pipe'],
  });
  return probe.status === 0;
}

function waitForServer(child, spec, timeoutMs) {
  const readyUrl = spec.ready_url;
  const deadline = Date.now() + Math.min(spec.ready_timeout_ms ?? timeoutMs, timeoutMs);
  if (!readyUrl) {
    const waitMs = Math.min(spec.ready_wait_ms ?? 500, timeoutMs);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    return Boolean(child.pid);
  }
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    if (probeReady(readyUrl, Math.min(1000, deadline - Date.now()))) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(spec.poll_ms ?? 250, Math.max(1, deadline - Date.now())));
  }
  return false;
}

function runBrowserSmoke({ spec, checkout, registry, timeoutMs }) {
  if (!spec.server) return runCommand({ operation: 'browser_smoke', spec, checkout, registry, timeoutMs });
  validateCommand(spec.server.command, 'server');
  const serverCwd = resolveWorkingDirectory(checkout, spec.server.cwd ?? '.');
  const serverCommand = spec.server.command.map(item => expand(item, checkout));
  const serverInvocation = resolveSpawnInvocation(serverCommand[0], serverCommand.slice(1));
  const serverExecutable = serverInvocation.executable;
  const serverArgs = serverCommand.slice(1);
  const serverStartedAt = new Date().toISOString();
  const server = spawn(serverInvocation.file, serverInvocation.args, {
    cwd: serverCwd, env: runnerEnv(spec.server), shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let serverStdout = '';
  let serverStderr = '';
  let serverError = null;
  server.stdout?.on('data', chunk => { serverStdout += String(chunk); });
  server.stderr?.on('data', chunk => { serverStderr += String(chunk); });
  server.on('error', error => { serverError = error; });
  const ready = !serverError && waitForServer(server, spec.server, timeoutMs);
  const serverEvidenceId = captureEvidence(registry, {
    type: 'runner_execution', action: 'approved_runner', operation: 'server',
    command: [serverExecutable, ...serverArgs].join(' '), executable: serverExecutable, launcher: serverInvocation.launcher, arguments: serverArgs, launcher_arguments: serverInvocation.args,
    cwd: serverCwd, working_directory: serverCwd, started_at: serverStartedAt,
    started: !serverError && Boolean(server.pid), status: server.exitCode ?? null, signal: null,
    exit_code: serverError ? null : ready ? 0 : server.exitCode, spawn_error: errorRecord(serverError),
    stdout: redactEvidenceText(serverStdout), stderr: redactEvidenceText(serverStderr),
    outcome: serverError || !ready ? (serverError ? 'launch_failed' : 'failed') : 'passed',
    observation: serverError ? `Server failed to start: ${serverError.code ?? 'unknown spawn error'}.` : ready ? 'Server started and readiness check passed.' : 'Server did not become ready within the configured timeout.',
    execution_verified: !serverError && Boolean(server.pid) && ready, timeout_ms: timeoutMs,
  });
  let browserResult;
  try {
    browserResult = ready
      ? runCommand({ operation: 'browser_smoke', spec, checkout, registry, timeoutMs })
      : { evidence_id: captureEvidence(registry, { type: 'runner_execution', action: 'approved_runner', operation: 'browser_smoke', outcome: 'not_available', observation: 'Browser check was not started because the approved server was not ready.', execution_verified: false }), outcome: 'not_available', exit_code: null };
  } finally {
    terminateProcessTree(server);
  }
  return { ...browserResult, server_evidence_id: serverEvidenceId };
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
  const browser = config.browser_smoke ? runBrowserSmoke({ spec: config.browser_smoke, checkout, registry, timeoutMs }) : null;
  const passed = Boolean(build?.outcome === 'passed' && (!config.browser_smoke || browser?.outcome === 'passed'));
  const evidenceId = captureEvidence(registry, {
    type: 'runner_execution', action: 'correction_verification', operation: 'correction_verification',
    patch_hash: sha256(patch), applied_diff_hash: sha256(appliedDiff), build_evidence_id: build?.evidence_id ?? null,
    browser_evidence_id: browser?.evidence_id ?? null, outcome: passed ? 'passed' : 'failed',
    execution_verified: true, exit_code: passed ? 0 : 1,
  });
  return { evidence_id: evidenceId, outcome: passed ? 'passed' : 'failed', exit_code: passed ? 0 : 1, patch_hash: sha256(patch), applied_diff_hash: sha256(appliedDiff), build_evidence_id: build?.evidence_id, browser_evidence_id: browser?.evidence_id };
}

function validateConfig(config) {
  if (!config || config.version !== 1 || typeof config !== 'object') throw new Error('Runner config must declare version 1');
  if (config.scenario !== undefined && (typeof config.scenario !== 'string' || config.scenario.length === 0)) throw new Error('Runner scenario must be a non-empty string');
  if (config.required_checks !== undefined && (!Array.isArray(config.required_checks) || config.required_checks.some(check => typeof check !== 'string' || check.length === 0))) throw new Error('Runner required_checks must be an array of names');
  for (const operation of COMMAND_OPERATIONS) {
    const spec = config[operation];
    if (!spec) continue;
    validateCommand(spec.command, operation);
    runnerEnv(spec);
    if (spec.cwd !== undefined && typeof spec.cwd !== 'string') throw new Error(`Runner cwd must be a string for ${operation}`);
    if (operation === 'browser_smoke' && spec.server) {
      validateCommand(spec.server.command, 'server');
      runnerEnv(spec.server);
      if (spec.server.cwd !== undefined && typeof spec.server.cwd !== 'string') throw new Error('Runner cwd must be a string for server');
      if (spec.server.ready_url !== undefined && (typeof spec.server.ready_url !== 'string' || !/^https?:\/\//i.test(spec.server.ready_url))) throw new Error('Server ready_url must be an http(s) URL');
    }
  }
  return config;
}

export function loadRunnerConfig(path) {
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function createApprovedRunner({ config, registry, scratch, timeoutMs = 120000 }) {
  validateConfig(config);
  let setupResult = null;
  return ({ operation, checkout, patch }) => {
    if (operation === 'correction_verification') return applyAndVerifyPatch({ patch, checkout, config, registry, timeoutMs, scratch });
    if (operation === 'setup') {
      if (setupResult) return setupResult;
      const spec = config.setup;
      if (!spec) {
        const evidenceId = captureEvidence(registry, { type: 'runner_execution', action: 'approved_runner', operation, outcome: 'not_available', execution_verified: false, observation: 'No setup command is configured.' });
        setupResult = { evidence_id: evidenceId, outcome: 'not_available', exit_code: null };
      } else {
        setupResult = runCommand({ operation, spec, checkout, registry, timeoutMs });
      }
      return setupResult;
    }
    if (operation === 'browser_smoke') {
      if (config.setup && !setupResult) setupResult = runCommand({ operation: 'setup', spec: config.setup, checkout, registry, timeoutMs });
      if (setupResult && setupResult.outcome !== 'passed') return { evidence_id: setupResult.evidence_id, outcome: 'not_available', exit_code: null, blocked_by: 'setup' };
      const spec = config.browser_smoke;
      if (!spec) {
        const evidenceId = captureEvidence(registry, { type: 'runner_execution', action: 'approved_runner', operation, outcome: 'not_available', execution_verified: false, observation: 'No browser_smoke command is configured.' });
        return { evidence_id: evidenceId, outcome: 'not_available', exit_code: null };
      }
      return runBrowserSmoke({ spec, checkout, registry, timeoutMs });
    }
    if (operation !== 'setup' && config.setup && !setupResult) setupResult = runCommand({ operation: 'setup', spec: config.setup, checkout, registry, timeoutMs });
    if (operation !== 'setup' && setupResult && setupResult.outcome !== 'passed') return { evidence_id: setupResult.evidence_id, outcome: 'not_available', exit_code: null, blocked_by: 'setup' };
    const spec = config[operation];
    if (!spec) {
      const evidenceId = captureEvidence(registry, { type: 'runner_execution', action: 'approved_runner', operation, outcome: 'not_available', execution_verified: false, observation: `No ${operation} command is configured.` });
      return { evidence_id: evidenceId, outcome: 'not_available', exit_code: null };
    }
    return runCommand({ operation, spec, checkout, registry, timeoutMs });
  };
}
