import { createHash } from 'node:crypto';

const ID_PATTERN = /^ev-[a-f0-9]{16}$/;

const SECRET_KEY = /^(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token)$/i;
const TOKEN_VALUE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g;

export function redactEvidenceText(value) {
  return String(value)
    .replace(/((?:^|[\r\n])\s*["']?(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?)([^\r\n"'`,}]+)(["']?)/gim, '$1<REDACTED>$3')
    .replace(TOKEN_VALUE, '<REDACTED>');
}

export function sanitiseEvidenceValue(value) {
  if (typeof value === 'string') return redactEvidenceText(value);
  if (Array.isArray(value)) return value.map(sanitiseEvidenceValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, SECRET_KEY.test(key) ? '<REDACTED>' : sanitiseEvidenceValue(nested)]));
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

export function createEvidenceRegistry({ source, commit } = {}) {
  if (typeof source !== 'string' || typeof commit !== 'string') throw new Error('Evidence registry requires source and commit');
  return { version: 1, authority: 'trusted_controller', source, commit, records: [], ids: new Set() };
}

export function captureEvidence(registry, record) {
  if (!registry || registry.authority !== 'trusted_controller') throw new Error('Invalid evidence registry');
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Evidence record must be an object');
  const payload = { ...sanitiseEvidenceValue(record), source: registry.source, commit: registry.commit };
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

export function isEligibleRuntimeEvidence(registry, id, { status, source, commit } = {}) {
  if (!hasEvidence(registry, id)) return false;
  const record = registry.records.find(item => item.evidence_id === id);
  if (!record || record.captured_by !== 'trusted_controller') return false;
  if (source !== undefined && record.source !== source) return false;
  if (commit !== undefined && record.commit !== commit) return false;
  if (!['executed_command', 'browser_execution', 'runner_execution'].includes(record.type)) return false;
  if (record.execution_verified !== true) return false;
  if (status === 'PASS') return record.outcome === 'passed' || record.exit_code === 0 || record.ui_passed === true;
  if (status === 'FAIL') return record.outcome === 'failed' || (Number.isInteger(record.exit_code) && record.exit_code !== 0) || record.ui_passed === false;
  if (status === 'PARTIAL') return record.outcome === 'partial' || record.outcome === 'timed_out';
  return false;
}

export function serialiseEvidenceRegistry(registry, { includeInitialContent = true } = {}) {
  return {
    version: registry.version,
    authority: registry.authority,
    source: registry.source,
    commit: registry.commit,
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
