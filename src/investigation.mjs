import { createHash } from 'node:crypto';
import { readSync, openSync, closeSync, statSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import { captureEvidence, redactEvidenceText, validateEvidenceIds } from './evidence.mjs';

export const MAX_INVESTIGATION_ROUNDS = 4;
export const MAX_REQUESTS_PER_ROUND = 8;
export const MAX_RETRIEVAL_BYTES = 128 * 1024;
export const MAX_SEARCH_SCAN_BYTES = 512 * 1024;

// Correction execution is intentionally outside the active auditor protocol.
// TAKAVEN may recommend a patch as report data, but a separate implementation
// workflow owns applying and verifying changes.
const REQUEST_TYPES = new Set(['source_search', 'source_read', 'runtime_evidence', 'experiment']);
const EXPERIMENTS = new Set(['build', 'declared_test', 'browser_smoke']);
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
    const requestKeys = new Set(['type', 'query', 'paths', 'evidence_ids', 'experiment', 'reason', 'patch', 'continuation', 'ranges']);
    for (const key of Object.keys(request)) if (!requestKeys.has(key)) throw new Error(`Unexpected investigation request field: ${key}`);
    if (!REQUEST_TYPES.has(request.type)) throw new Error(`Unsupported investigation request type: ${request.type}`);
    if (request.reason !== undefined && request.reason !== null && (typeof request.reason !== 'string' || request.reason.length > 1000)) throw new Error(`Invalid request reason ${index}`);
    if (request.type === 'source_search') {
      safeQuery(request.query);
      if (request.paths !== undefined && request.paths !== null) {
        if (!Array.isArray(request.paths) || request.paths.length === 0 || request.paths.length > 10) throw new Error('source_search paths must contain 1-10 paths');
        request.paths.forEach(safeRelativePath);
      }
    }
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
  }
  return value;
}

export function findInvalidCorrectionPatch(value, registry) {
  if (!value || !Array.isArray(value.requests)) return null;
  for (const [index, request] of value.requests.entries()) {
    if (request?.type !== 'correction_verification' || request.patch === undefined || request.patch === null) continue;
    try {
      validateProposedPatch(request.patch);
    } catch (error) {
      return { index, patch: request.patch, error: error.message };
    }
  }
  return null;
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

function captureSource(registry, relativePath, content, action, bytes = Buffer.byteLength(content)) {
  const safeContent = redactEvidenceText(content);
  return captureEvidence(registry, {
    type: 'source', action, location: relativePath, bytes,
    content_hash: contentHash(safeContent), content: safeContent, outcome: 'retrieved',
  });
}

function readTextRange(absolute, start, length) {
  const descriptor = openSync(absolute, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, start);
    return { content: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead };
  } finally {
    closeSync(descriptor);
  }
}

export function processInvestigationRequests({ requests, checkout, registry, retrievalBytesUsed = 0, runner, coverageStates = new Map(), touchedPaths = new Set(), retrievalCache = new Map() } = {}) {
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
          if (!range && coverageStates.get(relativePath) === 'complete') {
            files.push({ path: relativePath, outcome: 'already_available', completeness: 'complete', reused_initial_snapshot: true, bytes_returned: 0 });
            continue;
          }
          const remaining = MAX_RETRIEVAL_BYTES - retrievedBytes;
          start = range?.start ?? 0;
          const length = Math.min(range?.length ?? size, remaining);
          if (remaining <= 0 || length <= 0) {
            files.push({ path: relativePath, outcome: 'budget_exhausted', completeness: coverageStates.get(relativePath) ?? 'partial', next_range: { start, length: Math.min(size - start, MAX_RETRIEVAL_BYTES) }, bytes_returned: 0 });
            continue;
          }
          const cacheKey = `read:${relativePath}:${start}:${length}`;
          const cached = retrievalCache.get(cacheKey);
          if (cached) {
            files.push({ ...cached, reused: true });
            continue;
          }
          const rangeResult = readTextRange(absolute, start, length);
          content = rangeResult.content;
          const returnedBytes = rangeResult.bytesRead;
          if (returnedBytes === 0 && size > start) throw new Error('source range returned no bytes');
          if (content.includes('\u0000')) { files.push({ path: relativePath, outcome: 'binary_omitted', file_size: size }); continue; }
          const complete = start === 0 && returnedBytes >= size;
          const nextRange = !complete && start + returnedBytes < size ? { start: start + returnedBytes, length: Math.min(size - start - returnedBytes, MAX_RETRIEVAL_BYTES) } : null;
          if (complete) coverageStates.set(relativePath, 'complete');
          else if (coverageStates.get(relativePath) !== 'complete') coverageStates.set(relativePath, 'partial');
          retrievedBytes += returnedBytes;
          retrievedPaths.add(relativePath);
          touchedPaths.add(relativePath);
          const evidenceId = captureSource(registry, relativePath, content, 'source_read', returnedBytes);
          const file = { path: relativePath, evidence_id: evidenceId, content: redactEvidenceText(content), completeness: coverageStates.get(relativePath), file_size: size, range: { start, length: returnedBytes }, next_range: nextRange, bytes_returned: returnedBytes };
          retrievalCache.set(cacheKey, file);
          files.push(file);
          continue;
        } catch (error) {
          files.push({ path: relativePath, outcome: 'unavailable', error: error.message });
          continue;
        }
      }
      results.push({ type: request.type, files });
      continue;
    }
    if (request.type === 'source_search') {
      const searchKey = `search:${request.query}:${(request.paths ?? []).join(',')}:${request.continuation ?? 0}`;
      const cachedSearch = retrievalCache.get(searchKey);
      if (cachedSearch) {
        results.push({ ...cachedSearch, reused: true });
        searchCoverage.push({ ...(cachedSearch.coverage ?? {}), reused: true });
        continue;
      }
      const matches = [];
      const query = request.query;
      const unavailablePaths = [];
      const inventory = request.paths
        ? { files: request.paths.flatMap(path => { try { return [withinCheckout(checkout, path)]; } catch (error) { unavailablePaths.push({ path, error: error.message }); return []; } }), truncated: false, nextOffset: null, examined: request.paths.length }
        : walkTextFiles(checkout, 500, request.continuation ?? 0);
      let scanBytes = 0;
      let scanTruncated = false;
      for (const absolute of inventory.files) {
        if (scanBytes >= MAX_SEARCH_SCAN_BYTES) { scanTruncated = true; break; }
        const relativePath = relative(checkout, absolute).split(sep).join('/');
        let content;
        let size;
        try { size = statSync(absolute).size; } catch { continue; }
        const scanLength = Math.min(size, MAX_SEARCH_SCAN_BYTES - scanBytes);
        let scanResult;
        try { scanResult = readTextRange(absolute, 0, scanLength); } catch { continue; }
        content = scanResult.content;
        scanBytes += scanResult.bytesRead;
        if (scanLength < size) {
          scanTruncated = true;
          omittedLargeFiles.add(relativePath);
        }
        if (content.includes('\u0000')) continue;
        const lineMatches = content.split(/\r?\n/).map((line, lineNumber) => ({ lineNumber: lineNumber + 1, line })).filter(item => item.line.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
        if (lineMatches.length === 0) continue;
        const excerpt = redactEvidenceText(lineMatches.map(item => `${item.lineNumber}: ${item.line}`).join('\n'));
        if (retrievedBytes + Buffer.byteLength(excerpt) > MAX_RETRIEVAL_BYTES) { scanTruncated = true; break; }
        retrievedBytes += Buffer.byteLength(excerpt);
        retrievedPaths.add(relativePath);
        touchedPaths.add(relativePath);
        if (coverageStates.get(relativePath) !== 'complete') coverageStates.set(relativePath, 'partial');
        const evidenceId = captureSource(registry, relativePath, excerpt, 'source_search');
        matches.push({ path: relativePath, evidence_id: evidenceId, excerpt });
      }
      const coverage = { query, paths: request.paths ?? null, continuation: request.continuation ?? 0, examined_files: inventory.examined, unavailable_paths: unavailablePaths, truncated: inventory.truncated || scanTruncated, next_continuation: inventory.nextOffset, omitted_large_files: [...omittedLargeFiles], bytes_scanned: scanBytes, scan_byte_budget: MAX_SEARCH_SCAN_BYTES, returned_bytes: matches.reduce((total, match) => total + Buffer.byteLength(match.excerpt), 0) };
      searchCoverage.push(coverage);
      const searchResult = { type: request.type, query, matches, examined_files: inventory.examined, unavailable_paths: unavailablePaths, truncated: coverage.truncated, next_continuation: inventory.nextOffset, omitted_large_files: [...omittedLargeFiles], bytes_scanned: scanBytes, scan_byte_budget: MAX_SEARCH_SCAN_BYTES, returned_bytes: coverage.returned_bytes, coverage };
      retrievalCache.set(searchKey, searchResult);
      results.push(searchResult);
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
