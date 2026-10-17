import { createHash } from 'node:crypto';
import { readSync, openSync, closeSync, statSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import { captureEvidence, redactEvidenceText, validateEvidenceIds } from './evidence.mjs';

export const MAX_INVESTIGATION_ROUNDS = 4;
export const MAX_REQUESTS_PER_ROUND = 8;
export const MAX_RETRIEVAL_BYTES = 128 * 1024;

// Correction execution is intentionally outside the active auditor protocol.
// TAKAVEN may recommend a patch as report data, but a separate implementation
// workflow owns applying and verifying changes.
const REQUEST_TYPES = new Set(['source_search', 'source_read', 'runtime_evidence', 'experiment', 'experiment_spec']);
const EXPERIMENTS = new Set(['build', 'declared_test', 'browser_smoke']);
const EXPERIMENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const EXPERIMENT_SPEC_KEYS = new Set(['type', 'query', 'paths', 'evidence_ids', 'experiment', 'reason', 'continuation', 'ranges', 'hypothesis', 'invariant', 'parameters', 'positive_control', 'negative_control', 'required_observations', 'falsification_conditions']);
const FORBIDDEN_EXPERIMENT_PARAMETER_KEYS = new Set(['args', 'arguments', 'command', 'commands', 'cwd', 'env', 'executable', 'path', 'script', 'shell']);
const MAX_EXPERIMENT_SPEC_BYTES = 16 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next']);
const SENSITIVE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|db))$/i;

export function validateProposedPatch(patch) {
  if (typeof patch !== 'string' || patch.length === 0 || patch.length > 200 * 1024) throw new Error('Proposed patch must be a non-empty bounded string');
  if (!/^diff --git a\/[^\r\n]+ b\/[^\r\n]+$/m.test(patch)) throw new Error('Proposed patch must contain a unified-diff git header');
  const paths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm), ...patch.matchAll(/^--- a\/(.+)$/gm)].map(match => match[1]);
  if (paths.length === 0) throw new Error('Proposed patch must contain unified-diff paths');
  if (paths.length % 2 !== 0 || !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(patch)) throw new Error('Proposed patch must contain valid unified-diff hunks');
  for (const path of paths) {
    const normalized = path.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized === 'dev/null' || normalized.split('/').some(part => part === '..') || normalized.startsWith('.git/')) throw new Error(`Proposed patch path is not allowed: ${path}`);
  }
  return { paths: [...new Set(paths)] };
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) throw new Error('Investigation path must be a short relative path');
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').some(part => part === '..' || part === '.git') || SENSITIVE.test(normalized.split('/').at(-1))) {
    throw new Error(`Investigation path is not allowed: ${value}`);
  }
  return normalized;
}

function safeQuery(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw new Error('Investigation search query must be a non-empty short string');
  return value;
}

function validateBoundedValue(value, label, depth = 0) {
  if (depth > 3) throw new Error(`${label} is too deeply nested`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite numbers`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 500) throw new Error(`${label} contains an oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 16) throw new Error(`${label} contains too many items`);
    value.forEach((item, index) => validateBoundedValue(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 32) throw new Error(`${label} contains too many fields`);
    for (const key of keys) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) throw new Error(`${label} contains an invalid field name`);
      if (FORBIDDEN_EXPERIMENT_PARAMETER_KEYS.has(key.toLowerCase())) throw new Error(`${label}.${key} is not permitted in an experiment parameter`);
      validateBoundedValue(value[key], `${label}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`${label} contains an unsupported value`);
}

function requiredExperimentText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) throw new Error(`${label} must be a non-empty bounded string`);
}

function validateExperimentSpecification(request) {
  if (typeof request.experiment !== 'string' || !EXPERIMENT_NAME.test(request.experiment)) throw new Error('Experiment specification name is invalid');
  requiredExperimentText(request.hypothesis, 'Experiment hypothesis');
  requiredExperimentText(request.invariant, 'Experiment invariant');
  requiredExperimentText(request.positive_control, 'Experiment positive control');
  requiredExperimentText(request.negative_control, 'Experiment negative control');
  if (!request.parameters || typeof request.parameters !== 'object' || Array.isArray(request.parameters)) throw new Error('Experiment parameters must be an object');
  validateBoundedValue(request.parameters, 'Experiment parameters');
  if (!Array.isArray(request.required_observations) || request.required_observations.length === 0 || request.required_observations.length > 8) throw new Error('Experiment required_observations must contain 1-8 items');
  if (!Array.isArray(request.falsification_conditions) || request.falsification_conditions.length === 0 || request.falsification_conditions.length > 8) throw new Error('Experiment falsification_conditions must contain 1-8 items');
  request.required_observations.forEach((value, index) => requiredExperimentText(value, `Experiment required_observations[${index}]`));
  request.falsification_conditions.forEach((value, index) => requiredExperimentText(value, `Experiment falsification_conditions[${index}]`));
  if (Buffer.byteLength(JSON.stringify({
    hypothesis: request.hypothesis, invariant: request.invariant, experiment: request.experiment,
    parameters: request.parameters, positive_control: request.positive_control, negative_control: request.negative_control,
    required_observations: request.required_observations, falsification_conditions: request.falsification_conditions,
  }), 'utf8') > MAX_EXPERIMENT_SPEC_BYTES) throw new Error(`Experiment specification exceeds ${MAX_EXPERIMENT_SPEC_BYTES} bytes`);
}

export function validateInvestigationResponse(value, registry) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid investigation response');
  const allowed = new Set(['action', 'rationale', 'requests']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unexpected investigation field: ${key}`);
  if (!['request', 'final'].includes(value.action)) throw new Error('Investigation action must be request or final');
  if (typeof value.rationale !== 'string' || value.rationale.length > 4000) throw new Error('Invalid investigation rationale');
  if (!Array.isArray(value.requests)) throw new Error('Investigation requests must be an array');
  if (value.action === 'request' && value.requests.length > MAX_REQUESTS_PER_ROUND) throw new Error(`Investigation requests must contain 0-${MAX_REQUESTS_PER_ROUND} items`);
  if (value.action === 'final' && value.requests.length !== 0) throw new Error('Final investigation response cannot contain requests');
  for (const [index, request] of value.requests.entries()) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error(`Invalid investigation request ${index}`);
    if (!REQUEST_TYPES.has(request.type)) throw new Error(`Unsupported investigation request type: ${request.type}`);
    for (const key of Object.keys(request)) if (!EXPERIMENT_SPEC_KEYS.has(key)) throw new Error(`Unexpected investigation request field: ${key}`);
    if (request.reason !== undefined && request.reason !== null && (typeof request.reason !== 'string' || request.reason.length > 1000)) throw new Error(`Invalid request reason ${index}`);
    if (request.type === 'source_search') safeQuery(request.query);
    if (request.type === 'source_read') {
      if (!Array.isArray(request.paths) || request.paths.length === 0 || request.paths.length > 10) throw new Error('source_read requires 1-10 paths');
      request.paths.forEach(safeRelativePath);
      if (request.ranges !== undefined && request.ranges !== null) {
        if (!Array.isArray(request.ranges) || request.ranges.length !== request.paths.length) throw new Error('source_read ranges must match paths');
        request.ranges.forEach(range => {
          if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.length) || range.start < 0 || range.length <= 0 || range.length > MAX_RETRIEVAL_BYTES) throw new Error('Invalid source_read range');
        });
      }
    }
    if (request.type === 'source_search' && request.continuation !== undefined && request.continuation !== null && (!Number.isInteger(request.continuation) || request.continuation < 0)) throw new Error('Invalid source_search continuation');
    if (request.type === 'runtime_evidence' && request.evidence_ids !== undefined && request.evidence_ids !== null) validateEvidenceIds(request.evidence_ids, registry, `requests[${index}].evidence_ids`);
    if (request.type === 'experiment' && !EXPERIMENTS.has(request.experiment)) throw new Error(`Experiment is not pre-approved: ${request.experiment}`);
    if (request.type === 'experiment_spec') validateExperimentSpecification(request);
  }
  return value;
}

function contentHash(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function withinCheckout(checkout, relativePath) {
  const root = realpathSync(checkout);
  const absolute = resolve(root, relativePath);
  const lexicalRoot = `${root}${sep}`;
  if (absolute !== root && !absolute.startsWith(lexicalRoot)) throw new Error('Investigation path escaped checkout');
  const parts = relativePath.replace(/\\/g, '/').split('/');
  if (parts.includes('.git')) throw new Error('Investigation path is not allowed: .git');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Investigation path crosses a symbolic link');
  }
  if (lstatSync(absolute).isSymbolicLink()) throw new Error('Investigation path resolves through a symbolic link');
  const real = realpathSync(absolute);
  if (real !== root && !real.startsWith(lexicalRoot)) throw new Error('Investigation path resolved outside checkout');
  return real;
}

function walkTextFiles(checkout, limit = 500, offset = 0) {
  const files = [];
  let seen = 0;
  let truncated = false;
  function visit(directory) {
    if (files.length >= limit) { truncated = true; return; }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !SENSITIVE.test(entry.name)) {
        if (seen++ >= offset && files.length < limit) files.push(path);
        else if (seen > offset + limit) truncated = true;
      }
      if (files.length >= limit) { truncated = true; return; }
    }
  }
  visit(checkout);
  return { files, truncated, nextOffset: truncated ? offset + files.length : null, examined: seen };
}

function captureSource(registry, relativePath, content, action) {
  const safeContent = redactEvidenceText(content);
  return captureEvidence(registry, {
    type: 'source', action, location: relativePath, bytes: Buffer.byteLength(content),
    content_hash: contentHash(safeContent), content: safeContent, outcome: 'retrieved',
  });
}

function readTextRange(absolute, start, length) {
  const descriptor = openSync(absolute, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

export function processInvestigationRequests({ requests, checkout, registry, retrievalBytesUsed = 0, runner, coverageStates = new Map(), touchedPaths = new Set() } = {}) {
  const results = [];
  let retrievedBytes = retrievalBytesUsed;
  const retrievedPaths = new Set();
  const omittedLargeFiles = new Set();
  const searchCoverage = [];
  for (const request of requests) {
    if (request.type === 'runtime_evidence') {
      const evidenceIds = request.evidence_ids ?? registry.records.filter(record => ['external_unverified', 'runner_execution', 'browser_execution', 'executed_command'].includes(record.type)).map(record => record.evidence_id);
      results.push({ type: request.type, evidence_ids: evidenceIds, records: registry.records.filter(record => evidenceIds.includes(record.evidence_id)) });
      continue;
    }
    if (request.type === 'source_read') {
      const files = [];
      for (const [pathIndex, relativePath] of request.paths.entries()) {
        let absolute;
        try { absolute = withinCheckout(checkout, relativePath); } catch (error) { files.push({ path: relativePath, outcome: 'unavailable', error: error.message }); continue; }
        let content;
        let start = 0;
        let size = 0;
        try {
          const range = request.ranges?.[pathIndex];
          size = statSync(absolute).size;
          const remaining = MAX_RETRIEVAL_BYTES - retrievedBytes;
          start = range?.start ?? 0;
          const length = Math.min(range?.length ?? size, remaining);
          if (remaining <= 0 || length <= 0) throw new Error('retrieval budget exceeded');
          content = readTextRange(absolute, start, length);
        } catch (error) {
          files.push({ path: relativePath, outcome: 'unavailable', error: error.message });
          continue;
        }
        if (content.includes('\u0000')) { files.push({ path: relativePath, outcome: 'binary_omitted' }); continue; }
        const complete = start === 0 && start + Buffer.byteLength(content) >= size;
        if (complete) coverageStates.set(relativePath, 'complete');
        else if (coverageStates.get(relativePath) !== 'complete') coverageStates.set(relativePath, 'partial');
        retrievedBytes += Buffer.byteLength(content);
        retrievedPaths.add(relativePath);
        touchedPaths.add(relativePath);
        const evidenceId = captureSource(registry, relativePath, content, 'source_read');
        files.push({ path: relativePath, evidence_id: evidenceId, content: redactEvidenceText(content), completeness: coverageStates.get(relativePath) });
      }
      results.push({ type: request.type, files });
      continue;
    }
    if (request.type === 'source_search') {
      const matches = [];
      const query = request.query;
      const inventory = walkTextFiles(checkout, 500, request.continuation ?? 0);
      for (const absolute of inventory.files) {
        if (retrievedBytes >= MAX_RETRIEVAL_BYTES) break;
        const relativePath = relative(checkout, absolute).split(sep).join('/');
        let content;
        let size;
        try { size = statSync(absolute).size; } catch { continue; }
        if (size > MAX_RETRIEVAL_BYTES) { omittedLargeFiles.add(relativePath); continue; }
        try { content = readTextRange(absolute, 0, Math.min(size, MAX_RETRIEVAL_BYTES - retrievedBytes)); } catch { continue; }
        if (content.includes('\u0000')) continue;
        const lineMatches = content.split(/\r?\n/).map((line, lineNumber) => ({ lineNumber: lineNumber + 1, line })).filter(item => item.line.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
        if (lineMatches.length === 0) continue;
        const excerpt = redactEvidenceText(lineMatches.map(item => `${item.lineNumber}: ${item.line}`).join('\n'));
        if (retrievedBytes + Buffer.byteLength(excerpt) > MAX_RETRIEVAL_BYTES) break;
        retrievedBytes += Buffer.byteLength(excerpt);
        retrievedPaths.add(relativePath);
        touchedPaths.add(relativePath);
        if (coverageStates.get(relativePath) !== 'complete') coverageStates.set(relativePath, 'partial');
        const evidenceId = captureSource(registry, relativePath, excerpt, 'source_search');
        matches.push({ path: relativePath, evidence_id: evidenceId, excerpt });
      }
      searchCoverage.push({ query, continuation: request.continuation ?? 0, examined_files: inventory.examined, truncated: inventory.truncated, next_continuation: inventory.nextOffset, omitted_large_files: [...omittedLargeFiles] });
      results.push({ type: request.type, query, matches, examined_files: inventory.examined, truncated: inventory.truncated, next_continuation: inventory.nextOffset, omitted_large_files: [...omittedLargeFiles] });
      continue;
    }
    if (request.type === 'experiment_spec') {
      const specification = {
        hypothesis: request.hypothesis,
        invariant: request.invariant,
        experiment: request.experiment,
        parameters: request.parameters,
        positive_control: request.positive_control,
        negative_control: request.negative_control,
        required_observations: request.required_observations,
        falsification_conditions: request.falsification_conditions,
      };
      if (typeof runner !== 'function') {
        const evidenceId = captureEvidence(registry, { type: 'experiment', action: 'bounded_experiment_specification', experiment: request.experiment, specification, outcome: 'not_available', execution_verified: false, observation: 'No approved runner was provided; the controller did not execute the proposed experiment.' });
        results.push({ type: request.type, experiment: request.experiment, evidence_id: evidenceId, outcome: 'not_available' });
      } else {
        const execution = runner({ operation: 'experiment_spec', experiment: request.experiment, specification, checkout, registry });
        results.push({ type: request.type, experiment: request.experiment, ...execution });
      }
      continue;
    }
    if (request.type === 'experiment') {
      if (typeof runner !== 'function') {
        const evidenceId = captureEvidence(registry, { type: 'experiment', action: 'preapproved_experiment', experiment: request.experiment, outcome: 'not_available', execution_verified: false, observation: 'No approved runner was provided; no repository command was executed.' });
        results.push({ type: request.type, experiment: request.experiment, evidence_id: evidenceId, outcome: 'not_available' });
      } else {
        const execution = runner({ operation: request.experiment, checkout, registry });
        results.push({ type: request.type, experiment: request.experiment, ...execution });
      }
      continue;
    }
    if (request.type === 'correction_verification') {
      const evidenceId = captureEvidence(registry, {
        type: 'controller_validation', action: 'policy_gate', outcome: 'rejected',
        observation: 'Correction verification requests are disabled in the active auditor protocol; no patch was applied or executed.',
        execution_verified: false,
        proposed_patch: request.patch ?? null,
      });
      results.push({ type: request.type, evidence_id: evidenceId, outcome: 'rejected' });
    }
  }
  return {
    results,
    retrievedBytes,
    retrievedPaths: [...touchedPaths],
    completePaths: [...touchedPaths].filter(path => coverageStates.get(path) === 'complete'),
    partialPaths: [...touchedPaths].filter(path => coverageStates.get(path) === 'partial'),
    omittedLargeFiles: [...omittedLargeFiles],
    searchCoverage,
  };
}
