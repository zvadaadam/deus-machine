# Local Projects — exploration and review notes

Working notes from designing and building Local Projects (14–22 September 2026). They
record the options considered, dry-runs, reviews and live qualification behind the
feature. They are history, not a specification: where they disagree with the code, the
code and [docs/local-projects.md](../../local-projects.md) win.

Some supporting research notes live in a private repository; links below that point at
them (for example `projects-implementation-report.md`) do not resolve here. Links to
`project-smoke/…` evidence pointed at a local scratch folder that was not published.

## Plan and model

- [projects-build-plan.md](projects-build-plan.md) — the agreed build plan and its latest status.
- [project-model-review.md](project-model-review.md) — independent challenge of the Project model.
- [projects-second-dry-run.md](projects-second-dry-run.md) — second implementation dry-run and refactor review.
- [projects-implementation-schema.md](projects-implementation-schema.md) — proposed schema, constraints and retention.
- [projects-implementation-review.md](projects-implementation-review.md) — coding-pass review of the plan.
- [project-notification-owner-findings.md](project-notification-owner-findings.md) — notification ownership and minimal contract.
- [project-navigation-deus-findings.md](project-navigation-deus-findings.md) — how Project navigation fits the current UI.
- [project-ui-composition-findings.md](project-ui-composition-findings.md) — Project and workspace UI composition.
- [agent-server-deep-review.md](agent-server-deep-review.md) — queueing, steering and provider lifecycle in the engine.

## Reviews and qualification

- [projects-rigorous-report.md](projects-rigorous-report.md), with its
  [boundaries](projects-rigorous-boundaries.md), [correctness](projects-rigorous-correctness.md)
  and [design](projects-rigorous-design.md) reviews.
- [projects-independent-code-review.md](projects-independent-code-review.md) and
  [projects-review-fixes-report.md](projects-review-fixes-report.md).
- [projects-complexity-review.md](projects-complexity-review.md) — complexity check of the final local implementation.
- [projects-live-prompt-boundary.md](projects-live-prompt-boundary.md) — live prompt-boundary failure and its engine fix.
- [projects-cancel-upstream.md](projects-cancel-upstream.md) — pause classification fix carried upstream.
- [projects-tool-inspection.md](projects-tool-inspection.md) — status/transcript tool follow-up.
- [projects-ui-simplification-report.md](projects-ui-simplification-report.md) — shared UI and cancellation qualification.
