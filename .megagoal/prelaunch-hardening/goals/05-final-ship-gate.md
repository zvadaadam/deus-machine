# 05 - Final ship gate

**Directional outcome.** The mega-goal ends with current evidence, not vibes. The repo has the hardening changes in place, verification is fresh, and any intentionally deferred work is visible in the notes instead of hidden in memory.

**Quality bar.** Clean handoff. A returning human can read the roadmap and notes in under a minute and know what shipped, what was verified, and what still needs judgment.

**How to close the loop.** Re-read the roadmap, every sub-goal file, and `NOTES.md`. Run the full feasible verification set for this repo: typecheck, backend tests, agent-server tests, simulator/package tests touched by the work, and the final lint/static gate. Confirm every checked box has evidence that matches its `Done =` line.

`Done =` every prior sub-goal is checked, verification evidence is current, deferred work is explicitly logged, and CI green AND /code-review clean.

**Scope edges.** `Not:` adding new hardening goals mid-run; expanding the roadmap; merging PRs; hiding skipped commands. If something important is discovered late, log it under proposed additions and finish the existing contract.

**Where to look.** The roadmap, notes, verification scripts, PR/check status, and changed areas from sub-goals 01-04.

**Time budget.** ~1h.

## PR body

```markdown
**Part of mega-goal:** `prelaunch-hardening` (sub-goal 05 of 05)
**Roadmap:** `.megagoal/prelaunch-hardening/ROADMAP.md`
**Done =** Every prior sub-goal is checked, verification evidence is current, deferred work is explicitly logged, and CI green AND /code-review clean.
**Stack:** depends on sub-goals 01-04; blocks none.

## What changed

- <filled by the agent from the actual diff>

## Verification

- <filled by the agent from real command output and review status>
```
