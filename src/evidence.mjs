import { createHash } from 'node:crypto';

const ID_PATTERN = /^ev-[a-f0-9]{16}$/;

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
  const payload = { ...record, source: registry.source, commit: registry.commit };
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
