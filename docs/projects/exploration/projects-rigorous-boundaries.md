# Projects boundary review and fixes

Reviewed local Projects against the worktree's AGENTS.md/CLAUDE.md, docs/local-projects.md, Project service/store/content/PR modules, API/WS/command integration, and MCP source capture. The initial review produced five reproducible failures. All five were subsequently fixed at the parent's request; there are no remaining validated findings from this boundary pass.

## Validated issues, now fixed

### 1. Report and PR provenance could move to an assignment the source turn never received

Original fault: `ProjectStore.report()` chose `this.assignment(agentId)`, the latest assignment at report publication time, rather than the assignment frozen in the source dispatch. The corresponding result-file namespace and `project_pr_sources.assignment_id` inherited that incorrect value.

Reproduction used only supported service operations: finish a first reporting turn; send another instruction and start a second turn on the still-open assignment; accept the first finished report while the second turn runs; send a new instruction, creating a new assignment; publish the second turn's report. The test showed the report assignment and PR source assignment differed from `project_dispatches.assignment_id`; its file was placed under the newer assignment's results folder. The UI allows accepting a finished older report during a later running turn, so this did not require forged SQL or an unsupported conversation reset.

Fix: [store.ts:647](../../../apps/backend/src/services/projects/store.ts#L647) resolves the original dispatch using exact turn/session/agent/Project identity and uses its assignment for the report, result-file namespace, and PR source. Missing source dispatches reject. Existing report fixture tests now reserve genuine dispatches.

Regression: [projects-boundaries.test.ts:167](../../../apps/backend/test/unit/services/projects-boundaries.test.ts#L167).

### 2. A delayed answer could reopen a human-accepted child assignment

Original fault: reply validation checked the question's recipient conversation and unresolved flag, but not the assignment of its source dispatch. Any incoming message reopened a non-open latest assignment.

Reproduction: child asks coordinator a question and yields; coordinator starts answering; human directly instructs the child while the coordinator is still running; child completes and the human accepts its report; coordinator finally replies to the old question. The old reply was accepted, created a new child assignment, and reserved another dispatch that could contradict the accepted result.

Fix: [store.ts:410](../../../apps/backend/src/services/projects/store.ts#L410) requires the question's source dispatch to refer to the child's current open assignment and conversation generation before recording a reply. Acceptance and a newer assignment therefore make that old answer ineligible. No automatic-work suppression was applied to legitimate new instructions.

Regression: [projects-boundaries.test.ts:207](../../../apps/backend/test/unit/services/projects-boundaries.test.ts#L207).

### 3. Generic managed sends silently discarded explicit execution restrictions

Original fault: `routeProjectMessage()` retained only model, text and the request identity. A valid raw `sendMessage` command with `permissionMode: "plan"` returned success, while its eventual Project dispatch used the default `bypass_permissions` mode. Other meaningful generic options were likewise discarded. The dedicated Project composer already omits these options; this finding concerns the still-public generic command boundary, not missing Project composer controls.

Reproduction called the actual `runCommand("sendMessage", ...)` implementation, reserved its queued dispatch, and built the resulting engine configuration: expected `plan`, observed `bypass_permissions`.

Fix: [service.ts:154](../../../apps/backend/src/services/projects/service.ts#L154) rejects unsupported permission, thinking, turn-limit, additional-directory, resume and checkpoint options before queueing. The Project's fixed execution policy remains authoritative, with an explanatory error rather than a false acknowledgement.

Regressions: [projects-boundaries.test.ts:256](../../../apps/backend/test/unit/services/projects-boundaries.test.ts#L256).

### 4. Accepted structured attachment input became plain JSON when another direction was batched

Original fault: a canonical JSON-encoded text/image input passed generic command admission. A single input happened to survive `toEngineInput()`, but concatenating another queued direction in `reserveDispatch()` made the whole prompt cease to be a valid part array, silently turning the image into ordinary JSON text.

Reproduction validated the canonical input first, sent it through actual `runCommand`, queued another direction, and inspected the reserved engine input. It was a string rather than image-bearing parts.

Fix: the managed generic command boundary now rejects structured input with “Project conversations currently accept plain text only.” The unsupported attachment cannot enter the queue and later be reinterpreted. This establishes an explicit current limitation rather than adding attachment support.

Regression: [projects-boundaries.test.ts:275](../../../apps/backend/test/unit/services/projects-boundaries.test.ts#L275).

### 5. Publishing the valid relative filename `__proto__` falsely reported success

Original fault: assigning a blob to `manifest[file.path]` on a normal JavaScript object changed its prototype for this key. JSON serialization omitted the file, although publication incremented the revision and returned success. This was a low-priority data-integrity edge, not a demonstrated privilege escalation.

Fix: [store.ts:619](../../../apps/backend/src/services/projects/store.ts#L619) and [store.ts:664](../../../apps/backend/src/services/projects/store.ts#L664) construct added entries as own data properties with `Object.fromEntries` and object spread. File reads also require an own manifest entry, so inherited property names are not mistaken for files.

Regression: [projects-boundaries.test.ts:302](../../../apps/backend/test/unit/services/projects-boundaries.test.ts#L302).

## Follow-up implementation: visible queue and safe cancellation

The parent separately reproduced accepted messages disappearing from the visible UI until dispatch. At its request this pass added the backend portion of that fix:

- `ProjectDetail.pendingMessages` returns the oldest 50 undispatched, unsuperseded human inputs with ID, agent ID, message and creation time. Automatic outcomes are excluded from this list.
- `pendingMessageCount` retains the full human count; `pendingInputCount` continues to count every origin. Both counts and the bounded list come from the existing pending-input query using SQL window counts, with no per-message database reads.
- `POST /api/projects/:id/inputs/:inputId/cancel` routes to transactional `controlProject("cancel_input")`. It validates active Project ownership, human origin, current session/generation, and absence of any dispatch reservation before setting `superseded_at`.
- Identical successful cancellation retries return successfully. Once dispatch reservation wins, prepared/admitted/finished inputs all reject cancellation; frozen prompts and dispatch membership are never rewritten. Inputs and their initiating assignments remain in history.

Backend entrypoints: [store.ts:788](../../../apps/backend/src/services/projects/store.ts#L788), [service.ts:235](../../../apps/backend/src/services/projects/service.ts#L235), [routes/projects.ts:42](../../../apps/backend/src/routes/projects.ts#L42). Queue regressions begin at [projects-boundaries.test.ts:317](../../../apps/backend/test/unit/services/projects-boundaries.test.ts#L317). Shared DTOs and UI belong to the parent; status-summary changes belong to the correctness agent.

## Boundaries confirmed, not reported as vulnerabilities

- Project REST routes inherit the existing `/api/*` remote-auth middleware. Public exemptions are health and pairing. WS command/query frames follow the existing connection authentication gate. No missing-auth finding was supported.
- Generic managed model/harness switches reject; session creation, workspace state/archive/retry-setup and automation-adoption paths preserve Project ownership. Fresh managed conversations remain a documented future feature, not an omitted current flow.
- Mutating MCP receipts are keyed by exact session/turn/invocation identity and fingerprint the envelope. Completed identical retries remain readable; changed retries and fresh stale invocations reject. Contributor delegation/context-write/transcript scope checks passed.
- Upstream installed generator source calls `sdkMcpServers` before binding hooks to the originating instance's `currentTurnId` reader. The MCP closure captures session, turn and invocation identity before asynchronous relay. No concrete replacement-instance relabeling failure was found.
- Logical path traversal rejects. Published-byte reads verify their hash, including a test that replaces a blob with a symlink to different controlled fixture bytes; corrupted bytes reject rather than being returned. Same-user filesystem write access was not reframed as a new isolation guarantee.
- PR URLs normalize only supported GitHub locators. Report sources preserve original locators; workspace lookup sources explicitly omit unknown session/turn authorship. No direct PR-association bug was confirmed beyond the report-assignment race above.

## Verification

The original new test file had five failing behavior assertions and one passing receipt-boundary test, before production changes. Final boundary coverage is 16 passing tests, including cancellation and its reservation race. The latest focused run passed 51 tests across boundary, Project store, PR, managed-workspace and status suites. The real scripted-wire integration suite separately passed all four tests after the queue implementation. `bun run typecheck:backend` and `git diff --check` passed.

Commands used Node 22 via `/Users/zvada/.nvm/versions/node/v22.22.1/bin` and direct Vitest; no native rebuild, real app start, live model invocation, GUI action or remote mutation was performed by this agent. Temporary database/content/Git fixtures were inside the worktree and cleaned by their tests. `.claude/skills/deus-code-style/` was absent in this worktree; no replacement was found.
