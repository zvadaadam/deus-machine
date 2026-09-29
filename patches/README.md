# Temporary upstream patches

`@zvada%2Fagent-server@0.3.8.patch` carries reviewed execution lifecycle fixes
from the upstream `agent-server` repository, Conductor worktree `thimphu`,
branch `projects-feature`. The patch targets the published 0.3.8 files and was
generated when that branch was based on commit
`b1c3e90903bf49caea0a9b6f1af1e542c43b5fb9`. On 22 September 2026 the worktree
was rebased onto upstream `master` (`7248c43`, after the 0.3.9 release), so its
sources now also contain upstream's strict-resume, MCP-recovery and harness
turn-ownership changes and no longer byte-match this patch. Do not regenerate
the patch from the rebased worktree against 0.3.8; the next step is an upstream
release that includes both, then a version bump here.

- Shared runtime admission permits one executing turn per logical session;
  identical retries converge, and different sessions remain parallel. Native
  JSON-RPC and ACP map the same busy/closing errors. Closing blocks new admission
  until teardown succeeds; a failed close requires an explicit retry.
- Cancellation is retained before harness startup and may target an exact turn.
  Completed turns release their external and per-tap abort listeners, so late
  signals cannot interrupt a successor. The ACP approval bridge does not block
  cancellation on an unanswered human RPC.
- Claude classifies interrupted execution failures as cancelled, correlates
  results with the submitted prompt, and prevents a stopped startup from later
  enqueueing. Queued prompt cancellation uses the public SDK spawn hook and waits
  for actual subprocess exit. Ordinary admitted turns retain SDK interruption.
- Codex app-server and ACP share child-exit tracking and bounded kill escalation.
  SessionStore retains teardown promises after logical removal; forced terminal
  events and replacement execution wait for physical exit. Codex app-server
  falls back from resume only for the exact missing rollout, preserving other
  errors instead of silently starting a fresh conversation.

Sixteen existing upstream source files are patched. They are reproduced by a
fresh frozen install; see above for how they relate to the rebased worktree. The dependency remains
pinned to `0.3.8`; Bun records the patch in `package.json` and `bun.lock`. A local
checkout path or unpublished package is not required to install/build Deus.

The engine still has no durable queue or public steering operation. Those fixes
protect the execution boundary. Project queues and business policy stay in the
Deus backend; Project tool registration currently supports Claude. Codex SDK
itself is unchanged and still lacks a public force-kill hook.

Remove the patch and its `patchedDependencies` entry when an upstream release
includes these fixes. Update the dependency and lockfile together, then rerun
upstream turn-control/provider conformance and Deus Project wire/reconnect tests.
Retain the installed-engine regression and qualify live cancellation/resume.
The upstream guide `packages/agent-server/docs/turn-control.md` records provider
capabilities, tested versions and remaining limits.
