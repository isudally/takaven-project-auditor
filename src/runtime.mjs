import { isEligibleRuntimeEvidence } from './evidence.mjs';

const EXECUTION_TYPES = new Set(['executed_command', 'browser_execution', 'runner_execution']);

function statusForRecord(registry, record) {
  if (isEligibleRuntimeEvidence(registry, record.evidence_id, { status: 'PASS' })) return 'PASS';
  if (isEligibleRuntimeEvidence(registry, record.evidence_id, { status: 'FAIL' })) return 'FAIL';
  if (isEligibleRuntimeEvidence(registry, record.evidence_id, { status: 'PARTIAL' })) return 'PARTIAL';
  return null;
}

function checkName(record) {
  return record.check ?? record.operation ?? record.experiment ?? record.type;
}

function observationFor(record) {
  if (typeof record.observation === 'string' && record.observation.length > 0) return record.observation;
  const output = [record.stdout, record.stderr].filter(value => typeof value === 'string' && value.length > 0).join('\n');
  return output || `Controller recorded outcome ${record.outcome ?? 'unknown'}.`;
}

function outcomeRank(status) {
  return { FAIL: 3, PARTIAL: 2, PASS: 1, 'NOT RUN': 0 }[status] ?? 0;
}

export function deriveRuntimeResults(registry, { modelRuntimeStatus = 'NOT RUN', modelRuntimeEvidence = [], source = registry.source, commit = registry.commit, scenario = registry.scenario, patchHash } = {}) {
  const matching = registry.records.filter(record => EXECUTION_TYPES.has(record.type)
    && record.source === source
    && record.commit === commit
    && record.scenario === scenario
    && (patchHash === undefined || record.patch_hash === patchHash));
  const eligible = matching.filter(record => statusForRecord(registry, record));

  const modelEntries = Array.isArray(modelRuntimeEvidence) ? modelRuntimeEvidence : [];

  const derived = eligible.map(record => {
    return {
      check: checkName(record),
      status: statusForRecord(registry, record),
      command: record.command ?? `controller operation ${checkName(record)}`,
      observation: observationFor(record),
      negative_control: record.negative_control ?? 'Controller-derived result; model claims are not execution evidence.',
      evidence_ids: [record.evidence_id],
    };
  });

  const requiredChecks = registry.required_checks ?? [];
  const configuredChecks = registry.configured_checks ?? requiredChecks;
  const excludedChecks = configuredChecks.filter(check => !requiredChecks.includes(check));
  const presentChecks = new Set(eligible.map(checkName));
  for (const record of matching) {
    const check = checkName(record);
    if (presentChecks.has(check) || statusForRecord(registry, record)) continue;
    derived.push({
      check,
      status: 'NOT RUN',
      command: record.command ?? `controller operation ${check}`,
      observation: observationFor(record),
      negative_control: 'The controller captured an incomplete or unavailable execution; it is not treated as success.',
      evidence_ids: [record.evidence_id],
    });
    presentChecks.add(check);
  }
  for (const check of requiredChecks) if (!presentChecks.has(check)) {
    derived.push({
      check,
      status: 'NOT RUN',
      command: `controller operation ${check}`,
      observation: `No eligible controller evidence was captured for required check ${check}.`,
      negative_control: 'Missing execution is not treated as success.',
      evidence_ids: null,
    });
    presentChecks.add(check);
  }
  for (const check of excludedChecks) if (!presentChecks.has(check)) {
    derived.push({
      check,
      status: 'NOT RUN',
      command: `controller operation ${check}`,
      observation: `Acceptance check ${check} was configured but excluded by the explicit verification scope.`,
      negative_control: 'A scoped verification result is not complete application verification.',
      evidence_ids: null,
    });
    presentChecks.add(check);
  }

  const contradictions = [];
  const modelOverall = modelRuntimeStatus ?? (modelEntries.length > 0 ? modelEntries.reduce((highest, entry) => outcomeRank(entry.status) > outcomeRank(highest) ? entry.status : highest, 'NOT RUN') : 'NOT RUN');
  const derivedStatuses = derived.map(entry => entry.status);
  const derivedOverall = derived.length === 0 || derivedStatuses.every(status => status === 'NOT RUN')
    ? 'NOT RUN'
    : derivedStatuses.includes('FAIL') ? 'FAIL'
      : derivedStatuses.includes('PARTIAL') || derivedStatuses.includes('NOT RUN') ? 'PARTIAL' : 'PASS';
  if (modelOverall !== derivedOverall) contradictions.push({ model_status: modelOverall, controller_status: derivedOverall });
  for (const entry of modelEntries) {
    const derivedEntry = derived.find(candidate => candidate.check === entry.check);
    if (derivedEntry && entry.status !== derivedEntry.status) contradictions.push({ check: entry.check, model_status: entry.status, controller_status: derivedEntry.status, evidence_ids: derivedEntry.evidence_ids });
  }

  return { runtime_status: derivedOverall, runtime_evidence: derived, contradictions, eligible_evidence_ids: eligible.map(record => record.evidence_id) };
}

export function applyControllerRuntimeResults(report, registry, options = {}) {
  const derived = deriveRuntimeResults(registry, { ...options, modelRuntimeStatus: report.runtime_status, modelRuntimeEvidence: report.runtime_evidence });
  const next = {
    ...report,
    runtime_status: derived.runtime_status,
    runtime_evidence: derived.runtime_evidence,
  };
  const verificationWasRequested = options.mode === 'verify';
  if (derived.runtime_status !== 'PASS' && (verificationWasRequested || derived.runtime_status === 'FAIL' || derived.runtime_status === 'PARTIAL') && report.verdict === 'CONTINUE') {
    next.verdict = 'INCONCLUSIVE';
    next.executive_summary = `Controller qualification: runtime verification is ${derived.runtime_status}; the original model summary is preserved below as unverified context. ${report.executive_summary}`;
  }
  if ((registry.configured_checks ?? []).some(check => !(registry.required_checks ?? []).includes(check))) {
    next.unverified = [
      ...(Array.isArray(next.unverified) ? next.unverified : []),
      'The configured runner contains acceptance checks outside the explicit verification scope; the result is not complete application verification.',
    ];
  }
  if (derived.contradictions.length > 0) {
    next.unverified = [
      ...(Array.isArray(next.unverified) ? next.unverified : []),
      `The model runtime claim conflicted with controller-derived evidence and was preserved as a failed attempt: ${JSON.stringify(derived.contradictions)}.`,
    ];
  }
  return { report: next, ...derived };
}
