# Known-answer investigation benchmark

This is a disposable, evaluator-only benchmark for Phase 1. The fixture seeds
generic workflow defects across persistence, side effects, sensitive logging,
authorization, mutable evidence and customer enquiry completion. The fixture
does not contain the expected-answer manifest, and the owner brief must not
describe the seeded defects.

Create a fixture outside the auditor checkout:

```text
node benchmarks/create-known-answer-fixture.mjs C:/temp/takaven-known-answer
```

Run the normal CLI in `inspect --investigate` mode against that disposable
fixture with a neutral owner brief. Save `report.json`,
`evidence-registry.json` and the execution log outside both repositories.
Then evaluate the report with the evaluator and the manifest stored in this
directory. The evaluator is deliberately conservative: a seeded case counts
as discovered only when a finding cites eligible controller source evidence
from every required path, its text contains the evaluator-only causal
keywords, the cited source content contains the expected implementation
signatures, and the finding does not contradict the seeded contract. It also
reports unsupported candidate findings, clean-control false positives and
findings without eligible source evidence as separate signals; none of those
signals is a complete semantic false-positive score.

`KA-007` is held out from the initial tuning set. Its source contains an
explicit retry path and the fixture's workflow requirements define the
no-duplicate contract. A report that discovers it with both source and
contract evidence is useful new recall; a report that invents it without
support is not.

Compare baseline and candidate runs using the same fixture, brief, target
commit, model, timeout and evidence budget. A direct Codex comparison must be
run separately with equivalent source material and permissions; this harness
does not treat controller tests or a longer report as proof of superiority.
