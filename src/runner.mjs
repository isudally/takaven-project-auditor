import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { captureEvidence, redactEvidenceText } from './evidence.mjs';

const ALLOWED_EXECUTABLES = new Set(['node', 'npm', 'npx', 'python', 'python3', 'pnpm', 'yarn', 'go', 'cargo', 'pytest']);
const WINDOWS_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn']);
const SENSITIVE_ENV = /(?:token|secret|password|private|credential|api[_-]?key)/i;
const COMMAND_OPERATIONS = ['setup', 'build', 'declared_test', 'server', 'browser_smoke'];
export const ACCEPTANCE_OPERATIONS = ['build', 'declared_test', 'browser_smoke'];

export function requiredChecksForConfig(config) {
  const configured = ACCEPTANCE_OPERATIONS.filter(operation => Boolean(config?.[operation]));
  if (configured.length === 0) throw new Error('Runner config must declare at least one acceptance check');
  if (config.required_checks === undefined) return { configured, required: configured };
  if (!Array.isArray(config.required_checks) || config.required_checks.length === 0) {
    throw new Error('Runner required_checks must not be empty for verify mode');
  }
  const duplicate = new Set(config.required_checks).size !== config.required_checks.length;
  if (duplicate || config.required_checks.some(check => !configured.includes(check))) {
    throw new Error('Runner required_checks must name configured acceptance checks without duplicates');
  }
  return { configured, required: [...config.required_checks] };
}

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
    return false;
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

function cloneCorrectionCheckout(checkout, scratch) {
  const correctionCheckout = join(scratch, 'correction-checkout');
  const containsCopiedSource = () => {
    try {
      return readdirSync(correctionCheckout, { withFileTypes: true }).some(entry => entry.name !== '.git');
    } catch {
      return false;
    }
  };
  const containsTrackedSource = () => {
    const listed = spawnSync('git', ['-C', checkout, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000 });
    if (listed.status !== 0) return false;
    const files = listed.stdout.trim().split(/\r?\n/).filter(Boolean);
    return files.length > 0 && files.every(file => existsSync(join(correctionCheckout, ...file.split('/'))));
  };
  const preparePatchableArchive = () => {
    const initialized = spawnSync('git', ['-C', correctionCheckout, 'init', '-q'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000 });
    const indexed = initialized.status === 0
      ? spawnSync('git', ['-C', correctionCheckout, 'add', '-A'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000 })
      : null;
    return initialized.status === 0 && indexed?.status === 0 && containsTrackedSource();
  };
  mkdirSync(correctionCheckout, { recursive: true });
  const archive = join(scratch, 'correction-checkout.tar');
  const archived = spawnSync('git', ['-C', checkout, 'archive', '--format=tar', '--output', archive, 'HEAD'], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000,
  });
  if (archived.status === 0) {
    const extracted = spawnSync('tar', ['-xf', archive, '-C', correctionCheckout], {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000,
    });
    if (extracted.status === 0 && preparePatchableArchive()) return correctionCheckout;
  }
  rmSync(correctionCheckout, { recursive: true, force: true });
  mkdirSync(correctionCheckout, { recursive: true });
  const cloned = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', '--', checkout, correctionCheckout], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000,
  });
  if (cloned.status === 0 && containsTrackedSource()) return correctionCheckout;
  rmSync(correctionCheckout, { recursive: true, force: true });
  cpSync(checkout, correctionCheckout, { recursive: true, force: true, filter: source => !source.includes(`${sep}.git${sep}`) && !source.endsWith(`${sep}.git`) });
  if (containsCopiedSource()) {
    // The copied checkout is still disposable. Git metadata is useful for patch
    // application and diff capture, but absence of Git must not make an already
    // verified source copy appear empty on restricted Windows hosts.
    preparePatchableArchive();
    return correctionCheckout;
  }
  throw new Error(`Disposable correction checkout failed: ${cloned.stderr ?? cloned.stdout ?? 'git clone failed'}`);
}

function patchPaths(patch) {
  const paths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]);
  if (paths.length === 0 || paths.some(path => path === '.git' || path === 'dev/null' || path.startsWith('.git/') || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === ''))) {
    throw new Error('Correction patch contains no safe repository-relative paths');
  }
  return [...new Set(paths)];
}

function captureAppliedDiff(checkout, correctionCheckout, patch, timeoutMs) {
  return patchPaths(patch).map(path => {
    const baseline = join(checkout, ...path.split('/'));
    const corrected = join(correctionCheckout, ...path.split('/'));
    const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--', baseline, corrected], {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs,
    });
    if (diff.status !== 0 && diff.status !== 1) throw new Error(`Unable to capture applied diff for ${path}`);
    return diff.stdout ?? '';
  }).join('');
}

function requiredCorrectionChecksPassed(config, results, registry) {
  const required = config.required_checks ?? [];
  const checks = new Map([
    ['setup', results.setup],
    ['build', results.build],
    ['declared_test', results.declaredTest],
    ['browser_smoke', results.browser],
  ]);
  if (results.browser?.server_evidence_id) {
    const serverRecord = registry.records.find(record => record.evidence_id === results.browser.server_evidence_id);
    checks.set('server', serverRecord?.outcome === 'passed' ? { outcome: 'passed' } : { outcome: 'failed' });
  }
  if (required.length === 0) return results.build?.outcome === 'passed';
  return required.every(check => checks.get(check)?.outcome === 'passed');
}

function applyAndVerifyPatch({ patch, checkout, config, registry, timeoutMs, scratch }) {
  if (typeof patch !== 'string' || patch.length === 0) throw new Error('Correction verification requires a patch');
  const patchHash = sha256(patch);
  let correctionCheckout;
  try {
    correctionCheckout = cloneCorrectionCheckout(checkout, scratch);
  } catch (error) {
    const evidenceId = captureEvidence(registry, {
      type: 'correction_verification', action: 'controller_execution', operation: 'correction_verification',
      patch_hash: patchHash, patch, outcome: 'failed', execution_verified: false,
      observation: error.message, error: errorRecord(error),
    });
    return { evidence_id: evidenceId, outcome: 'failed', exit_code: 1, patch_hash: patchHash, error: error.message };
  }
  const correctionPatchPath = join(correctionCheckout, '.controller-proposed.patch');
  writeFileSync(correctionPatchPath, patch, { mode: 0o600 });
  const check = spawnSync('git', ['-C', correctionCheckout, 'apply', '--check', correctionPatchPath], { encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs });
  const checkOutput = redactEvidenceText(`${check.stdout ?? ''}${check.stderr ?? ''}`);
  if (check.status !== 0) {
    const evidenceId = captureEvidence(registry, { type: 'patch_validation', action: 'patch_check', operation: 'correction_verification', command: `git -C ${correctionCheckout} apply --check ${correctionPatchPath}`, exit_code: check.status ?? 1, stdout: checkOutput, patch_hash: patchHash, patch, outcome: 'failed', execution_verified: true });
    rmSync(correctionPatchPath, { force: true });
    return { evidence_id: evidenceId, outcome: 'failed', exit_code: check.status ?? 1, patch_hash: patchHash, stderr: checkOutput };
  }
  const applied = spawnSync('git', ['-C', correctionCheckout, 'apply', correctionPatchPath], { encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs });
  if (applied.status !== 0) {
    const output = redactEvidenceText(`${applied.stdout ?? ''}${applied.stderr ?? ''}`);
    const evidenceId = captureEvidence(registry, { type: 'patch_validation', action: 'patch_apply', operation: 'correction_verification', command: `git -C ${correctionCheckout} apply ${correctionPatchPath}`, exit_code: applied.status ?? 1, stdout: output, patch_hash: patchHash, patch, outcome: 'failed', execution_verified: true });
    rmSync(correctionPatchPath, { force: true });
    return { evidence_id: evidenceId, outcome: 'failed', exit_code: applied.status ?? 1, patch_hash: patchHash, stderr: output };
  }
  rmSync(correctionPatchPath, { force: true });
  const appliedDiff = captureAppliedDiff(checkout, correctionCheckout, patch, timeoutMs);
  const setup = config.setup ? runCommand({ operation: 'correction_setup', spec: config.setup, checkout: correctionCheckout, registry, timeoutMs }) : null;
  const build = config.build && (!setup || setup.outcome === 'passed')
    ? runCommand({ operation: 'correction_build', spec: config.build, checkout: correctionCheckout, registry, timeoutMs }) : null;
  const declaredTest = config.declared_test && (!setup || setup.outcome === 'passed') && (!build || build.outcome === 'passed')
    ? runCommand({ operation: 'correction_declared_test', spec: config.declared_test, checkout: correctionCheckout, registry, timeoutMs }) : null;
  const browser = config.browser_smoke && build?.outcome === 'passed'
    ? runBrowserSmoke({ spec: config.browser_smoke, checkout: correctionCheckout, registry, timeoutMs }) : null;
  const passed = requiredCorrectionChecksPassed(config, { setup, build, declaredTest, browser }, registry);
  const evidenceId = captureEvidence(registry, {
    type: 'runner_execution', action: 'correction_verification', operation: 'correction_verification',
    patch_hash: patchHash, patch, applied_diff: appliedDiff, applied_diff_hash: sha256(appliedDiff),
    setup_evidence_id: setup?.evidence_id ?? null, build_evidence_id: build?.evidence_id ?? null, declared_test_evidence_id: declaredTest?.evidence_id ?? null,
    server_evidence_id: browser?.server_evidence_id ?? null, browser_evidence_id: browser?.evidence_id ?? null,
    outcome: passed ? 'passed' : 'failed',
    execution_verified: true, exit_code: passed ? 0 : 1,
  });
  return { evidence_id: evidenceId, outcome: passed ? 'passed' : 'failed', exit_code: passed ? 0 : 1, patch_hash: patchHash, applied_diff_hash: sha256(appliedDiff), setup_evidence_id: setup?.evidence_id, build_evidence_id: build?.evidence_id, declared_test_evidence_id: declaredTest?.evidence_id, server_evidence_id: browser?.server_evidence_id, browser_evidence_id: browser?.evidence_id };
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
      if (typeof spec.server.ready_url !== 'string' || !/^https?:\/\//i.test(spec.server.ready_url)) throw new Error('Browser server requires an http(s) ready_url');
    }
  }
  return config;
}

export function loadRunnerConfig(path) {
  const config = validateConfig(JSON.parse(readFileSync(path, 'utf8')));
  requiredChecksForConfig(config);
  return config;
}

export function createApprovedRunner({ config, registry, scratch, timeoutMs = 120000 }) {
  validateConfig(config);
  let setupResult = null;
  return ({ operation, checkout, patch }) => {
    if (operation === 'correction_verification') {
      const evidenceId = captureEvidence(registry, {
        type: 'controller_validation',
        action: 'policy_gate',
        operation,
        outcome: 'rejected',
        execution_verified: false,
        observation: 'Correction execution is disabled at the approved runner boundary; no patch was applied.',
      });
      return { evidence_id: evidenceId, outcome: 'rejected', exit_code: null, execution_verified: false };
    }
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
