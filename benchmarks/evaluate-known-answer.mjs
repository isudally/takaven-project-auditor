#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const reportPath = arg('--report');
const evidencePath = arg('--evidence');
const manifestPath = arg('--manifest');

const serialise = value => JSON.stringify(value).toLowerCase();
const isEligibleSource = record => record?.type === 'source' && ['source_read', 'source_search'].includes(record.action) && record.outcome === 'retrieved';

export function evaluateKnownAnswer({ report, evidence, manifest, reportPath = null }) {
  const records = new Map((evidence.registry?.records ?? []).map(record => [record.evidence_id, record]));
  const findings = report.findings ?? [];
  const findingsWithEvidence = findings.map(finding => {
    const sourceRecords = (finding.evidence_ids ?? []).map(id => records.get(id)).filter(isEligibleSource);
    return {
      finding,
      text: serialise(finding),
      records: sourceRecords,
      locations: sourceRecords.map(record => record.location),
      evidenceText: serialise(sourceRecords.map(record => record.content ?? '').join('\n')),
    };
  });
  const results = manifest.expected.map(expected => {
    const requiredPaths = [expected.path, ...(expected.contract_path ? [expected.contract_path] : [])];
    const candidates = findingsWithEvidence.filter(item => requiredPaths.every(path => item.locations.includes(path)));
    const matched = candidates.find(item =>
      (expected.finding_keywords ?? []).every(keyword => item.text.includes(keyword.toLowerCase())) &&
      (expected.evidence_keywords ?? []).every(keyword => item.evidenceText.includes(keyword.toLowerCase())) &&
      (expected.contract_keywords ?? []).every(keyword => item.evidenceText.includes(keyword.toLowerCase())) &&
      !(expected.reject_keywords ?? []).some(keyword => item.text.includes(keyword.toLowerCase()))
    );
    return { ...expected, status: matched ? 'DISCOVERED' : 'MISSED', finding_ids: candidates.map(item => item.finding.id), matched_finding_id: matched?.finding.id ?? null };
  });
  const expectedByPath = new Map(manifest.expected.map(expected => [expected.path, expected]));
  const unsupportedCandidates = findingsWithEvidence.filter(item => {
    const expected = [...expectedByPath.values()].find(candidate => item.locations.includes(candidate.path));
    if (!expected) return false;
    return !results.find(result => result.id === expected.id && result.status === 'DISCOVERED' && result.matched_finding_id === item.finding.id);
  }).map(item => item.finding.id);
  const cleanControlFalsePositives = (manifest.clean_controls ?? []).flatMap(control => findingsWithEvidence
    .filter(item => item.locations.includes(control.path) && control.forbidden_keywords.some(keyword => item.text.includes(keyword.toLowerCase())))
    .map(item => ({ control: control.id, finding_id: item.finding.id })));
  const evaluated = results.filter(item => item.class !== 'held_out');
  return {
    report: reportPath,
    verdict: report.verdict,
    finding_count: findings.length,
    expected_discoveries: evaluated.length,
    discovered: evaluated.filter(item => item.status === 'DISCOVERED').length,
    missed: evaluated.filter(item => item.status === 'MISSED').map(item => item.id),
    held_out: results.filter(item => item.class === 'held_out'),
    findings_without_eligible_source_evidence: findingsWithEvidence.filter(item => item.records.length === 0).map(item => item.finding.id),
    unsupported_candidate_findings: unsupportedCandidates,
    clean_control_false_positives: cleanControlFalsePositives,
    unmatched_source_findings: findingsWithEvidence.filter(item => item.records.length > 0 && !results.some(result => result.finding_ids.includes(item.finding.id))).map(item => item.finding.id),
    coverage: report.coverage ?? null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!reportPath || !evidencePath || !manifestPath) throw new Error('Usage: node benchmarks/evaluate-known-answer.mjs --report REPORT --evidence EVIDENCE --manifest MANIFEST');
  const output = evaluateKnownAnswer({
    report: JSON.parse(readFileSync(reportPath, 'utf8')),
    evidence: JSON.parse(readFileSync(evidencePath, 'utf8')),
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
    reportPath,
  });
  console.log(JSON.stringify(output, null, 2));
}
