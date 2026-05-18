# 04 - High-risk complexity pass

**Directional outcome.** One high-risk large module gets simpler in a way that future work can feel immediately. The split should reduce cognitive load without changing user-visible behavior or starting a broad architecture rewrite.

**Quality bar.** Smaller, clearer, and still boring. The module should read like it has named responsibilities instead of one file carrying layout, transport, state, persistence, and side effects at once.

**How to close the loop.** Pick the highest-leverage large module based on current evidence after sub-goals 01-03 are done. Preserve behavior with focused tests, typecheck, and any relevant UI smoke if the touched module is user-facing. Prefer extraction of cohesive helpers/components/services over mechanical file splitting.

`Done =` at least one highest-risk large module is simplified without behavior drift, with focused verification proving the split, and CI green AND /code-review clean.

**Scope edges.** `Not:` refactoring every large file; changing product behavior; mixing visual redesign with simplification; introducing a new abstraction layer unless it removes real complexity.

**Where to look.** The largest/highest-churn modules identified in the audit: browser panel, simulator context/panel, home view, query engine, and adjacent tests.

**Time budget.** ~4h.

## PR body

```markdown
**Part of mega-goal:** `prelaunch-hardening` (sub-goal 04 of 05)
**Roadmap:** `.megagoal/prelaunch-hardening/ROADMAP.md`
**Done =** At least one highest-risk large module is simplified without behavior drift, with focused verification proving the split, and CI green AND /code-review clean.
**Stack:** depends on sub-goals 01-03; blocks sub-goal 05.

## What changed

- <filled by the agent from the actual diff>

## Verification

- <filled by the agent from real command output and review status>
```
