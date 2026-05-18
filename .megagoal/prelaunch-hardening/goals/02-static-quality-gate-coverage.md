# 02 - Static quality gate coverage

**Directional outcome.** Static checks cover the code that can hurt the product most: backend, agent-server, shared contracts, packages, scripts, tests, and frontend. The lint gate should describe environments honestly instead of excluding whole applications.

**Quality bar.** Boring and enforceable. A risky backend or shared-contract mistake should not be able to hide behind "lint only meant the frontend."

**How to close the loop.** Run the lint/static script before and after changes, plus typecheck for affected projects. If existing debt is too large for one pass, introduce scoped warning-level coverage with hard failures for new or obviously dangerous patterns, and document the remaining debt rather than ignoring directories wholesale.

`Done =` the repo's lint/static gate covers frontend, backend, agent-server, shared, packages, scripts, and tests with environment-appropriate config, and CI green AND /code-review clean.

**Scope edges.** `Not:` mass-formatting unrelated code; fixing every legacy warning unless necessary to make the gate useful; replacing the test suite; adding npm or yarn commands.

**Where to look.** Root lint config, package scripts, TypeScript project configs, test config, and any existing CI or local verification scripts.

**Time budget.** ~3h.

## PR body

```markdown
**Part of mega-goal:** `prelaunch-hardening` (sub-goal 02 of 05)
**Roadmap:** `.megagoal/prelaunch-hardening/ROADMAP.md`
**Done =** The repo's lint/static gate covers frontend, backend, agent-server, shared, packages, scripts, and tests with environment-appropriate config, and CI green AND /code-review clean.
**Stack:** depends on none; blocks sub-goals 04-05.

## What changed

- <filled by the agent from the actual diff>

## Verification

- <filled by the agent from real command output and review status>
```
