import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, openSync, closeSync, existsSync, realpathSync, mkdirSync, rmSync, lstatSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { captureEvidence, redactEvidenceText } from './evidence.mjs';

const ALLOWED_EXECUTABLES = new Set(['node', 'npm', 'npx', 'python', 'python3', 'pnpm', 'yarn', 'go', 'cargo', 'pytest']);
const WINDOWS_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn']);
const SENSITIVE_ENV = /(?:token|secret|password|private|credential|api[_-]?key)/i;
const COMMAND_OPERATIONS = ['setup', 'build', 'declared_test', 'server', 'browser_smoke'];
export const ACCEPTANCE_OPERATIONS = ['build', 'declared_test', 'browser_smoke'];
const BROWSER_ASSERTION_MAX_BYTES = 4096;
const BROWSER_ASSERTION_KEYS = ['execution_id', 'ui_passed', 'version'];
const EXPERIMENT_ASSERTION_MAX_BYTES = 16 * 1024;
const EXPERIMENT_ASSERTION_KEYS = ['execution_id', 'falsification_passed', 'hypothesis_supported', 'negative_control_passed', 'observations', 'positive_control_passed', 'version'];
const EXPERIMENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export function requiredChecksForConfig(config) {
  const configured = [
    ...ACCEPTANCE_OPERATIONS.filter(operation => Boolean(config?.[operation])),
    ...Object.keys(config?.experiment_specs ?? {}).map(name => `experiment_spec:${name}`),
  ];
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

function runnerEnv(config, extra = {}) {
  const env = { CI: 'true', PATH: process.env.PATH, Path: process.env.Path, NODE_ENV: 'test' };
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || SENSITIVE_ENV.test(key) || typeof value !== 'string') throw new Error(`Runner environment variable is not allowed: ${key}`);
    env[key] = value;
  }
  Object.assign(env, extra);
  return env;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function errorRecord(error) {
  if (!error) return null;
  return { name: error.name, code: error.code, message: error.message, errno: error.errno, syscall: error.syscall };
}

function validateBrowserAssertionConfig(assertion) {
  if (assertion === undefined) return;
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) throw new Error('Browser assertion must be an object');
  const keys = Object.keys(assertion).sort();
  if (keys.length !== 1 || keys[0] !== 'path') throw new Error('Browser assertion must contain only path');
  if (typeof assertion.path !== 'string' || assertion.path.length === 0 || assertion.path.length > 260 || assertion.path.includes('\0')) throw new Error('Browser assertion path is invalid');
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(assertion.path) || assertion.path.split(/[\\/]/).some(part => part === '..' || part === '')) throw new Error('Browser assertion path must be relative and traversal-free');
}

function validateExperimentAssertionConfig(assertion) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) throw new Error('Experiment assertion is required');
  const keys = Object.keys(assertion).sort();
  if (keys.length !== 1 || keys[0] !== 'path') throw new Error('Experiment assertion must contain only path');
  if (typeof assertion.path !== 'string' || assertion.path.length === 0 || assertion.path.length > 260 || assertion.path.includes('\0')) throw new Error('Experiment assertion path is invalid');
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(assertion.path) || assertion.path.split(/[\\/]/).some(part => part === '..' || part === '')) throw new Error('Experiment assertion path must be relative and traversal-free');
}

function validateExperimentSpecs(experimentSpecs) {
  if (experimentSpecs === undefined) return [];
  if (!experimentSpecs || typeof experimentSpecs !== 'object' || Array.isArray(experimentSpecs)) throw new Error('Runner experiment_specs must be an object');
  const names = Object.keys(experimentSpecs);
  if (names.length === 0 || names.length > 8) throw new Error('Runner experiment_specs must contain 1-8 named experiments');
  for (const name of names) {
    if (!EXPERIMENT_NAME.test(name)) throw new Error(`Runner experiment name is invalid: ${name}`);
    const spec = experimentSpecs[name];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`Runner experiment spec is invalid: ${name}`);
    validateCommand(spec.command, `experiment_specs.${name}`);
    runnerEnv(spec);
    if (spec.cwd !== undefined && typeof spec.cwd !== 'string') throw new Error(`Runner cwd must be a string for experiment ${name}`);
    validateExperimentAssertionConfig(spec.assertion);
  }
  return names;
}

function prepareBrowserAssertion(checkout, spec) {
  validateBrowserAssertionConfig(spec.assertion);
  if (!spec.assertion) return null;
  const root = realpathSync(checkout);
  const relativePath = spec.assertion.path.replaceAll('\\', '/');
  const absolutePath = resolve(root, relativePath);
  const parent = dirname(absolutePath);
  mkdirSync(parent, { recursive: true });
  const realParent = realpathSync(parent);
  if (realParent !== root && !realParent.startsWith(`${root}${sep}`)) throw new Error('Browser assertion path escapes checkout through a symlink');
  if (existsSync(absolutePath)) {
    const existing = lstatSync(absolutePath);
    if (existing.isSymbolicLink()) throw new Error('Browser assertion path must not be a symlink');
    if (!existing.isFile()) throw new Error('Browser assertion path must identify a regular file');
    unlinkSync(absolutePath);
  }
  return { executionId: randomUUID(), relativePath, absolutePath };
}

function prepareExperimentAssertion(checkout, spec) {
  validateExperimentAssertionConfig(spec.assertion);
  const root = realpathSync(checkout);
  const relativePath = spec.assertion.path.replaceAll('\\', '/');
  const absolutePath = resolve(root, relativePath);
  const parent = dirname(absolutePath);
  mkdirSync(parent, { recursive: true });
  const realParent = realpathSync(parent);
  if (realParent !== root && !realParent.startsWith(`${root}${sep}`)) throw new Error('Experiment assertion path escapes checkout through a symlink');
  if (existsSync(absolutePath)) {
    const existing = lstatSync(absolutePath);
    if (existing.isSymbolicLink()) throw new Error('Experiment assertion path must not be a symlink');
    if (!existing.isFile()) throw new Error('Experiment assertion path must identify a regular file');
    unlinkSync(absolutePath);
  }
  return { executionId: randomUUID(), relativePath, absolutePath };
}

function writeExperimentSpecification(checkout, specification, executionId) {
  const root = realpathSync(checkout);
  const specPath = resolve(root, '.controller', 'experiment-spec.json');
  const specParent = dirname(specPath);
  mkdirSync(specParent, { recursive: true });
  const realParent = realpathSync(specParent);
  if (realParent !== root && !realParent.startsWith(`${root}${sep}`)) throw new Error('Experiment specification path escapes checkout through a symlink');
  const content = JSON.stringify({ version: 1, execution_id: executionId, ...specification }, null, 2);
  let descriptor;
  try {
    descriptor = openSync(specPath, 'wx', 0o600);
    writeFileSync(descriptor, content, { encoding: 'utf8' });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return specPath;
}

function readBrowserAssertion(context) {
  if (!context) return { status: 'not_configured', error: 'No controller-configured UI assertion was provided.' };
  if (!existsSync(context.absolutePath)) return { status: 'missing', error: 'Controller-configured UI assertion was not produced.' };
  const stat = lstatSync(context.absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) return { status: 'invalid', error: 'Controller-configured UI assertion is not a regular file.' };
  if (stat.size > BROWSER_ASSERTION_MAX_BYTES) return { status: 'invalid', error: `Controller-configured UI assertion exceeds ${BROWSER_ASSERTION_MAX_BYTES} bytes.` };
  const content = readFileSync(context.absolutePath);
  const fileHash = sha256(content);
  let value;
  try { value = JSON.parse(content.toString('utf8')); } catch { return { status: 'invalid', error: 'Controller-configured UI assertion is not valid JSON.', fileHash }; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(BROWSER_ASSERTION_KEYS)) {
    return { status: 'invalid', error: 'Controller-configured UI assertion has an unexpected schema.', fileHash };
  }
  if (value.version !== 1 || value.execution_id !== context.executionId || typeof value.ui_passed !== 'boolean') {
    return { status: 'invalid', error: 'Controller-configured UI assertion has an invalid version, execution ID or ui_passed value.', fileHash };
  }
  return { status: 'valid', executionId: value.execution_id, ui_passed: value.ui_passed, fileHash, bytes: content.byteLength };
}

function readExperimentAssertion(context) {
  if (!context) return { status: 'not_configured', error: 'No controller-configured experiment assertion was provided.' };
  if (!existsSync(context.absolutePath)) return { status: 'missing', error: 'Controller-configured experiment assertion was not produced.' };
  const stat = lstatSync(context.absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) return { status: 'invalid', error: 'Controller-configured experiment assertion is not a regular file.' };
  if (stat.size > EXPERIMENT_ASSERTION_MAX_BYTES) return { status: 'invalid', error: `Controller-configured experiment assertion exceeds ${EXPERIMENT_ASSERTION_MAX_BYTES} bytes.` };
  const content = readFileSync(context.absolutePath);
  const fileHash = sha256(content);
  let value;
  try { value = JSON.parse(content.toString('utf8')); } catch { return { status: 'invalid', error: 'Controller-configured experiment assertion is not valid JSON.', fileHash }; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EXPERIMENT_ASSERTION_KEYS)) {
    return { status: 'invalid', error: 'Controller-configured experiment assertion has an unexpected schema.', fileHash };
  }
  if (value.version !== 1 || value.execution_id !== context.executionId
    || typeof value.hypothesis_supported !== 'boolean'
    || typeof value.positive_control_passed !== 'boolean'
    || typeof value.negative_control_passed !== 'boolean'
    || typeof value.falsification_passed !== 'boolean'
    || !value.observations || typeof value.observations !== 'object' || Array.isArray(value.observations)) {
    return { status: 'invalid', error: 'Controller-configured experiment assertion has an invalid version, execution ID, control result or observations object.', fileHash };
  }
  return {
    status: 'valid', executionId: value.execution_id, hypothesis_supported: value.hypothesis_supported,
    positive_control_passed: value.positive_control_passed, negative_control_passed: value.negative_control_passed,
    falsification_passed: value.falsification_passed, observations: value.observations,
    fileHash, bytes: content.byteLength,
  };
}

function runCommand({ operation, spec, checkout, registry, timeoutMs, executionContext = null, check = null }) {
  validateCommand(spec.command, operation);
  const cwd = resolveWorkingDirectory(checkout, spec.cwd ?? '.');
  const requestedCommand = spec.command.map(item => expand(item, checkout));
  const invocation = resolveSpawnInvocation(requestedCommand[0], requestedCommand.slice(1));
  const executable = invocation.executable;
  const args = requestedCommand.slice(1);
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  const result = spawnSync(invocation.file, invocation.args, {
    cwd, env: runnerEnv(spec, executionContext?.env ?? {}), encoding: 'utf8', shell: false,
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
  const assertion = operation === 'browser_smoke' && !launchFailed && !timedOut
    ? readBrowserAssertion(executionContext?.assertion ?? null)
    : null;
  const experimentAssertion = operation === 'experiment_spec' && !launchFailed && !timedOut
    ? readExperimentAssertion(executionContext?.experimentAssertion ?? null)
    : null;
  let finalOutcome = timedOut ? 'timed_out' : launchFailed ? 'launch_failed' : exitCode === 0 ? 'passed' : 'failed';
  let finalObservation = launchFailed
    ? `Command failed to start: ${result.error?.code ?? 'unknown spawn error'}.`
    : timedOut ? `Command timed out after ${timeoutMs} ms.`
      : `Command started and exited with status ${exitCode}${signal ? ` (${signal})` : ''}.`;
  if (operation === 'browser_smoke' && !launchFailed && !timedOut) {
    if (assertion?.status === 'valid') {
      if (!assertion.ui_passed) {
        finalOutcome = 'failed';
        finalObservation = 'Browser execution completed, but the controller-configured UI assertion failed.';
      } else if (exitCode !== 0) {
        finalOutcome = 'partial';
        finalObservation = 'The controller-configured UI assertion passed, but the browser command exited unsuccessfully.';
      }
    } else if (exitCode === 0) {
      finalOutcome = 'partial';
      finalObservation = 'Browser execution completed successfully, but the controller did not obtain a valid UI assertion, so application behavior is not verified.';
    }
  }
  if (operation === 'experiment_spec' && !launchFailed && !timedOut) {
    if (experimentAssertion?.status !== 'valid') {
      if (exitCode === 0) {
        finalOutcome = 'partial';
        finalObservation = `Experiment execution completed successfully, but the controller did not obtain a valid experiment assertion: ${experimentAssertion?.error ?? 'unknown error'}`;
      }
    } else if (!experimentAssertion.positive_control_passed || !experimentAssertion.negative_control_passed || !experimentAssertion.falsification_passed) {
      finalOutcome = 'failed';
      finalObservation = 'Experiment assertion was captured, but one or more required controls or falsification checks failed.';
    }
  }
  const evidenceId = captureEvidence(registry, {
    type: 'runner_execution', action: 'approved_runner', operation, ...(check ? { check } : {}),
    command: [executable, ...args].join(' '), requested_command: requestedCommand.join(' '),
    executable, launcher: invocation.launcher, arguments: args, launcher_arguments: invocation.args, cwd, working_directory: cwd,
    started_at: startedAt, duration_ms: Math.round(durationMs), started,
    status: result.status ?? null, exit_code: exitCode, signal,
    spawn_error: errorRecord(result.error), stdout, stderr,
    stdout_hash: sha256(stdout), stderr_hash: sha256(stderr),
    outcome: finalOutcome, observation: finalObservation, execution_verified: started, timeout_ms: timeoutMs,
    ...(assertion ? {
      assertion_status: assertion.status,
      assertion_execution_id: assertion.executionId ?? executionContext?.assertion?.executionId ?? null,
      assertion_path: executionContext?.assertion?.relativePath ?? null,
      assertion_hash: assertion.fileHash ?? null,
      assertion_bytes: assertion.bytes ?? null,
      assertion_error: assertion.error ?? null,
      ui_passed: assertion.ui_passed,
    } : {}),
    ...(experimentAssertion ? {
      experiment_assertion_status: experimentAssertion.status,
      experiment_assertion_execution_id: experimentAssertion.executionId ?? executionContext?.experimentAssertion?.executionId ?? null,
      experiment_assertion_path: executionContext?.experimentAssertion?.relativePath ?? null,
      experiment_assertion_hash: experimentAssertion.fileHash ?? null,
      experiment_assertion_bytes: experimentAssertion.bytes ?? null,
      experiment_assertion_error: experimentAssertion.error ?? null,
      hypothesis_supported: experimentAssertion.hypothesis_supported,
      positive_control_passed: experimentAssertion.positive_control_passed,
      negative_control_passed: experimentAssertion.negative_control_passed,
      falsification_passed: experimentAssertion.falsification_passed,
      observations: experimentAssertion.observations,
      experiment_controls_passed: experimentAssertion.status === 'valid'
        && experimentAssertion.positive_control_passed
        && experimentAssertion.negative_control_passed
        && experimentAssertion.falsification_passed,
    } : {}),
  });
  return { evidence_id: evidenceId, outcome: finalOutcome, exit_code: exitCode, signal, started, duration_ms: Math.round(durationMs), stdout, stderr, executable, arguments: args, cwd, ui_passed: assertion?.ui_passed, experiment_assertion: experimentAssertion };
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

function runBrowserCommand({ spec, checkout, registry, timeoutMs }) {
  let assertion = null;
  try {
    assertion = prepareBrowserAssertion(checkout, spec);
  } catch (error) {
    return {
      evidence_id: captureEvidence(registry, {
        type: 'runner_execution', action: 'approved_runner', operation: 'browser_smoke',
        outcome: 'not_available',
        observation: `Browser check was not started because the controller could not prepare its assertion: ${error.message}`,
        execution_verified: false, assertion_status: 'invalid', assertion_error: error.message,
      }),
      outcome: 'not_available', exit_code: null,
    };
  }
  const executionContext = assertion ? {
    assertion,
    env: {
      TAKAVEN_BROWSER_EXECUTION_ID: assertion.executionId,
      TAKAVEN_BROWSER_ASSERTION_PATH: assertion.absolutePath,
    },
  } : null;
  return runCommand({ operation: 'browser_smoke', spec, checkout, registry, timeoutMs, executionContext });
}

function runBrowserSmoke({ spec, checkout, registry, timeoutMs }) {
  if (!spec.server) return runBrowserCommand({ spec, checkout, registry, timeoutMs });
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
    if (!ready) {
      browserResult = { evidence_id: captureEvidence(registry, { type: 'runner_execution', action: 'approved_runner', operation: 'browser_smoke', outcome: 'not_available', observation: 'Browser check was not started because the approved server was not ready.', execution_verified: false }), outcome: 'not_available', exit_code: null };
    } else {
      browserResult = runBrowserCommand({ spec, checkout, registry, timeoutMs });
    }
  } finally {
    terminateProcessTree(server);
  }
  return { ...browserResult, server_evidence_id: serverEvidenceId };
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
    if (operation === 'browser_smoke') {
      validateBrowserAssertionConfig(spec.assertion);
    }
    if (operation === 'browser_smoke' && spec.server) {
      validateCommand(spec.server.command, 'server');
      runnerEnv(spec.server);
      if (spec.server.cwd !== undefined && typeof spec.server.cwd !== 'string') throw new Error('Runner cwd must be a string for server');
      if (typeof spec.server.ready_url !== 'string' || !/^https?:\/\//i.test(spec.server.ready_url)) throw new Error('Browser server requires an http(s) ready_url');
    }
  }
  validateExperimentSpecs(config.experiment_specs);
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
  return ({ operation, checkout, patch, experiment, specification }) => {
    if (operation === 'experiment_spec') {
      const spec = config.experiment_specs?.[experiment];
      if (!spec) {
        const evidenceId = captureEvidence(registry, {
          type: 'runner_execution', action: 'approved_runner', operation,
          experiment, outcome: 'not_available', execution_verified: false,
          observation: `No controller-configured experiment named ${experiment} is available.`,
        });
        return { evidence_id: evidenceId, outcome: 'not_available', exit_code: null };
      }
      let assertion;
      try {
        assertion = prepareExperimentAssertion(checkout, spec);
        const specPath = writeExperimentSpecification(checkout, specification, assertion.executionId);
      } catch (error) {
        const evidenceId = captureEvidence(registry, {
          type: 'runner_execution', action: 'approved_runner', operation,
          experiment, outcome: 'not_available', execution_verified: false,
          observation: `Experiment was not started because the controller could not prepare its bounded input or assertion: ${error.message}`,
        });
        return { evidence_id: evidenceId, outcome: 'not_available', exit_code: null };
      }
      return runCommand({
        operation, check: `experiment_spec:${experiment}`, spec, checkout, registry, timeoutMs,
        executionContext: {
          experimentAssertion: assertion,
          env: {
            TAKAVEN_EXPERIMENT_SPEC_PATH: resolve(checkout, '.controller', 'experiment-spec.json'),
            TAKAVEN_EXPERIMENT_EXECUTION_ID: assertion.executionId,
            TAKAVEN_EXPERIMENT_ASSERTION_PATH: assertion.absolutePath,
          },
        },
      });
    }
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
