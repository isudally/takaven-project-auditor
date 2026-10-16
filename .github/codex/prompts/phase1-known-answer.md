You are running one controlled, credential-free known-answer benchmark for TAKAVEN Project Auditor.

Use only the synthetic fixture and the two auditor checkouts prepared by the workflow. Do not inspect or open the benchmark manifest, evaluator source, expected findings, or any hidden ground-truth file. Do not access external repositories, production systems, credentials, or customer data. Do not modify tracked source files.

Run the normal auditor CLI twice with the same fixture and neutral brief:

1. Candidate: `node "$GITHUB_WORKSPACE/src/audit.mjs" --path "$RUNNER_TEMP/known-answer-fixture" --brief "$RUNNER_TEMP/neutral-brief.json" --brief-provenance owner-confirmed --mode inspect --investigate --out "$GITHUB_WORKSPACE/benchmark-artifacts/candidate"`
2. Baseline: `node "$RUNNER_TEMP/auditor-baseline/src/audit.mjs" --path "$RUNNER_TEMP/known-answer-fixture" --brief "$RUNNER_TEMP/neutral-brief.json" --brief-provenance owner-confirmed --mode inspect --investigate --out "$GITHUB_WORKSPACE/benchmark-artifacts/baseline"`

Preserve the generated report.json, report.md, audit-metadata.json, evidence-registry.json, investigation artifacts, and command logs under `benchmark-artifacts/`. If a run fails, preserve its exact error and partial artifacts rather than retrying it.

Then perform a separate direct Codex review of the same fixture, with the same neutral brief and read-only source access. Do not read either auditor report or any benchmark evaluator/manifest. Save the direct review as `benchmark-artifacts/direct-codex.md` and clearly label it as a direct review, not a TAKAVEN report.

Finally, summarize the three run outcomes, target revisions, validation status, retries, and artifact paths in your final response. Do not claim improvement or correctness based on a command exit alone.
