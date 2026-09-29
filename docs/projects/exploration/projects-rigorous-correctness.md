# Projects correctness review — scheduler and execution boundary

Reviewed 2026-09-14 in `libreville`. `origin/main...HEAD` has no feature changes; the scope is the dirty tracked diff plus new untracked Projects files. Read AGENTS.md, CLAUDE.md, docs/local-projects.md, Project service/store/content, added schema, preparation lifecycle, command admission/cancel path, engine source capture, upstream server/client, and existing Project tests. The referenced `.claude/skills/deus-code-style/` directory is absent from this worktree.

## Confirmed and fixed: queued work never wakes after an idle reconnect

**Severity: P1 reliability.** A durable human instruction can remain queued indefinitely after connectivity returns, even though the backend and agent-server are healthy.

Before the fix, `apps/backend/src/services/agent/client.ts:107` invoked `onConnected` only from the one initial `AgentLink.connect()` call. Reconnects enter `openTransport()` instead; that function marked `connected=true` around line 148 but never invoked `onConnected`. `agent/service.ts:98` relies on that callback to call `wakeProjects()`. The disconnected scheduler exits at `projects/service.ts:587`; there is deliberately no polling or other guaranteed subsequent wake.

**Reproduction:** new test `apps/backend/test/unit/services/projects-rigorous.test.ts:226` uses the real Project service/store, SQLite persistence, command service, AgentService/AgentLink, upstream wire server and real WebSocket. It creates a ready idle coordinator, terminates the socket, queues an instruction while `isConnected()` is false, lets the scheduler run and return, and waits for a second socket connection. Before the fix there are zero runtime calls for that instruction and one pending durable input after reconnection. No new action or source event is generated to conceal the missing wake. This desired-behavior assertion was first qualified with `it.fails` against the original code, then converted to a normal test after the fix.

**Fix (authorized by root):** added the reconnect block at `agent/client.ts:152`. On the next task after the upstream transport factory returns, observe the client's new memoized initialize promise; after it succeeds, refresh discovered agents and emit `onConnected`. The guard ignores disposed/superseded connections. This uses the installed upstream client's transport-install / handshake-reset ordering (`node_modules/@zvada/agent-server/src/client/client.ts:475–488`). No new polling loop or start-turn replay is introduced.

## Independently tested behavior that passed

- `projects-rigorous.test.ts:179`: two children execute concurrently, one succeeds and one fails, and each emits its terminal event twice. There are exactly two distinct durable coordinator outcomes with the correct source turns and terminal reasons. Each input is consumed once and the coordinator executes one combined follow-up; no additional turn wakes itself.
- `projects-rigorous.test.ts:254`: replacing the live wire-server instance during an admitted turn changes the real handshake `instanceId`. The event handler detects `server_restarted`; the Project becomes Needs attention, retains the open dispatch/capacity, and holds a new human input. Continue rejects until reconciliation. Explicit Pause sends a targeted cancel; the replacement source's `no_active_turn` settles the open dispatch. No automatic duplicate execution occurred.
- Existing real Git/SQLite/wire integration still passes prepared Pause/Resume, exact reservation reuse, individual stops, explicit retry, duplicate outcomes, result publication and persisted source receipts.

## Limits of this evidence

The new source-restart test replaces an actual wire-server object and terminates actual sockets, but all models run in the test process. It is **not** a SIGKILL of a real backend owner, provider subprocess, or setup writer. It does not prove process-tree cleanup, filesystem side-effect completion, live Claude recovery, or every operating-system crash boundary. The existing owner-restart test is likewise in-process. Interrupted setup writer recovery is explicitly deferred in docs/local-projects.md; this review does not call that declared limitation a new bug. The single-backend-owner constraint is also documented, not a supported multi-owner race.

The report/assignment provenance race was independently identified here and by the boundary reviewer; that reviewer owns its reproduction and fix, so it is not duplicated in this test file.

## Validation

All commands used Node 22.22.1 where applicable and the existing native ABI. No native rebuild or real app startup was performed by this subtask.

```sh
PATH=/Users/zvada/.nvm/versions/node/v22.22.1/bin:$PATH node node_modules/vitest/vitest.mjs --config apps/backend/vitest.config.ts run apps/backend/test/unit/services/projects-rigorous.test.ts apps/backend/test/unit/services/projects-wire-integration.test.ts
# 7/7 passed
PATH=/Users/zvada/.nvm/versions/node/v22.22.1/bin:$PATH node node_modules/vitest/vitest.mjs --config apps/backend/vitest.config.ts run apps/backend/test/unit/services/agent-service-turn.test.ts apps/backend/test/unit/services/agent-commands-send.test.ts apps/backend/test/unit/services/agent-commands-stop.test.ts
# 48/48 passed
PATH=/Users/zvada/.nvm/versions/node/v22.22.1/bin:$PATH bun run typecheck:backend
# passed
```

The original 16 Project store tests also passed before modifications. Changed files were formatted with the repository's Prettier; diff whitespace checks passed.

Files owned by this subtask: `apps/backend/src/services/agent/client.ts` (reconnect block only), `apps/backend/test/unit/services/projects-rigorous.test.ts`, and this report.

## Follow-up: false Ready for review projection fixed

Root's live UI review found that idle Project shells, paused/unfinished contributors, queued instructions, and accepted historical reports all fell through to `ready`. Root authorized a focused status projection/UI fix.

The Project status contract and `ProjectStatus.tsx` now distinguish `idle` (Waiting for direction) and `queued` (Work queued). The store's batched summary query selects each Agent's current assignment and that assignment's latest dispatch. Ready for review requires an unaccepted current coordinator assignment with a report from its latest settled dispatch, no pending inputs or execution, and no unfinished or paused contributor assignment. A child is finished for this purpose when its latest assignment attempt has a settled report; individual human acceptance of all child reports is not required. Historical reports from an earlier attempt cannot make a later unreported follow-up look ready.

Prepared but unsent dispatches display Queued and are excluded from `activeAgentCount`; individually paused Agents still display Paused. Review can remain available when the final permitted dispatch produced a complete result, but queued work at the exhausted allowance displays Turn limit reached.

Added seven state-transition regressions in `apps/backend/test/unit/services/project-status.test.ts`, covering queue/idle, unfinished reporting turns, acceptance/new assignments, unfinished/paused contributors, prepared dispatch count/status, exhausted allowance, and stale coordinator/child reports after a later unreported attempt. Updated the existing metadata projection assertion because that fixture contains pending initial instructions. The batched-query-count check still passes.

Final focused run: **46/46 tests passed** across `project-status.test.ts`, `projects.test.ts`, `projects-rigorous.test.ts`, `projects-wire-integration.test.ts`, and `projects-boundaries.test.ts`. Backend typecheck passed before the final two readiness regressions; root is running combined final checks. The root/design reviewer was informed of the new status labels for Pencil synchronization. This subtask did not edit the encrypted design file.

Additional files changed under root authorization: the summary projection and prepared Agent status in `projects/store.ts`, status unions in `shared/projects.ts`, `ProjectStatus.tsx`, the metadata assertion in `projects.test.ts`, and new `project-status.test.ts`. Other concurrent store/service edits belong to the boundary reviewer.
