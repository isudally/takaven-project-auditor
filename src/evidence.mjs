import { createHash } from 'node:crypto';

const ID_PATTERN = /^ev-[a-f0-9]{16}$/;

const SECRET_KEY = /^(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token)$/i;
const COMPOUND_SECRET_KEY = /^(?:api|auth|access|client|service|private|refresh)(?:[_-]?)(?:key|secret|token|password|passwd)$/i;
const TOKEN_VALUE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g;
const JS_SECRET_DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$-]*)\s*=\s*(['"`])([^\r\n]*?)\2/g;
const INLINE_SECRET_ASSIGNMENT = /\b([A-Za-z_$][\w$-]*)\b\s*[:=]\s*(['"`])([^\r\n]*?)\2/gi;
const SOURCE_EVIDENCE_TYPES = new Set(['source_snapshot', 'source']);
const EXECUTION_EVIDENCE_TYPES = new Set(['executed_command', 'browser_execution', 'runner_execution']);

function isSecretKey(key) {
  const text = String(key);
  return SECRET_KEY.test(text) || COMPOUND_SECRET_KEY.test(text);
}

export function redactEvidenceText(value) {
  return String(value)
    .replace(JS_SECRET_DECLARATION, (match, key, quote) => isSecretKey(key) ? `${match.slice(0, match.indexOf(quote) + 1)}<REDACTED>${quote}` : match)
    .replace(INLINE_SECRET_ASSIGNMENT, (match, key, quote) => isSecretKey(key) ? `${match.slice(0, match.indexOf(quote) + 1)}<REDACTED>${quote}` : match)
    .replace(/((?:^|[\r\n])\s*["']?(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?)([^\r\n"'`,}]+)(["']?)/gim, '$1<REDACTED>$3')
    .replace(TOKEN_VALUE, '<REDACTED>');
}

export function sanitiseEvidenceValue(value) {
  if (typeof value === 'string') return redactEvidenceText(value);
  if (Array.isArray(value)) return value.map(sanitiseEvidenceValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, isSecretKey(key) ? '<REDACTED>' : sanitiseEvidenceValue(nested)]));
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createEvidenceRegistry({ source, commit, scenario = 'default', requiredChecks = [], configuredChecks = [], briefProvenance = 'unspecified' } = {}) {
  if (typeof source !== 'string' || typeof commit !== 'string') throw new Error('Evidence registry requires source and commit');
  if (typeof scenario !== 'string' || scenario.length === 0 || !Array.isArray(requiredChecks) || !Array.isArray(configuredChecks)) throw new Error('Evidence registry requires a valid scenario and checks');
  if (!['owner-confirmed', 'repository-derived', 'unspecified'].includes(briefProvenance)) throw new Error('Evidence registry requires a valid brief provenance');
  return { version: 1, authority: 'trusted_controller', source, commit, scenario, brief_provenance: briefProvenance, required_checks: [...requiredChecks], configured_checks: [...configuredChecks], records: [], ids: new Set() };
}

export function captureEvidence(registry, record) {
  if (!registry || registry.authority !== 'trusted_controller') throw new Error('Invalid evidence registry');
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Evidence record must be an object');
  const sanitised = sanitiseEvidenceValue(record);
  const payload = {
    ...sanitised,
    source: registry.source,
    commit: registry.commit,
    scenario: registry.scenario,
    patch_hash: registry.patch_hash ?? sanitised.patch_hash ?? null,
  };
  const id = `ev-${createHash('sha256').update(stableJson(payload)).digest('hex').slice(0, 16)}`;
  if (registry.ids.has(id)) return id;
  const immutable = deepFreeze({ evidence_id: id, captured_by: 'trusted_controller', ...payload });
  registry.records.push(immutable);
  registry.ids.add(id);
  return id;
}

export function hasEvidence(registry, id) {
  return Boolean(registry?.ids?.has(id));
}

export function validateEvidenceIds(ids, registry, field = 'evidence_ids') {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error(`${field} must contain at least one evidence ID`);
  for (const id of ids) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || !hasEvidence(registry, id)) {
      throw new Error(`${field} contains an unknown evidence ID: ${String(id)}`);
    }
  }
  return ids;
}

export function isEligibleFindingEvidence(registry, id, { source = registry?.source, commit = registry?.commit } = {}) {
  if (!hasEvidence(registry, id)) return false;
  const record = registry.records.find(item => item.evidence_id === id);
  if (!record || record.captured_by !== 'trusted_controller') return false;
  if (source !== undefined && record.source !== source) return false;
  if (commit !== undefined && record.commit !== commit) return false;
  if (SOURCE_EVIDENCE_TYPES.has(record.type)) {
    return typeof record.location === 'string'
      && typeof record.content_hash === 'string'
      && ['retrieved', 'read'].includes(record.outcome);
  }
  return EXECUTION_EVIDENCE_TYPES.has(record.type) && deriveRuntimeEvidenceStatus(record) !== null;
}

// A runtime record must have one coherent controller-observed outcome. In
// particular, a zero exit code or positive UI flag must never override an
// explicit failure, timeout, signal, spawn error, or negative UI assertion.
export function deriveRuntimeEvidenceStatus(record) {
  if (!record || record.execution_verified !== true) return null;

  const exitSucceeded = record.exit_code === 0;
  const exitFailed = Number.isInteger(record.exit_code) && record.exit_code !== 0;
  const uiSucceeded = record.ui_passed === true;
  const uiFailed = record.ui_passed === false;
  const timedOut = record.timed_out === true || record.timeout === true || record.outcome === 'timed_out';
  const hasLaunchFailure = Boolean(record.spawn_error) || record.signal !== undefined && record.signal !== null;
  const browserCheck = record.type === 'browser_execution' || record.operation === 'browser_smoke' || record.check === 'browser_smoke';

  if (record.outcome === 'passed') {
    if (browserCheck && record.ui_passed === false) return 'FAIL';
    if (browserCheck && record.ui_passed !== true) return exitSucceeded && !exitFailed && !timedOut && !hasLaunchFailure ? 'PARTIAL' : null;
    if ((!exitSucceeded && !uiSucceeded) || browserCheck && !uiSucceeded || exitFailed || uiFailed || timedOut || hasLaunchFailure) return null;
    return 'PASS';
  }

  if (record.outcome === 'failed') {
    if (uiFailed && !timedOut && !hasLaunchFailure) return 'FAIL';
    if (exitSucceeded || uiSucceeded || timedOut) return null;
    return 'FAIL';
  }

  if (record.outcome === 'timed_out') return 'PARTIAL';

  if (record.outcome === 'partial') {
    if (uiFailed) return 'FAIL';
    if (exitSucceeded && uiSucceeded) return null;
    return 'PARTIAL';
  }

  return null;
}

export function isEligibleRuntimeEvidence(registry, id, { status, source, commit, scenario = registry?.scenario, patchHash } = {}) {
  if (!hasEvidence(registry, id)) return false;
  const record = registry.records.find(item => item.evidence_id === id);
  if (!record || record.captured_by !== 'trusted_controller') return false;
  if (source !== undefined && record.source !== source) return false;
  if (commit !== undefined && record.commit !== commit) return false;
  if (scenario !== undefined && record.scenario !== scenario) return false;
  if (patchHash !== undefined && record.patch_hash !== patchHash) return false;
  if (!['executed_command', 'browser_execution', 'runner_execution'].includes(record.type)) return false;
  return deriveRuntimeEvidenceStatus(record) === status;
}

export function serialiseEvidenceRegistry(registry, { includeInitialContent = true } = {}) {
  return {
    version: registry.version,
    authority: registry.authority,
    source: registry.source,
    commit: registry.commit,
    scenario: registry.scenario,
    brief_provenance: registry.brief_provenance,
    required_checks: [...registry.required_checks],
    configured_checks: [...(registry.configured_checks ?? [])],
    records: registry.records.map(record => {
      if (includeInitialContent || record.action !== 'initial_snapshot') return { ...record };
      const { content, ...metadata } = record;
      void content;
      return metadata;
    }),
  };
}

export function evidenceRegistryIndex(registry) {
  return {
    version: registry.version,
    authority: registry.authority,
    source: registry.source,
    commit: registry.commit,
    scenario: registry.scenario,
    brief_provenance: registry.brief_provenance,
    required_checks: [...registry.required_checks],
    configured_checks: [...(registry.configured_checks ?? [])],
    records: registry.records.map(record => ({
      evidence_id: record.evidence_id,
      type: record.type,
      location: record.location,
      action: record.action,
      outcome: record.outcome,
      content_hash: record.content_hash,
      bytes: record.bytes,
    })),
  };
}

