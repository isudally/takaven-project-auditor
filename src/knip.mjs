import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { captureEvidence, redactEvidenceText } from './evidence.mjs';

export const KNIP_VERSION = '6.42.0';
export const KNIP_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
export const NPM_CI_TIMEOUT_MS = 15 * 60 * 1000;
export const KNIP_ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_LOCKFILE_BYTES = 10 * 1024 * 1024;
export const MAX_LOCKFILE_PACKAGES = 2500;
export const MAX_NODE_MODULES_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ANALYZER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_FILES = 100_000;
const MAX_PROMPT_FINDINGS = 40;
const MAX_PROMPT_FINDING_CHARS = 12_000;
const LOOPBACK_DATABASE_URL = 'postgresql://takaven_static:takaven_static@127.0.0.1:1/takaven_static';

export function summarizeKnipFindings(findings = []) {
  const counts = {};
  for (const finding of findings) counts[finding.category] = (counts[finding.category] ?? 0) + 1;
  const priority = category => category === 'unlisted' ? 0 : category === 'dependencies' ? 1 : category === 'devDependencies' ? 2 : 3;
  const ordered = [...findings].sort((a, b) => priority(a.category) - priority(b.category) || String(a.file).localeCompare(String(b.file)) || String(a.name).localeCompare(String(b.name)));
  const sample = [];
  let serializedChars = 0;
  for (const finding of ordered) {
    if (sample.length >= MAX_PROMPT_FINDINGS) break;
    const compact = {
      category: String(finding.category ?? '').slice(0, 80),
      file: String(finding.file ?? '').slice(0, 300),
      name: String(finding.name ?? '').slice(0, 200),
      details: JSON.stringify(finding).slice(0, 160),
    };
    const entryChars = JSON.stringify(compact).length;
    if (serializedChars + entryChars > MAX_PROMPT_FINDING_CHARS) break;
    sample.push(compact);
    serializedChars += entryChars;
  }
  return { total_findings: findings.length, findings_by_category: counts, sample, sample_truncated: sample.length < findings.length };
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function boundedText(value) {
  return redactEvidenceText(String(value ?? '').slice(0, MAX_ANALYZER_OUTPUT_BYTES));
}

function npmEnvironment(scratch) {
  const userNpmConfig = join(scratch, 'knip-user.npmrc');
  const globalNpmConfig = join(scratch, 'knip-global.npmrc');
  writeFileSync(userNpmConfig, 'registry=https://registry.npmjs.org/\n', { mode: 0o600 });
  writeFileSync(globalNpmConfig, '\n', { mode: 0o600 });
  const env = {
    CI: 'true',
    NODE_ENV: 'test',
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NPM_CONFIG_USERCONFIG: userNpmConfig,
    NPM_CONFIG_GLOBALCONFIG: globalNpmConfig,
    NPM_CONFIG_CACHE: join(scratch, 'npm-cache'),
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  };
  return env;
}

function windowsCommandQuote(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

function npmInvocation(args, env, platform) {
  if (platform !== 'win32') return { file: 'npm', args };
  const commandLine = ['npm.cmd', ...args].map(windowsCommandQuote).join(' ');
  const comspec = env.ComSpec || 'cmd.exe';
  return { file: comspec, args: ['/d', '/s', '/c', commandLine] };
}

function runProcess(run, file, args, options, platform) {
  const invocation = file === 'npm'
    ? npmInvocation(args, options.env, platform)
    : { file, args };
  return run(invocation.file, invocation.args, options);
}

function classifyNpmrc(checkout) {
  const path = join(checkout, '.npmrc');
  if (!existsSync(path)) return null;
  const contents = readFileSync(path, 'utf8');
  if (/(?:_auth|authToken|password|certfile|keyfile|registry)\s*=/i.test(contents)) {
    return 'Project .npmrc contains authentication or registry configuration; dependency preparation was not started.';
  }
  return 'Project .npmrc is present; dependency preparation was not started to avoid inheriting repository-specific npm configuration.';
}

function inspectProject(checkout) {
  const packagePath = join(checkout, 'package.json');
  const lockPath = join(checkout, 'package-lock.json');
  if (!existsSync(packagePath)) return { reason: 'Root package.json is required.' };
  if (!existsSync(lockPath)) return { reason: 'Root package-lock.json is required for the supported npm dependency-backed analysis.' };
  let packageJson;
  try { packageJson = JSON.parse(readFileSync(packagePath, 'utf8')); } catch { return { reason: 'Root package.json is not valid JSON.' }; }
  const packageManager = packageJson.packageManager;
  if (packageManager && !/^npm@/i.test(packageManager)) return { reason: 'Only npm projects are supported by this Knip path.' };
  const lockStat = statSync(lockPath);
  if (lockStat.size > MAX_LOCKFILE_BYTES) return { reason: `package-lock.json is ${lockStat.size} bytes; the controller limit is ${MAX_LOCKFILE_BYTES} bytes.` };
  let lock;
  try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return { reason: 'package-lock.json is not valid JSON.' }; }
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    return { reason: 'Only npm lockfile versions 2 and 3 with a packages table are supported.' };
  }
  const packageCount = Object.keys(lock.packages).length;
  if (packageCount > MAX_LOCKFILE_PACKAGES) return { reason: `package-lock.json has ${packageCount} package entries; the controller limit is ${MAX_LOCKFILE_PACKAGES}.` };
  const codePresent = containsJavaScriptOrTypeScript(checkout);
  if (!codePresent) return { reason: 'No JavaScript or TypeScript source files were found in the supported project tree.' };
  const npmrcReason = classifyNpmrc(checkout);
  if (npmrcReason) return { reason: npmrcReason };
  return { packageCount, lockfileBytes: lockStat.size, packageJson };
}

function containsJavaScriptOrTypeScript(root) {
  const stack = [root];
  let visited = 0;
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > MAX_SOURCE_FILES) return false;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!['.git', 'node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) stack.push(join(directory, entry.name));
      } else if (/\.(?:[cm]?[jt]sx?)$/i.test(entry.name) && entry.name !== 'package-lock.json') return true;
    }
  }
  return false;
}

function directoryBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) total += lstatSync(path).size;
      if (total > MAX_NODE_MODULES_BYTES) return total;
    }
  }
  return total;
}

function removeTargetEnvironmentFiles(checkout) {
  const root = realpathSync(checkout);
  const stack = [root];
  let removed = 0;
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (/^\.env(?:\..*)?$/i.test(entry.name)) { unlinkSync(path); removed++; }
      } else if (entry.isDirectory()) {
        if (!['.git', 'node_modules'].includes(entry.name)) stack.push(path);
      } else if (entry.isFile() && /^\.env(?:\..*)?$/i.test(entry.name)) {
        unlinkSync(path);
        removed++;
      }
    }
  }
  return removed;
}

function parseKnipOutput(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { throw new Error('Knip JSON reporter output was malformed.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.issues)) throw new Error('Knip JSON reporter output did not contain an issues array.');
  const findings = [];
  for (const group of value.issues) {
    if (!group || typeof group !== 'object' || Array.isArray(group) || typeof group.file !== 'string') throw new Error('Knip JSON reporter contained an invalid file group.');
    for (const [category, items] of Object.entries(group)) {
      if (category === 'file' || category === 'owners') continue;
      if (!Array.isArray(items)) throw new Error(`Knip JSON reporter category ${category} was not an array.`);
      for (const item of items) {
        if (!item || typeof item !== 'object' || typeof item.name !== 'string') throw new Error(`Knip JSON reporter category ${category} contained an invalid finding.`);
        findings.push({ category, file: group.file, ...item });
      }
    }
  }
  return { raw: value, findings };
}

function recordResult(registry, { source, commit, state, details = {}, executionVerified = false }) {
  const safeDetails = {
    analyzer: 'knip',
    analyzer_version: KNIP_VERSION,
    source,
    commit,
    state,
    execution_verified: executionVerified,
    ...details,
  };
  const evidenceId = captureEvidence(registry, { type: 'analyzer_execution', action: 'knip_analysis', ...safeDetails });
  return { state, evidence_id: evidenceId, analyzer: 'knip', version: KNIP_VERSION, finding_count: details.finding_count ?? 0 };
}

export function runKnip({ checkout, scratch, source, commit, registry, trustedTarget = false, syntheticDatabaseUrl = false, run = spawnSync, platform = process.platform } = {}) {
  if (!checkout || !scratch || !source || !commit || !registry) throw new Error('Knip requires a checkout, scratch path, source, commit and evidence registry.');
  if (!trustedTarget) return recordResult(registry, {
    source, commit, state: 'INCOMPLETE', executionVerified: false,
    details: { reason: 'UNTRUSTED_TARGET: Knip was requested without explicit owner-trusted-target authorization; no dependency install or analyzer execution occurred.', dependency_preparation: 'not_started', execution_authorization: 'not_executed', host_isolation: 'not_claimed' },
  });

  const project = inspectProject(checkout);
  if (project.reason) return recordResult(registry, {
    source, commit, state: 'INCOMPLETE', executionVerified: false,
    details: { reason: project.reason, dependency_preparation: 'not_started', execution_authorization: 'explicit_owner_trust', host_isolation: 'not_claimed' },
  });

  const excludedEnvironmentFiles = removeTargetEnvironmentFiles(checkout);

  const toolDir = join(scratch, 'knip-tool');
  mkdirSync(toolDir, { recursive: true });
  const env = npmEnvironment(scratch);
  const installStarted = Date.now();
  const toolInstall = runProcess(run, 'npm', ['install', '--prefix', toolDir, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', `knip@${KNIP_VERSION}`], {
    cwd: scratch, env, encoding: 'utf8', timeout: KNIP_INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_ANALYZER_OUTPUT_BYTES,
  }, platform);
  const toolInstallMs = Date.now() - installStarted;
  const toolPackage = join(toolDir, 'node_modules', 'knip', 'package.json');
  if (toolInstall.error || toolInstall.status !== 0 || !existsSync(toolPackage)) return recordResult(registry, {
    source, commit, state: 'TOOL_FAILURE', executionVerified: false,
    details: { reason: toolInstall.error?.message ?? 'Pinned Knip installation did not complete.', dependency_preparation: 'not_started', install_exit_code: toolInstall.status ?? null, install_duration_ms: toolInstallMs, install_stdout: boundedText(toolInstall.stdout), install_stderr: boundedText(toolInstall.stderr), install_stdout_hash: sha256(toolInstall.stdout ?? ''), install_stderr_hash: sha256(toolInstall.stderr ?? ''), execution_authorization: 'explicit_owner_trust', host_isolation: 'not_claimed' },
  });
  let installedVersion;
  try { installedVersion = JSON.parse(readFileSync(toolPackage, 'utf8')).version; } catch { installedVersion = null; }
  if (installedVersion !== KNIP_VERSION) return recordResult(registry, {
    source, commit, state: 'TOOL_FAILURE', executionVerified: false,
    details: { reason: `Knip version mismatch: requested ${KNIP_VERSION}; observed ${installedVersion ?? 'unreadable'}.`, dependency_preparation: 'not_started', install_exit_code: toolInstall.status, install_duration_ms: toolInstallMs, execution_authorization: 'explicit_owner_trust', host_isolation: 'not_claimed' },
  });

  const dependencyStarted = Date.now();
  const dependencyInstall = runProcess(run, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: checkout, env, encoding: 'utf8', timeout: NPM_CI_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_ANALYZER_OUTPUT_BYTES,
  }, platform);
  const dependencyDurationMs = Date.now() - dependencyStarted;
  const dependencyStdout = boundedText(dependencyInstall.stdout);
  const dependencyStderr = boundedText(dependencyInstall.stderr);
  if (dependencyInstall.error || dependencyInstall.status !== 0) return recordResult(registry, {
    source, commit, state: 'INCOMPLETE', executionVerified: false,
    details: { reason: dependencyInstall.error?.message ?? 'npm ci did not complete successfully.', dependency_preparation: 'failed', dependency_exit_code: dependencyInstall.status ?? null, dependency_duration_ms: dependencyDurationMs, dependency_stdout: dependencyStdout, dependency_stderr: dependencyStderr, dependency_stdout_hash: sha256(dependencyInstall.stdout ?? ''), dependency_stderr_hash: sha256(dependencyInstall.stderr ?? ''), execution_authorization: 'explicit_owner_trust', host_isolation: 'not_claimed' },
  });

  const nodeModules = join(checkout, 'node_modules');
  if (!existsSync(nodeModules)) return recordResult(registry, {
    source, commit, state: 'INCOMPLETE', executionVerified: false,
    details: { reason: 'npm ci succeeded but did not create node_modules.', dependency_preparation: 'completed_without_node_modules', dependency_exit_code: 0, dependency_duration_ms: dependencyDurationMs, execution_authorization: 'explicit_owner_trust', host_isolation: 'not_claimed' },
  });
  let dependencyBytes;
  try { dependencyBytes = directoryBytes(nodeModules); } catch (error) { return recordResult(registry, {
    source, commit, state: 'INCOMPLETE', executionVerified: false,
    details: { reason: `Could not measure disposable node_modules footprint: ${error.message}`, dependency_preparation: 'completed_footprint_unavailable', dependency_exit_code: 0, dependency_duration_ms: dependencyDurationMs, execution_authorization: 'explicit_owner_trust', host_isolation: 'not_claimed' },
  }); }
  if (dependencyBytes > MAX_NODE_MODULES_BYTES) return recordResult(registry, {
    source, commit, state: 'INCOMPLETE', executionVerified: false,
    details: { reason: `node_modules is ${dependencyBytes} bytes; the controller limit is ${MAX_NODE_MODULES_BYTES} bytes.`, dependency_preparation: 'completed_resource_bound_exceeded', dependency_bytes: dependencyBytes, dependency_exit_code: 0, dependency_duration_ms: dependencyDurationMs, execution_authorization: 'explicit_owner_trust', host_isolation: 'not_claimed' },
  });

  const knipPackage = JSON.parse(readFileSync(toolPackage, 'utf8'));
  const bin = typeof knipPackage.bin === 'string' ? knipPackage.bin : knipPackage.bin?.knip;
  if (typeof bin !== 'string') return recordResult(registry, {
    source, commit, state: 'TOOL_FAILURE', executionVerified: false,
    details: { reason: 'Pinned Knip package did not declare its CLI entry point.', dependency_preparation: 'completed', dependency_bytes: dependencyBytes, execution_authorization: 'explicit_owner_trust', host_isolation: 'not_claimed' },
  });
  const knipEntrypoint = resolve(toolDir, 'node_modules', 'knip', bin);
  if (!knipEntrypoint.startsWith(`${resolve(toolDir)}${process.platform === 'win32' ? '\\' : '/'}`) || !existsSync(knipEntrypoint)) return recordResult(registry, {
    source, commit, state: 'TOOL_FAILURE', executionVerified: false,
    details: { reason: 'Knip CLI entry point is missing or escapes the temporary tool directory.', dependency_preparation: 'completed', dependency_bytes: dependencyBytes, execution_authorization: 'explicit_owner_trust', host_isolation: 'not_claimed' },
  });

  const analysisStarted = Date.now();
  const analysisEnv = syntheticDatabaseUrl ? { ...env, DATABASE_URL: LOOPBACK_DATABASE_URL } : env;
  const analysis = run(process.execPath, [knipEntrypoint, '--reporter', 'json', '--no-progress'], {
    cwd: checkout, env: analysisEnv, encoding: 'utf8', timeout: KNIP_ANALYSIS_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_ANALYZER_OUTPUT_BYTES,
  });
  const analysisDurationMs = Date.now() - analysisStarted;
  const stdout = boundedText(analysis.stdout);
  const stderr = boundedText(analysis.stderr);
  const baseDetails = {
    dependency_preparation: 'completed',
    target_environment_files_excluded: excludedEnvironmentFiles,
    dependency_exit_code: 0,
    dependency_duration_ms: dependencyDurationMs,
    dependency_bytes: dependencyBytes,
    install_duration_ms: toolInstallMs,
    command: ['node', basename(knipEntrypoint), '--reporter', 'json', '--no-progress'],
    analysis_duration_ms: analysisDurationMs,
    exit_code: analysis.status ?? null,
    stdout,
    stderr,
    stdout_hash: sha256(analysis.stdout ?? ''),
    stderr_hash: sha256(analysis.stderr ?? ''),
    execution_authorization: 'explicit_owner_trust',
    host_isolation: 'not_claimed',
  };
  if (analysis.error || analysis.signal || analysis.status === null) return recordResult(registry, {
    source, commit, state: 'TOOL_FAILURE', executionVerified: false,
    details: { ...baseDetails, reason: analysis.error?.message ?? `Knip process ended by ${analysis.signal ?? 'unknown signal'}.` },
  });
  let parsed;
  try { parsed = parseKnipOutput(analysis.stdout ?? ''); } catch (error) {
    const configError = /config(?:uration)?|failed to load|could not load|cannot load/i.test(`${stderr}\n${error.message}`);
    return recordResult(registry, {
      source, commit, state: configError ? 'INCOMPLETE' : 'TOOL_FAILURE', executionVerified: false,
      details: { ...baseDetails, reason: error.message, configuration_incomplete: configError },
    });
  }
  if (analysis.status === 2 || /(?:failed|unable|cannot|could not) (?:to )?(?:load|resolve).*config|configuration (?:error|failed)/i.test(stderr)) return recordResult(registry, {
    source, commit, state: 'INCOMPLETE', executionVerified: false,
    details: { ...baseDetails, reason: 'Knip reported a project configuration-loading failure.', configuration_incomplete: true, structured_findings: parsed.findings, finding_count: parsed.findings.length },
  });
  if (![0, 1].includes(analysis.status) || (analysis.status === 1 && parsed.findings.length === 0)) return recordResult(registry, {
    source, commit, state: 'TOOL_FAILURE', executionVerified: false,
    details: { ...baseDetails, reason: `Unexpected Knip exit code ${analysis.status}.`, structured_findings: parsed.findings, finding_count: parsed.findings.length },
  });
  const state = parsed.findings.length ? 'FINDINGS_PRESENT' : 'PASS_NO_FINDINGS';
  return recordResult(registry, {
    source, commit, state, executionVerified: true,
    details: { ...baseDetails, structured_findings: parsed.findings, finding_count: parsed.findings.length },
  });
}
