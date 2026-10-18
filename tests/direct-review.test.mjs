import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCapabilityPreflight, runDirectReview } from '../src/direct-review.mjs';

function initCheckout() {
  const directory = mkdtempSync(join(tmpdir(), 'takaven-direct-target-'));
  writeFileSync(join(directory, 'README.md'), '# disposable direct target\n');
  const init = spawnSync('git', ['-C', directory, 'init', '-q'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.equal(spawnSync('git', ['-C', directory, 'add', 'README.md'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', directory, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'fixture'], { encoding: 'utf8' }).status, 0);
  return directory;
}

function fakeCodex(directory, body) {
  const script = join(directory, 'fake-codex.mjs');
  writeFileSync(script, `import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('fake-codex 1.0'); process.exit(0); }
if (process.cwd().includes('capability-fixture')) {
  const marker = readFileSync('README.md', 'utf8').trim();
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const outputIndex = process.argv.indexOf('--output-last-message');
  writeFileSync(process.argv[outputIndex + 1], \`commit: \${commit}\\n\${marker}\\nCONTINUE\\n\`);
  console.log(\`tool git rev-parse HEAD cwd=\${process.cwd()}\`);
  process.exit(0);
}
${body}
`);
  return script;
}

function output(directory, name) {
  return join(directory, name);
}

test('direct runner preflights, launches the model, captures raw output, sanitizes env and preserves the target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'takaven-direct-success-'));
  const target = initCheckout();
  const scratchRoot = join(root, 'scratch');
  const fake = fakeCodex(root, `
const outputIndex = process.argv.indexOf('--output-last-message');
const reportPath = process.argv[outputIndex + 1];
console.log('tool git rev-parse HEAD cwd=' + process.cwd());
writeFileSync(reportPath, '# DIRECT_REVIEW_OK\\n\\nOBSERVED: local fixture inspected.\\nUNKNOWN: no live systems.\\n' + JSON.stringify({ args: process.argv, secret: process.env.DIRECT_REVIEW_SECRET ?? 'absent', manifest: process.env.BENCHMARK_MANIFEST ?? 'absent' }) + '\\n\\nCONTINUE\\n');
`);
  const previousSecret = process.env.DIRECT_REVIEW_SECRET;
  const previousManifest = process.env.BENCHMARK_MANIFEST;
  process.env.DIRECT_REVIEW_SECRET = 'synthetic-secret';
  process.env.BENCHMARK_MANIFEST = join(root, 'hidden-manifest.json');
  writeFileSync(process.env.BENCHMARK_MANIFEST, 'ground truth');
  process.env.TAKAVEN_SCRATCH_ROOT = scratchRoot;
  try {
    const result = await runDirectReview({ source: target, output: output(root, 'report'), binary: fake, timeoutMs: 10000 });
    assert.equal(result.status, 'SUCCESS', JSON.stringify(result.metadata));
    const report = readFileSync(join(root, 'report', 'direct-report.md'), 'utf8');
    assert.match(report, /DIRECT_REVIEW_OK/);
    assert.match(report, /"secret":"absent"/);
    assert.match(report, /"manifest":"absent"/);
    assert.doesNotMatch(report, /--output-schema/);
    assert.doesNotMatch(report, /--ignore-user-config/);
    assert.match(report, /--output-last-message/);
    assert.equal(result.metadata.codex_version, 'fake-codex 1.0');
    assert.equal(result.metadata.model_execution_started, true);
    assert.equal(result.metadata.repository_inspection, 'CONFIRMED');
    assert.equal(result.metadata.capability_preflight.repository_tooling_available, true);
    assert.equal(result.metadata.environment_difference.omitted_names.includes('DIRECT_REVIEW_SECRET'), true);
    assert.equal(result.metadata.original_source_unchanged, true);
    assert.equal(spawnSync('git', ['-C', target, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '');
    assert.equal(readdirSync(scratchRoot).length, 0);
  } finally {
    if (previousSecret === undefined) delete process.env.DIRECT_REVIEW_SECRET; else process.env.DIRECT_REVIEW_SECRET = previousSecret;
    if (previousManifest === undefined) delete process.env.BENCHMARK_MANIFEST; else process.env.BENCHMARK_MANIFEST = previousManifest;
    delete process.env.TAKAVEN_SCRATCH_ROOT;
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('capability preflight fails closed when the disposable marker is not observed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'takaven-direct-capability-'));
  const fake = join(root, 'fake-codex.mjs');
  writeFileSync(fake, `import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('fake-codex 1.0'); process.exit(0); }
const outputIndex = process.argv.indexOf('--output-last-message');
writeFileSync(process.argv[outputIndex + 1], 'CONTINUE\\n');
`);
  const scratch = join(root, 'scratch');
  mkdirSync(scratch, { recursive: true });
  try {
    const result = await runCapabilityPreflight({ binary: fake, scratch, timeoutMs: 10000 });
    assert.equal(result.model_started, true);
    assert.equal(result.repository_tooling_available, false);
    assert.equal(result.marker_observed, false);
    assert.equal(result.commit_observed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('direct runner classifies missing executable without a false audit result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'takaven-direct-missing-'));
  const target = initCheckout();
  try {
    const result = await runDirectReview({ source: target, output: output(root, 'report'), binary: join(root, 'does-not-exist'), timeoutMs: 1000 });
    assert.equal(result.status, 'DIRECT_AGENT_ENVIRONMENT_BLOCKED');
    const metadata = JSON.parse(readFileSync(join(root, 'report', 'execution-metadata.json'), 'utf8'));
    assert.equal(metadata.model_execution_started, false);
    assert.equal(metadata.repository_inspection, 'NOT RUN');
    assert.equal(existsSync(join(root, 'report', 'direct-report.md')), false);
  } catch (error) {
    assert.fail(error);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test('direct runner preserves an inconclusive review without calling it success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'takaven-direct-inconclusive-'));
  const target = initCheckout();
  const fake = fakeCodex(root, `
const outputIndex = process.argv.indexOf('--output-last-message');
writeFileSync(process.argv[outputIndex + 1], '# INCONCLUSIVE\\n\\nNo repository command was run.\\n\\nINCONCLUSIVE\\n');
`);
  try {
    const result = await runDirectReview({ source: target, output: output(root, 'report'), binary: fake, timeoutMs: 10000 });
    assert.equal(result.status, 'DIRECT_AGENT_INCONCLUSIVE');
    const metadata = JSON.parse(readFileSync(join(root, 'report', 'execution-metadata.json'), 'utf8'));
    assert.equal(metadata.review_decision, 'INCONCLUSIVE');
    assert.equal(existsSync(join(root, 'report', 'direct-report.md')), true);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

for (const [label, body, expectedStatus] of [
  ['launch-failure', 'process.exit(7);', 'DIRECT_AGENT_EXECUTION_FAILED'],
  ['timeout', 'setTimeout(() => {}, 10000);', 'DIRECT_AGENT_TIMEOUT'],
]) {
  test(`direct runner handles ${label}`, async () => {
    const root = mkdtempSync(join(tmpdir(), `takaven-direct-${label}-`));
    const target = initCheckout();
    const fake = fakeCodex(root, body);
    try {
      const result = await runDirectReview({ source: target, output: output(root, 'report'), binary: fake, timeoutMs: label === 'timeout' ? 200 : 10000 });
      assert.equal(result.status, expectedStatus, JSON.stringify(result.metadata));
      const metadata = JSON.parse(readFileSync(join(root, 'report', 'execution-metadata.json'), 'utf8'));
      assert.equal(metadata.original_source_unchanged, true);
      assert.equal(metadata.repository_inspection, 'NOT RUN');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
  });
}
