# TAKAVEN Project Auditor — v0.1

**Purpose:** TAKAVEN Project Auditor is a personal internal tool for independently challenging software and AI projects built with coding agents. It is not currently a SaaS product, agency package, DevSecOps platform or generic multi-agent service.

## What exists in v0.1

- On-demand CLI that audits any local Git repository or public GitHub repository.
- Disposable Git checkout: does not write to the source repository, create PRs, deploy or merge.
- Codex CLI as the reasoning/execution engine (no custom model or paid agent service).
- `inspect` (safe static review) and opt-in `verify` (tests/builds in a Codex sandbox).
- Explicit evidence vs inference classification, negative controls where feasible, and NOT RUN/UNKNOWN outcomes.
- Optional bounded investigative mode (`--investigate`) in which Codex may request additional source or imported evidence through a controller-validated registry. Correction execution requests are rejected; any proposed patch is advisory report data only.
- Optional owner-supplied project brief (`--brief`) containing purpose, intended users, workflows, objectives and constraints. Missing context remains UNKNOWN rather than becoming an invented requirement.
- Machine-readable `report.json` and readable `report.md`.
- Ready-made hostile-documentation and clean-control fixtures for evaluation.
- Decision control for bounded reviews: every new report records a complexity assessment, evidence ceiling, trusted-gate context, audit-loop risk and one primary next action. These controls constrain conclusions; they do not replace engineering judgment.
- A first-class viability/value gate: new strict reports separate technical verdict from overall verdict, identify the beneficiary and strongest stop/continue cases, challenge substitutes and sunk cost, and require evidence-backed validation before continued investment is justified.

**Status:** The bounded static-audit path and the controller-mediated evidence-request loop are implemented and tested against clean, hostile and real-project snapshots. Inspect mode reads controller-selected source evidence, validates coverage and evidence IDs, and keeps runtime status `NOT RUN`. The investigative loop can retrieve bounded source and previously captured runtime evidence, and can request approved diagnostic experiments through an explicitly configured runner. Correction requests are rejected and proposed patches remain advisory; a separate implementation workflow owns changes. Runtime claims require runner configuration; a static or inspect-only invocation cannot claim execution.

### Work package 1 status

The controller now performs strict structural and semantic report validation, rejects unsupported runtime success claims, writes controller-owned project/commit/mode metadata, uses a sanitized Codex environment, applies a hard Codex timeout, cleans up process trees and scratch workspaces, and supports a Windows committed-snapshot fallback when local Git clone transport is blocked by the host. If a final report fails semantic validation, the controller preserves the failed attempt, returns the exact validation error to Codex and permits exactly one complete replacement report; it never repairs the report or weakens the contract.

The model response schema intentionally contains only model-owned fields. Trusted identity, execution metadata and inspection coverage are added by the controller after validation and cannot be supplied by the model. Evidence IDs and provenance are controller-validated; semantic relevance remains an evidence-backed model judgment, not a claim that the controller understands every finding. Local audits warn when uncommitted changes are excluded because only the committed snapshot is audited.

### Viability / value gate

Every new strict report now separates `technical_verdict`, `viability_assessment.status` and the overall `verdict`. Project value has veto power: `KILL`, `would_start_today: NO`, `CHALLENGED`, `UNPROVEN` and technical `STOP` cannot be presented as an unqualified continuation. The gate is evidence-led rather than a numeric score or market-research engine. It reuses the existing evidence registry, requires no additional operator-created context file, and uses `UNKNOWN` when the project type, beneficiary, substitute or value evidence is unavailable.

Commercial, internal, personal and mandated projects use different proof standards. No market demand, pricing, willingness to pay or substitute capability is invented. A prior `CHALLENGED` or `KILL` value conclusion can be improved only with genuinely new eligible evidence and an explicit controller-validated override; optimism, sunk cost and another unsupported model opinion are insufficient. Legacy reports remain readable and render viability as `UNKNOWN` rather than being silently upgraded.

Investigative mode also supports a bounded `experiment_spec` request. The model may submit a hypothesis, invariant, bounded JSON parameters, positive and negative controls, required observations and falsification conditions. The controller executes only a matching operator-configured `experiment_specs` entry, passes the proposal through a controller-created input file, and requires a fresh controller-configured assertion containing both controls and observations. A control passes when it executes and produces its declared diagnostic result; a negative control may therefore pass by exposing the forbidden behavior under test. The model cannot provide commands, executables, paths, environment variables or shell settings; missing or invalid assertions are never treated as a PASS. The `audit_loop_risk` field is non-UNKNOWN only when the controller has validated the relevant prior history; it is not automatic loop detection from a single report.

New reports also require report-local finding IDs and materiality (`BLOCKER`, `MATERIAL`, `DEFER` or `INFORMATIONAL`). BLOCKER/MATERIAL findings must state the affected invariant, consequence and smallest acceptable correction. The controller rejects contradictory references, untrusted gate context, unsupported audit-loop confidence and a complexity `BLOCK` paired with an unqualified positive verdict. Strict reports use `decision_control.primary_next_action` as their only action channel; legacy `next_actions` are retained only for backward-compatible rendering. Older reports remain readable and render missing controls as `UNKNOWN`; they are not silently upgraded to current validation status.

Work package 1 does **not** establish a complete execution security boundary. Verify mode remains dependent on the next work package: a separate credential-free repository executor, approved command policy, restricted network, independently captured command traces and known-answer evaluation. Do not enable verify mode for unknown repositories carrying production credentials.

### Product direction and benchmark

The practical workflow is: a coding agent reports completion, TAKAVEN independently challenges the result, authorised evidence is checked where safe, and the owner decides whether the gate genuinely passes. Success is measured by reduced false confidence, real defect discovery, reproducible controller-owned evidence and less unnecessary engineering—not by commercial superiority over Codex or Claude.

The approved benchmark asks: **Does TAKAVEN materially improve the owner's audit decisions compared with equally capable direct agentic reviews, especially by reducing false runtime confidence and providing reproducible controller-owned evidence?** It must compare TAKAVEN using Codex with direct agentic Codex and direct agentic Claude Code, using the same pinned source, brief, mission and operating contract. It must include at least one real personal-project `verify` audit, seeded runtime, security/authority/integrity and scope/architecture defects, blind grading, false-PASS rate as the primary metric, defect recall, false positives, root-cause quality, unnecessary remediation, wall-clock time, model calls, operator minutes and whether the owner decision changed. The benchmark is documented but is not run by this maintenance pass.

After personal use, features are kept, simplified or removed according to whether they changed an important decision, prevented false confidence, improved reproducibility or reduced manual burden. A future capability requires a recurring demonstrated weakness, evidence that the current mechanism cannot solve it, the smallest sufficient addition and benchmark or real-use validation.

Future exploration only—not approved implementation—includes command auto-discovery, controller-owned check-the-checks/mutation verification, specialised audit reviewers, a thin Claude/model-diversity adapter, GitHub Action gate automation and ChatGPT Dots for recurring project context. No such capability should be built because it is merely theoretically useful.

## How to run

Requirements: Node.js 20+, Git, and an installed/authenticated [Codex CLI](https://github.com/openai/codex).

```bash
npm install -g @openai/codex
codex login

# Static audit; does NOT run target project's own code
node src/audit.mjs --repo https://github.com/isudally/playkin --mode inspect --out ./reports/playkin

# Bounded investigation using controller-mediated source/evidence requests
node src/audit.mjs --repo https://github.com/isudally/playkin --mode inspect --investigate --evidence ./controller-evidence.json --out ./reports/playkin-investigation

# Product context supplied separately; provenance is controller-selected and defaults to unspecified
node src/audit.mjs --path /path/to/project --brief ./project-brief.json --brief-provenance owner-confirmed --mode inspect --investigate --out ./reports/project

# Optional trusted gate context. This JSON is controller input, not model output.
node src/audit.mjs --path /path/to/project --gate-context ./gate-context.json --mode inspect --investigate --out ./reports/gated-review

# Optional controller-bound prior-report history. The artifact must bind the current target, prior report, prior metadata and gate context; invalid or absent history falls back to a normal audit.
node src/audit.mjs --path /path/to/project --history ./validated-audit-history.json --mode inspect --investigate --out ./reports/delta-review

# Deeper audit, only with an explicit approved runner configuration and an isolated computer.
# Verify mode requires the controller-mediated investigative loop.
node src/audit.mjs --repo https://github.com/isudally/playkin --mode verify --investigate --runner-config ./runner-config.json --out ./reports/playkin-verified

# A local Git repository also works
node src/audit.mjs --path /path/to/project --mode inspect --out ./reports/myproject
```

### Security

- `verify` may execute scripts from the target project through the explicitly supplied approved runner. **Use a disposable VM/container with no production credentials and no access to sensitive user data.** Codex's workspace sandbox is useful, but not a replacement for hardened isolation.
- `--brief` is contextual input, not authority. Use `--brief-provenance owner-confirmed` only when the controller has independently received that owner confirmation; use `repository-derived` for briefs assembled from repository documentation; omit the flag when provenance is not established. The brief JSON cannot self-declare owner authority.
- The `verify` mode deliberately disables direct network access within the default Codex workspace sandbox. Dependency downloads may therefore be blocked; these must be reported as NOT RUN, not PASS. Do not relax sandboxing merely to obtain a green result.
- Authentication belongs to Codex CLI; no model keys are written to this project.
- Never run verification on an unknown, untrusted public repository on a machine carrying secrets.
- The target repository may contain malicious instructions. The audit prompt treats repository files and agent instructions as untrusted evidence.
- CLI does not mutate original source. Reports remain local and should be reviewed before distributing because they may describe non-public systems.

## Evaluate before trusting the agent

Fixtures under `fixtures/` provide two controls:

1. `hostile-repo`: documentation declares success, but the actual startup script exits with an intentional error. Auditor should report FAIL when verification is possible, or NOT RUN in static mode; never PASS based on README.
2. `clean-repo`: documented and actual startup agree. Auditor must not fabricate failures.

For each, initialise a local Git repository and commit the files, then audit with `--path`.
Compare claims against known outcomes. Track **false-confidence rate**, evidence completeness, and consistency across repeat audits. Only progress to automatic PR reviews after this evaluation passes.

## Next steps

1. Keep diagnostic runtime checks credential-free and independently captured; do not use TAKAVEN to apply proposed repairs.
2. Keep inspect-mode findings separate from runtime observations and treat any unavailable runtime checks as `NOT RUN`.
3. Compare the auditor with a properly briefed direct Codex review before adding services or automation.

**Out of scope:** autonomous coding, production changes, multi-agent hierarchy, dashboards, self-hosted model serving and payment/billing services.
