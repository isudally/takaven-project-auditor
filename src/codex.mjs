import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CODEX_ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'CODEX_HOME', 'LANG', 'LC_ALL', 'CI', 'TERM', 'TERM_PROGRAM'
];

export function codexEnvironment(source = process.env) {
  const env = {};
  for (const key of CODEX_ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

export function configuredTimeout() {
  const raw = process.env.TAKAVEN_CODEX_TIMEOUT_MS;
  if (raw === undefined) return 10 * 60 * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100) throw new Error('TAKAVEN_CODEX_TIMEOUT_MS must be an integer of at least 100 milliseconds');
  return value;
}

export function createScratch() {
  const base = process.env.TAKAVEN_SCRATCH_ROOT ? resolve(process.env.TAKAVEN_SCRATCH_ROOT) : tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'takaven-audit-'));
}

export function buildCodexArgs({ mode, schema, responsePath, ignoreUserConfig = true, outputLastMessage = false }) {
  const args = [
    'exec',
    '--sandbox', mode === 'inspect' ? 'read-only' : 'workspace-write',
    '--ephemeral',
  ];
  if (ignoreUserConfig) args.push('--ignore-user-config');
  args.push('--ignore-rules', '--skip-git-repo-check');
  if (schema) args.push('--output-schema', schema);
  if (outputLastMessage) args.push('--output-last-message', responsePath);
  else args.push('-o', responsePath);
  args.push('-');
  return args;
}

function windowsCommandQuote(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function resolveCodexCommand(binary, args) {
  if (/\.(?:cjs|mjs|js)$/i.test(binary)) {
    return { file: process.execPath, args: [binary, ...args] };
  }
  if (process.platform === 'win32' && (binary.toLowerCase().endsWith('.cmd') || !/[\\/]/.test(binary))) {
    const commandPath = /[\\/]/.test(binary)
      ? binary
      : (() => {
        const located = spawnSync('where.exe', [`${binary.replace(/\.cmd$/i, '')}.cmd`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return located.status === 0 ? located.stdout.split(/\r?\n/).find(Boolean)?.trim() : null;
      })();
    if (commandPath && existsSync(commandPath)) {
      const commandLine = [commandPath, ...args].map(windowsCommandQuote).join(' ');
      return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', commandLine] };
    }
  }
  return { file: binary, args };
}

function terminateProcessTree(agent) {
  if (!agent?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(agent.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, detached: true });
    killer.unref();
    try { agent.kill(); } catch {}
  } else {
    try { process.kill(-agent.pid, 'SIGTERM'); } catch { try { agent.kill('SIGTERM'); } catch {} }
    setTimeout(() => {
      try { process.kill(-agent.pid, 'SIGKILL'); } catch { try { agent.kill('SIGKILL'); } catch {} }
    }, 750).unref();
  }
}

export function runCodex({ binary, args, cwd, prompt, timeoutMs, ignoreEnvironment = false }) {
  const resolved = resolveCodexCommand(binary, args);
  const startedAt = new Date().toISOString();
  const startedClock = Date.now();
  return new Promise((resolveRun, rejectRun) => {
    let agent;
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer;
    let forceTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      callback(value);
    };
    const metadata = (overrides = {}) => ({
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      duration_ms: Date.now() - startedClock,
      executable: resolved.file,
      arguments: resolved.args,
      cwd,
      started: Boolean(agent?.pid),
      stderr: stderr.slice(-5000),
      ...overrides,
    });
    try {
      agent = spawn(resolved.file, resolved.args, {
        cwd,
        env: ignoreEnvironment ? process.env : codexEnvironment(),
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'ignore', 'pipe']
      });
    } catch (error) {
      finish(rejectRun, Object.assign(new Error(`Codex launch failed: ${error.message}`), metadata({
        classification: 'DIRECT_AGENT_ENVIRONMENT_BLOCKED',
        error_code: error.code ?? null,
        exit_code: null,
      })));
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(agent);
      forceTimer = setTimeout(() => terminateProcessTree(agent), 1000);
    }, timeoutMs);
    agent.stderr.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    agent.on('error', error => finish(rejectRun, Object.assign(new Error(`Codex launch failed: ${error.message}`), metadata({
      classification: 'DIRECT_AGENT_ENVIRONMENT_BLOCKED',
      error_code: error.code ?? null,
      exit_code: null,
    }))));
    agent.on('close', code => {
      if (timedOut) {
        finish(rejectRun, Object.assign(new Error(`Codex timed out after ${timeoutMs}ms`), metadata({
          classification: 'DIRECT_AGENT_TIMEOUT', exit_code: code,
        })));
      } else if (code !== 0) {
        finish(rejectRun, Object.assign(new Error(`Codex exited ${code}: ${stderr.slice(-1200)}`), metadata({
          classification: 'DIRECT_AGENT_EXECUTION_FAILED', exit_code: code,
        })));
      } else {
        finish(resolveRun, metadata({ exit_code: 0 }));
      }
    });
    agent.stdin.on('error', () => {});
    agent.stdin.end(prompt);
  });
}

export function preflightCodex(binary = 'codex', timeoutMs = 30000) {
  const resolved = resolveCodexCommand(binary, ['--version']);
  const result = spawnSync(resolved.file, resolved.args, {
    encoding: 'utf8', timeout: timeoutMs, cwd: process.cwd(),
    env: codexEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const error = result.error;
  return {
    executable: resolved.file,
    arguments: resolved.args,
    version: (result.stdout || '').trim().split(/\r?\n/)[0] || null,
    exit_code: error ? null : result.status,
    error: error ? error.message : (result.stderr || '').trim().slice(-1200) || null,
    ok: !error && result.status === 0,
    classification: error ? 'DIRECT_AGENT_ENVIRONMENT_BLOCKED' : result.status === 0 ? null : 'DIRECT_AGENT_PREFLIGHT_FAILED',
  };
}
