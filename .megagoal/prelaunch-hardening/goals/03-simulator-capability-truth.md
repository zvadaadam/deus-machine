# 03 - Simulator capability truth

**Directional outcome.** The simulator tab appears only when the backend can actually support the simulator experience for this client and transport. Web and relay modes should be honest: either streaming works through the chosen transport, or the UI says it is unavailable instead of handing the client a useless localhost URL.

**Quality bar.** No platform guessing masquerading as capability detection. The user should never click a simulator tab that was enabled because their browser is on a Mac while the backend or stream path cannot serve it.

**How to close the loop.** Verify local desktop behavior, local web behavior, and relay/web assumptions against the backend capability source. Add or update tests around capability calculation and tab gating, and run the relevant frontend/backend tests plus typecheck.

`Done =` simulator UI is gated by backend capability and transport reality, relay/web has either a working stream path or a clear unavailable state, and CI green AND /code-review clean.

**Scope edges.** `Not:` building a full simulator streaming redesign unless the current code already has the proxy path ready to finish; changing unrelated native-browser capability gates; redesigning the simulator panel visuals.

**Where to look.** Platform capability detection, simulator frontend service and panel gating, backend simulator context, WebSocket query resources, and tests around simulator state.

**Time budget.** ~3h.

## PR body

```markdown
**Part of mega-goal:** `prelaunch-hardening` (sub-goal 03 of 05)
**Roadmap:** `.megagoal/prelaunch-hardening/ROADMAP.md`
**Done =** Simulator UI is gated by backend capability and transport reality, relay/web has either a working stream path or a clear unavailable state, and CI green AND /code-review clean.
**Stack:** depends on none; blocks sub-goals 04-05.

## What changed

- <filled by the agent from the actual diff>

## Verification

- <filled by the agent from real command output and review status>
```
