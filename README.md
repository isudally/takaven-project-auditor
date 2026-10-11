# TAKAVEN Project Auditor — v0.1

**Purpose:** Independently audit software projects for runnable functionality, missing implementations, engineering/security risks and commercial usefulness. This is a reusable auditor, not part of Playkin and not a development or deployment agent.

## What exists in v0.1

- On-demand CLI that audits any local Git repository or public GitHub repository.
- Disposable Git checkout: does not write to the source repository, create PRs, deploy or merge.
- Codex CLI as the reasoning/execution engine (no custom model or paid agent service).
- `inspect` (safe static review) and opt-in `verify` (tests/builds in a Codex sandbox).
- Explicit evidence vs inference classification, negative controls where feasible, and NOT RUN/UNKNOWN outcomes.
- Optional bounded investigative mode (`--investigate`) in which Codex may request additional source or imported evidence through a controller-validated registry.
- Machine-readable `report.json` and readable `report.md`.
- Ready-made hostile-documentation and clean-control fixtures for evaluation.

**Status:** The bounded static-audit path and the controller-mediated evidence-request loop are implemented and tested against clean, hostile and real-project snapshots. Inspect mode reads controller-selected source evidence, validates coverage and evidence IDs, and keeps runtime status `NOT RUN`. The investigative loop can retrieve bounded source and previously captured runtime evidence; it records pre-approved experiments as `NOT AVAILABLE` when no runner is configured. It does not yet provide a complete secure patch-application or runtime-experiment capability.

### Work package 1 status

The controller now performs strict structural and semantic report validation, rejects unsupported runtime success claims, writes controller-owned project/commit/mode metadata, uses a sanitized Codex environment, applies a hard Codex timeout, cleans up process trees and scratch workspaces, and supports a Windows committed-snapshot fallback when local Git clone transport is blocked by the host.

The model response schema intentionally contains only model-owned fields. Trusted identity, execution metadata and inspection coverage are added by the controller after validation and cannot be supplied by the model. Local audits warn when uncommitted changes are excluded because only the committed snapshot is audited.

Work package 1 does **not** establish a complete execution security boundary. Verify mode remains dependent on the next work package: a separate credential-free repository executor, approved command policy, restricted network, independently captured command traces and known-answer evaluation. Do not enable verify mode for unknown repositories carrying production credentials.

## How to run

Requirements: Node.js 20+, Git, and an installed/authenticated [Codex CLI](https://github.com/openai/codex).

```bash
npm install -g @openai/codex
codex login

# Static audit; does NOT run target project's own code
node src/audit.mjs --repo https://github.com/isudally/playkin --mode inspect --out ./reports/playkin

# Bounded investigation using controller-mediated source/evidence requests
node src/audit.mjs --repo https://github.com/isudally/playkin --mode inspect --investigate --evidence ./controller-evidence.json --out ./reports/playkin-investigation

# Deeper audit, when you trust the repository and run on an isolated computer
node src/audit.mjs --repo https://github.com/isudally/playkin --mode verify --out ./reports/playkin-verified

# A local Git repository also works
node src/audit.mjs --path /path/to/project --mode inspect --out ./reports/myproject
```

### Security

- `verify` may execute scripts from the target project. **Use a disposable VM/container with no production credentials and no access to sensitive user data.** Codex's workspace sandbox is useful, but not a replacement for hardened isolation.
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

1. Prove one isolated runtime-execution workflow with credential-free tooling and independently captured command results.
2. Keep inspect-mode findings separate from runtime observations and treat any unavailable runtime checks as `NOT RUN`.
3. Reassess the wrapper after the runtime proof; do not add services or automation without evidence of need.

**Out of scope:** autonomous coding, production changes, multi-agent hierarchy, dashboards, self-hosted model serving and payment/billing services.
