# TAKAVEN Project Auditor direction

## Current purpose

TAKAVEN is a personal internal auditor used after the owner's normal coding-agent workflow. It independently challenges completion claims, checks authorised evidence, exposes false confidence and unnecessary engineering, and gives the owner one bounded next decision. It is not currently a product for sale, an agency platform, a DevSecOps service or a generic multi-agent runtime.

## Frozen strengths

- Controller-owned runtime truth and structural prevention of unsupported runtime PASS claims.
- Committed revision provenance and disposable source checkout.
- Sanitised model execution context and source immutability checks.
- Separate inspect/verify modes and explicit OBSERVED, INFERRED, UNKNOWN and NOT RUN states.
- Controller validation of evidence identity, execution binding, trusted metadata and decision-control fields.

These strengths are about reproducibility and trustworthy decisions, not exclusive tool access.

## Current work

The personal benchmark demonstrated that TAKAVEN's controller-owned Codex path
works while an outer nested helper could not launch a direct comparison. The
minimum local autonomy required for normal personal use is therefore now
approved: the controller may launch a direct local Codex reviewer itself from a
disposable checkout, capture the raw review and execution metadata, and report a
truthful environment failure. This is not a daemon, worker service or general
agent platform. Existing TAKAVEN audit results remain unchanged; the direct
review is a comparison control rather than a structured TAKAVEN report.

The next evidence gate is the personal-use seeded-defect benchmark using this
controller-owned direct path. The owner should normally provide the audit goal
and project, not copy prompts between tools or shuttle result files.

## Benchmark decision gate

Compare TAKAVEN using Codex with direct agentic Codex and direct agentic Claude Code. Use the same pinned source, owner brief, audit mission and operating contract. Include at least one real TAKAVEN `verify` audit, seeded runtime, security/authority/integrity and scope/architecture defects, blind grading and a known-answer manifest kept outside model workspaces.

Primary metric: false-PASS rate on seeded runtime claims. Secondary measures include seeded defects detected and missed, false positives, root-cause quality, unnecessary remediation, wall-clock time, model calls, operator/manual minutes, setup friction and whether the owner's decision changed. Feature decisions after the benchmark are evidence-dependent: keep, simplify, freeze or remove mechanisms that do not change decisions, prevent false confidence, improve reproducibility or reduce manual burden.

## Future exploration only

Not approved for implementation in the current pass:

- command auto-discovery and lower-ceremony verify setup (conditional future
  work; not demonstrated as the dominant remaining friction);
- controller-owned check-the-checks or mutation verification;
- specialised security, architecture, runtime or product reviewers;
- a thin Claude/model-diversity adapter;
- automatic GitHub Action PR/gate execution;
- ChatGPT Dots for recurring project context.

Each candidate must first satisfy the anti-overengineering rule: an observed recurring weakness, evidence the current mechanism cannot solve it, the smallest sufficient addition, and benchmark or real-use validation. No agent-to-agent bus, persistent orchestration platform, dashboard, new database or provider architecture is implied.

## Anti-overengineering rule

Do not build a capability because it is interesting or theoretically useful. Stop source work when the next uncertainty can only be answered by the personal benchmark or controlled runtime evidence.
