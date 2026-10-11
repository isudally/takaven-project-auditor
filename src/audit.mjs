#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { parseArgs, renderMarkdown, validateReport, applyTrustedMetadata, promptForRun } from './core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `TAKAVEN Project Auditor v0.1\n\nUsage:\n  node src/audit.mjs --repo https://github.com/owner/repo [--ref main] [--mode inspect|verify] [--out ./reports/project]\n  node src/audit.mjs --path /path/to/local/git/repo [--mode inspect|verify]\n\nModes:\n  inspect (default): code and architecture only; never executes repository code\n  verify: execute tests/builds where feasible in a disposable copy, with Codex sandbox enabled\n\nPrerequisites: Git, Node.js >=20, Codex CLI installed and authenticated.\n\nCAUTION: The verify mode may execute repository scripts. Use only with code you trust, preferably in a separate VM/container with no production secrets. The Codex sandbox is not a substitute for a dedicated security boundary.`;

function command(file, args, options={}) {
  const result=spawnSync(file,args,{encoding:'utf8',timeout:options.timeout??60000,cwd:options.cwd,env:process.env,stdio:['ignore','pipe','pipe']});
  if (result.error) throw result.error;
  if (result.status!==0) throw new Error(`${file} ${args[0]} failed: ${(result.stderr||result.stdout||'').slice(0,700)}`);
  return result.stdout.trim();
}

const CODEX_ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'CODEX_HOME', 'LANG', 'LC_ALL', 'CI', 'TERM', 'TERM_PROGRAM'
];

const SNAPSHOT_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next']);
const SNAPSHOT_SKIP_FILES = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|db))$/i;
const SNAPSHOT_MANIFEST_NAMES = new Set(['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'gemfile', 'mix.exs', 'pubspec.yaml', 'dockerfile', 'makefile', 'justfile']);
const SNAPSHOT_ENTRY_NAME = /^(?:index|main|app|server|cli|manage|run)\.[^.]+$/i;
const SNAPSHOT_SOURCE_EXTENSIONS = /\.(?:c|cc|cpp|cs|go|h|java|js|jsx|mjs|cjs|kt|php|py|rb|rs|swift|ts|tsx|vue|svelte)$/i;
const SNAPSHOT_TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'e2e']);
const SNAPSHOT_FLOW_SEGMENTS = new Set(['api', 'app', 'backend', 'config', 'contexts', 'controllers', 'frontend', 'navigation', 'pages', 'routes', 'screens', 'server', 'services', 'state', 'store', 'views', 'web']);
const SNAPSHOT_DOC_EXTENSIONS = /\.(?:adoc|md|mdx|rst|txt)$/i;
const SNAPSHOT_MAX_FILES = 200;
const SNAPSHOT_MAX_FILE_BYTES = 64 * 1024;
const SNAPSHOT_MAX_TOTAL_BYTES = 512 * 1024;
const SNAPSHOT_MAX_IMPORT_SCAN_FILES = 80;
const SNAPSHOT_MAX_INVENTORY_FILES = 1000;

function redactSnapshotText(text) {
  return text
    .replace(/(^|\n)(\s*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*)[^\r\n]+/gi, '$1$2<REDACTED>')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{12,})\b/g, '<REDACTED>');
}

function snapshotPriority(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const name = normalized.split('/').at(-1).toLowerCase();
  const segments = normalized.toLowerCase().split('/');
  const extension = SNAPSHOT_SOURCE_EXTENSIONS.test(name);
  if (SNAPSHOT_MANIFEST_NAMES.has(name)) return 1100;
  if (SNAPSHOT_ENTRY_NAME.test(name) && segments.length <= 2) return 1200;
  if (SNAPSHOT_TEST_SEGMENTS.has(segments.at(-2)) || SNAPSHOT_TEST_SEGMENTS.has(name.replace(/\.[^.]+$/, ''))) return extension ? 900 : 650;
  if (segments.some(segment => SNAPSHOT_FLOW_SEGMENTS.has(segment))) return extension ? 1000 : 760;
  if (extension) return 800;
  if (SNAPSHOT_DOC_EXTENSIONS.test(name)) return 150;
  if (/\.(?:json|toml|yaml|yml|ini|cfg|conf|xml)$/i.test(name)) return 700;
  return 300;
}

function collectSnapshotEntries(targetRoot) {
  const entries = [];
  function visit(directory, relativeDirectory = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SNAPSHOT_SKIP_DIRS.has(entry.name)) visit(join(directory, entry.name), relativePath);
        continue;
      }
      if (entry.isFile()) entries.push({
        relativePath,
        absolutePath: join(directory, entry.name),
        size: statSync(join(directory, entry.name)).size,
        sensitive: SNAPSHOT_SKIP_FILES.test(entry.name),
      });
    }
  }
  visit(targetRoot);
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function readSnapshotBuffer(entry) {
  if (entry.sensitive || entry.size > SNAPSHOT_MAX_FILE_BYTES) return null;
  const buffer = readFileSync(entry.absolutePath);
  return buffer.includes(0) ? null : buffer;
}

function importSpecifiers(text) {
  const specs = new Set();
  const patterns = [
    /\b(?:from|import)\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(['"]([^'"]+)['"]\)/g,
    /\brequire\s*\(['"]([^'"]+)['"]\)/g,
    /\b(?:include|require)\s*[<(]?['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) specs.add(match[1]);
  return specs;
}

function normalizeSnapshotPath(path) {
  const parts = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function resolveLocalImport(sourcePath, specifier, entriesByPath) {
  if (!specifier.startsWith('.')) return null;
  const base = normalizeSnapshotPath(`${sourcePath.split('/').slice(0, -1).join('/')}/${specifier}`);
  const extensions = ['', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.php', '.cs'];
  for (const candidate of [base, ...extensions.slice(1).map(extension => `${base}${extension}`), ...extensions.slice(1).map(extension => `${base}/index${extension}`)]) {
    if (entriesByPath.has(candidate)) return entriesByPath.get(candidate);
  }
  return null;
}

function prioritizeSnapshotEntries(entries) {
  const ranked = entries.map(entry => ({ ...entry, priority: snapshotPriority(entry.relativePath) }));
  const entriesByPath = new Map(ranked.map(entry => [entry.relativePath, entry]));
  const seeds = [...ranked]
    .filter(entry => entry.priority >= 900 && !entry.sensitive && entry.size <= SNAPSHOT_MAX_FILE_BYTES)
    .sort((a, b) => b.priority - a.priority || a.relativePath.localeCompare(b.relativePath))
    .slice(0, SNAPSHOT_MAX_IMPORT_SCAN_FILES);
  for (const seed of seeds) {
    const buffer = readSnapshotBuffer(seed);
    if (!buffer) continue;
    for (const specifier of importSpecifiers(buffer.toString('utf8'))) {
      const imported = resolveLocalImport(seed.relativePath, specifier, entriesByPath);
      if (imported) imported.priority += 150;
    }
  }
  return ranked.sort((a, b) => b.priority - a.priority || a.relativePath.localeCompare(b.relativePath));
}

export function collectRepositorySnapshot(targetRoot) {
  const entries = collectSnapshotEntries(targetRoot);
  const orderedEntries = prioritizeSnapshotEntries(entries);
  const excerpts = [];
  const readPaths = [];
  const withheldPaths = [];
  const omittedPaths = [];
  const binaryPaths = [];
  let totalBytes = 0;
  let processedFiles = 0;
  for (const entry of orderedEntries) {
    let evidence;
    if (processedFiles >= SNAPSHOT_MAX_FILES) {
      omittedPaths.push(entry.relativePath);
      evidence = '[content omitted: file-count limit]';
    } else {
      processedFiles += 1;
      if (entry.sensitive) {
        withheldPaths.push(entry.relativePath);
        evidence = '[content withheld by controller]';
      } else if (entry.size > SNAPSHOT_MAX_FILE_BYTES || totalBytes + entry.size > SNAPSHOT_MAX_TOTAL_BYTES) {
        omittedPaths.push(entry.relativePath);
        evidence = `[content omitted: ${entry.size > SNAPSHOT_MAX_FILE_BYTES ? 'per-file' : 'total'} size limit]`;
      } else {
        const buffer = readSnapshotBuffer(entry);
        if (!buffer) {
          binaryPaths.push(entry.relativePath);
          evidence = '[binary content omitted]';
        } else {
          totalBytes += entry.size;
          readPaths.push(entry.relativePath);
          evidence = redactSnapshotText(buffer.toString('utf8'));
        }
      }
    }
    excerpts.push(`--- ${entry.relativePath} ---\n${evidence}`);
  }
  const inventory = entries.map(entry => entry.relativePath);
  const inventoryShown = inventory.slice(0, SNAPSHOT_MAX_INVENTORY_FILES);
  const inventoryNote = inventory.length > inventoryShown.length ? `\n[Inventory truncated: ${inventory.length - inventoryShown.length} paths not listed.]` : '';
  const formatPaths = paths => paths.length ? paths.join(', ') : 'none';
  const coverage = [
    'Coverage summary from the trusted controller:',
    `Indexed files: ${entries.length}; content read: ${readPaths.length}; content withheld: ${withheldPaths.length}; content omitted: ${omittedPaths.length}; binary omitted: ${binaryPaths.length}.`,
    `Source bytes read: ${totalBytes}; source budget: ${SNAPSHOT_MAX_TOTAL_BYTES}.`,
    `Content read in priority order: ${formatPaths(readPaths)}`,
    `Content withheld: ${formatPaths(withheldPaths)}`,
    `Content omitted or truncated: ${formatPaths(omittedPaths)}`,
    `Binary content omitted: ${formatPaths(binaryPaths)}`,
    'This is bounded evidence, not proof that unlisted or omitted application paths are absent or correct.',
  ].join('\n');
  return `Files observed by the trusted controller (${entries.length}):\n${inventoryShown.join('\n')}${inventoryNote}\n\n${coverage}\n\nText evidence read by the trusted controller in priority order:\n${excerpts.join('\n\n')}`;
}

function codexEnvironment() {
  const env = {};
  for (const key of CODEX_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function configuredTimeout() {
  const raw = process.env.TAKAVEN_CODEX_TIMEOUT_MS;
  if (raw === undefined) return 10 * 60 * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100) throw new Error('TAKAVEN_CODEX_TIMEOUT_MS must be an integer of at least 100 milliseconds');
  return value;
}

function createScratch() {
  const base = process.env.TAKAVEN_SCRATCH_ROOT ? resolve(process.env.TAKAVEN_SCRATCH_ROOT) : tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'takaven-audit-'));
}

export function buildCodexArgs({ mode, schema, responsePath }) {
  return [
    'exec',
    '--sandbox', mode === 'inspect' ? 'read-only' : 'workspace-write',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--output-schema', schema,
    '-o', responsePath,
    '-'
  ];
}

function resolveCodexCommand(binary, args) {
  if (process.platform === 'win32' && /\.(?:cjs|mjs|js)$/i.test(binary)) {
    return { file: process.execPath, args: [binary, ...args] };
  }
  return { file: binary, args };
}

function terminateProcessTree(agent) {
  if (!agent.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(agent.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, detached: true });
    killer.unref();
    // TerminateProcess is immediate for the direct child even if taskkill is
    // restricted by the host; taskkill still handles descendants when allowed.
    try { agent.kill(); } catch {}
  } else {
    agent.kill('SIGTERM');
  }
}

function runCodex({ binary, args, cwd, prompt, timeoutMs }) {
  const resolved = resolveCodexCommand(binary, args);
  return new Promise((resolveRun, rejectRun) => {
    const agent = spawn(resolved.file, resolved.args, {
      cwd,
      env: codexEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    });
    let stderr = '';
    let timedOut = false;
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(agent);
      forceTimer = setTimeout(() => terminateProcessTree(agent), 1000);
    }, timeoutMs);
    const finish = (callback, value) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      callback(value);
    };
    agent.stderr.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    agent.on('error', error => finish(rejectRun, error));
    agent.on('close', code => {
      if (timedOut) {
        finish(rejectRun, new Error(`Codex timed out after ${timeoutMs}ms`));
      } else if (code !== 0) {
        finish(rejectRun, new Error(`Codex exited ${code}: ${stderr.slice(-1200)}`));
      } else {
        finish(resolveRun, { stderr });
      }
    });
    agent.stdin.on('error', () => {});
    agent.stdin.end(prompt);
  });
}

function cleanupScratch(scratch) {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function cloneLocalRepository(source, checkout, scratch, ref) {
  try {
    command('git', ['clone', '--quiet', '--no-hardlinks', '--', source, checkout], { timeout: 120000 });
    return { commit: command('git', ['rev-parse', 'HEAD'], { cwd: checkout }), archiveFallback: false };
  } catch (cloneError) {
    if (process.platform !== 'win32') throw cloneError;

    // Git for Windows may be unable to start its local transport inside restricted
    // hosts. Exporting the pinned tree is still a disposable, committed snapshot
    // and avoids weakening the integration test or copying dirty working files.
    const revision = ref || 'HEAD';
    const commit = command('git', ['-C', source, 'rev-parse', revision], { timeout: 60000 });
    const archive = join(scratch, 'source-tree.tar');
    rmSync(checkout, { recursive: true, force: true });
    mkdirSync(checkout, { recursive: true });
    command('git', ['-C', source, 'archive', '--format=tar', '--output', archive, revision], { timeout: 120000 });
    command('tar', ['-xf', archive, '-C', checkout], { timeout: 120000 });
    return { commit, archiveFallback: true };
  }
}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  if (args.help) { console.log(help);return; }
  const scratch=createScratch();
  const originalSource=args.repo||args.path;
  const output=resolve(args.out);
  if (args.path && (output === args.path || output.startsWith(args.path + sep))) {
    throw new Error('Report destination must be outside the original project');
  }
  let success=false;
  try {
    const checkout=join(scratch,'repo');
    let commit;
    console.log(`Cloning ${args.repo?'GitHub repository':'local repository'} into disposable workspace...`);
    let archiveFallback = false;
    if (args.path) {
      const local = cloneLocalRepository(args.path, checkout, scratch, args.ref);
      commit = local.commit;
      archiveFallback = local.archiveFallback;
    } else {
      command('git',['clone','--quiet','--depth','1','--no-tags','--',args.repo,checkout],{timeout:120000});
    }
    if (args.ref && !archiveFallback) { command('git',['fetch','--quiet','--depth','1','origin',args.ref],{cwd:checkout,timeout:120000});command('git',['checkout','--quiet','FETCH_HEAD'],{cwd:checkout}); commit=command('git',['rev-parse','HEAD'],{cwd:checkout}); }
    if (!args.path) commit=command('git',['rev-parse','HEAD'],{cwd:checkout});
    const name=basename(originalSource.replace(/[\\/]+$/, '')).replace(/\.git$/,'');
    const contract=readFileSync(join(root,'AGENTS.md'),'utf8');
    const mission=readFileSync(join(root,'prompts','audit.md'),'utf8');
    const snapshot=collectRepositorySnapshot(checkout);
    const prompt=promptForRun({projectName:name,commit,mode:args.mode,contract,mission,targetPath:checkout,snapshot});
    const schema=join(root,'report.schema.json');
    const responsePath=join(scratch,'codex-response.json');
    const codexArgs=buildCodexArgs({mode:args.mode,schema,responsePath});
    console.log(`Auditing ${name} at ${commit.slice(0,12)} [${args.mode}]...`);
    await runCodex({binary:process.env.TAKAVEN_CODEX_BIN||'codex',args:codexArgs,cwd:scratch,prompt,timeoutMs:configuredTimeout()});
    const modelReport=validateReport(JSON.parse(readFileSync(responsePath,'utf8')),{mode:args.mode});
    const report=applyTrustedMetadata(modelReport,{project:name,commit,mode:args.mode,source:originalSource,auditedAt:new Date().toISOString()});
    // Verify mode changes are never pushed and never leave the disposable workspace.
    mkdirSync(output,{recursive:true});
    writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    writeFileSync(join(output,'report.md'),renderMarkdown(report,{source:originalSource,mode:args.mode,timestamp:new Date().toISOString()}),{mode:0o600});
    writeFileSync(join(output,'audit-metadata.json'),JSON.stringify({source:originalSource,commit,mode:args.mode,createdAt:new Date().toISOString(),originalUntouched:true},null,2)+'\n');
    success=true;
    console.log(`Audit complete: ${output}/report.md\nVerdict: ${report.verdict} | Runtime: ${report.runtime_status}`);
  } finally {
    cleanupScratch(scratch);
    if (!success) console.error('Audit incomplete. Temporary checkout removed; original project not modified.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err=>{console.error(`ERROR: ${err.message}`);process.exitCode=1});
}
