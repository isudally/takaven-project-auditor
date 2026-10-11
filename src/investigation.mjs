import { createHash } from 'node:crypto';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { captureEvidence, validateEvidenceIds } from './evidence.mjs';

export const MAX_INVESTIGATION_ROUNDS = 4;
export const MAX_REQUESTS_PER_ROUND = 8;
export const MAX_RETRIEVAL_BYTES = 128 * 1024;

const REQUEST_TYPES = new Set(['source_search', 'source_read', 'runtime_evidence', 'experiment', 'correction_verification']);
const EXPERIMENTS = new Set(['build', 'declared_test', 'browser_smoke']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next']);
const SENSITIVE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|db))$/i;

export function validateProposedPatch(patch) {
  if (typeof patch !== 'string' || patch.length === 0 || patch.length > 200 * 1024) throw new Error('Proposed patch must be a non-empty bounded string');
  const paths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm), ...patch.matchAll(/^--- a\/(.+)$/gm)].map(match => match[1]);
  if (paths.length === 0) throw new Error('Proposed patch must contain unified-diff paths');
  for (const path of paths) {
    const normalized = path.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').some(part => part === '..') || normalized === '/dev/null' || normalized.startsWith('.git/')) throw new Error(`Proposed patch path is not allowed: ${path}`);
  }
  return { paths: [...new Set(paths)] };
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) throw new Error('Investigation path must be a short relative path');
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').some(part => part === '..') || SENSITIVE.test(normalized.split('/').at(-1))) {
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
    const requestKeys = new Set(['type', 'query', 'paths', 'evidence_ids', 'experiment', 'reason', 'patch']);
    for (const key of Object.keys(request)) if (!requestKeys.has(key)) throw new Error(`Unexpected investigation request field: ${key}`);
    if (!REQUEST_TYPES.has(request.type)) throw new Error(`Unsupported investigation request type: ${request.type}`);
    if (request.reason !== undefined && (typeof request.reason !== 'string' || request.reason.length > 1000)) throw new Error(`Invalid request reason ${index}`);
    if (request.type === 'source_search') safeQuery(request.query);
    if (request.type === 'source_read') {
      if (!Array.isArray(request.paths) || request.paths.length === 0 || request.paths.length > 10) throw new Error('source_read requires 1-10 paths');
      request.paths.forEach(safeRelativePath);
    }
    if (request.type === 'runtime_evidence' && request.evidence_ids !== undefined && request.evidence_ids !== null) validateEvidenceIds(request.evidence_ids, registry, `requests[${index}].evidence_ids`);
    if (request.type === 'experiment' && !EXPERIMENTS.has(request.experiment)) throw new Error(`Experiment is not pre-approved: ${request.experiment}`);
    if (request.type === 'correction_verification') {
      if (typeof request.reason !== 'string' || request.reason.length === 0) throw new Error('correction_verification requires a reason');
      if (request.patch !== undefined) validateProposedPatch(request.patch);
    }
  }
  return value;
}

function contentHash(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function withinCheckout(checkout, relativePath) {
  const absolute = join(checkout, relativePath);
  const root = `${checkout}${sep}`;
  if (!absolute.startsWith(root)) throw new Error('Investigation path escaped checkout');
  return absolute;
}

function walkTextFiles(checkout, limit = 500) {
  const files = [];
  function visit(directory) {
    if (files.length >= limit) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !SENSITIVE.test(entry.name)) files.push(path);
      if (files.length >= limit) return;
    }
  }
  visit(checkout);
  return files;
}

function captureSource(registry, relativePath, content, action) {
  return captureEvidence(registry, {
    type: 'source', action, location: relativePath, bytes: Buffer.byteLength(content),
    content_hash: contentHash(content), content, outcome: 'retrieved',
  });
}

export function processInvestigationRequests({ requests, checkout, registry, retrievalBytesUsed = 0 }) {
  const results = [];
  let retrievedBytes = retrievalBytesUsed;
  const retrievedPaths = new Set();
  for (const request of requests) {
    if (request.type === 'runtime_evidence') {
      const evidenceIds = request.evidence_ids ?? registry.records.filter(record => record.type === 'imported_runtime').map(record => record.evidence_id);
      results.push({ type: request.type, evidence_ids: evidenceIds, records: registry.records.filter(record => evidenceIds.includes(record.evidence_id)) });
      continue;
    }
    if (request.type === 'source_read') {
      const files = [];
      for (const relativePath of request.paths) {
        const absolute = withinCheckout(checkout, relativePath);
        let content;
        try {
          if (statSync(absolute).size > MAX_RETRIEVAL_BYTES - retrievedBytes) throw new Error('retrieval budget exceeded');
          content = readFileSync(absolute, 'utf8');
        } catch (error) {
          files.push({ path: relativePath, outcome: 'unavailable', error: error.message });
          continue;
        }
        if (content.includes('\u0000')) { files.push({ path: relativePath, outcome: 'binary_omitted' }); continue; }
        retrievedBytes += Buffer.byteLength(content);
        retrievedPaths.add(relativePath);
        const evidenceId = captureSource(registry, relativePath, content, 'source_read');
        files.push({ path: relativePath, evidence_id: evidenceId, content });
      }
      results.push({ type: request.type, files });
      continue;
    }
    if (request.type === 'source_search') {
      const matches = [];
      const query = request.query;
      for (const absolute of walkTextFiles(checkout)) {
        if (retrievedBytes >= MAX_RETRIEVAL_BYTES) break;
        const relativePath = relative(checkout, absolute).split(sep).join('/');
        let content;
        try { content = readFileSync(absolute, 'utf8'); } catch { continue; }
        if (content.includes('\u0000')) continue;
        const lineMatches = content.split(/\r?\n/).map((line, lineNumber) => ({ lineNumber: lineNumber + 1, line })).filter(item => item.line.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
        if (lineMatches.length === 0) continue;
        const excerpt = lineMatches.map(item => `${item.lineNumber}: ${item.line}`).join('\n');
        if (retrievedBytes + Buffer.byteLength(excerpt) > MAX_RETRIEVAL_BYTES) break;
        retrievedBytes += Buffer.byteLength(excerpt);
        retrievedPaths.add(relativePath);
        const evidenceId = captureSource(registry, relativePath, excerpt, 'source_search');
        matches.push({ path: relativePath, evidence_id: evidenceId, excerpt });
      }
      results.push({ type: request.type, query, matches });
      continue;
    }
    if (request.type === 'experiment') {
      const evidenceId = captureEvidence(registry, {
        type: 'experiment', action: 'preapproved_experiment', experiment: request.experiment,
        outcome: 'not_available', observation: 'No experiment runner was provided to this controller invocation; no repository command was executed.',
      });
      results.push({ type: request.type, experiment: request.experiment, evidence_id: evidenceId, outcome: 'not_available' });
      continue;
    }
    if (request.type === 'correction_verification') {
      const evidenceId = captureEvidence(registry, {
        type: 'correction_verification', action: 'policy_gate', outcome: 'not_available',
        observation: 'Patch application and runtime verification require an explicitly configured disposable runner; none was provided to this controller invocation.',
        proposed_patch: request.patch,
      });
      results.push({ type: request.type, evidence_id: evidenceId, outcome: 'not_available' });
    }
  }
  return { results, retrievedBytes, retrievedPaths: [...retrievedPaths] };
}
