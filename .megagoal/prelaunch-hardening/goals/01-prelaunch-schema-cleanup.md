# 01 - Pre-launch schema cleanup

**Directional outcome.** Database setup says the truth about the product stage: pre-launch schema changes can be direct and simple, but the policy is explicit. A future post-launch migration system should not be confused with today's local-dev reset path.

**Quality bar.** No backwards-compatibility theater. Anyone reading the schema code understands whether they should reset a local DB, run a dev migration, or preserve user data.

**How to close the loop.** Verify the schema/bootstrap path from a clean local database and from any supported dev-reset path. Run the relevant backend schema tests, backend tests that touch persistence, and the repo typecheck or the closest available subset. If dependencies are missing, install with Bun only or document why verification could not run.

`Done =` database setup has one explicit pre-launch schema policy, obsolete migration baggage is removed or minimized, reset/dev upgrade behavior is documented, and CI green AND /code-review clean.

**Scope edges.** `Not:` building a full post-launch migration framework unless the current code already makes that the smallest correct move; preserving deprecated columns for imaginary external users; changing message/session semantics beyond what schema cleanup requires.

**Where to look.** The shared schema contract, backend database bootstrap, backend persistence tests, and developer setup documentation.

**Time budget.** ~2h.

## PR body

```markdown
**Part of mega-goal:** `prelaunch-hardening` (sub-goal 01 of 05)
**Roadmap:** `.megagoal/prelaunch-hardening/ROADMAP.md`
**Done =** Database setup has one explicit pre-launch schema policy, obsolete migration baggage is removed or minimized, reset/dev upgrade behavior is documented, and CI green AND /code-review clean.
**Stack:** depends on none; blocks sub-goals 04-05.

## What changed

- <filled by the agent from the actual diff>

## Verification

- <filled by the agent from real command output and review status>
```
