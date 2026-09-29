# Independent Projects code review — 2026-09-14

Reviewed the current tracked and untracked local Projects implementation, its integration into ordinary sessions/workspaces, and the related upstream engine changes in `agent-server/thimphu`. Three independent reviewers covered core persistence, engine behavior, and UI integration; the primary reviewer checked execution/preparation boundaries and validated the findings. No skills or previous review reports were used. No production code was changed, and the live application/database was not modified by this review.

## Confirmed findings

Subsequent implementation and validation: all six findings below were fixed.
See [the review-fixes report](projects-review-fixes-report.md) for changes,
regressions, real browser evidence and remaining limits. The findings below retain
their original review wording.

### 1. P2 — A hook-blocked Claude prompt never completes

Location: upstream `packages/agent-server/src/core/agents/claude-code/generator-session.ts:317–323`; shipped here in `patches/@zvada%2Fagent-server@0.3.8.patch:98–104`.

The new result filter assumes that every successful completion of the submitted prompt has a matching replayed user message. A `UserPromptSubmit` hook returning `{ decision: "block", reason: "..." }` is a counterexample: the installed SDK emits a `result:success` containing the rejection explanation without that user replay or `user_message_uuid`. The filter drops it and never completes the turn.

The engine reviewer reproduced this first against the actual SDK and then the patched generator, using isolated configuration, disabled persistence, and an unreachable dummy provider URL so no model request was needed. After five seconds the generator remained `busy`, the tap was unfinished, and it had received only command lifecycle/system events. The open prompt queue does not terminate, and no idle timer runs while busy. This affects ordinary Claude sessions as well as Projects.

Fix: represent prompt admission/completion independently of the replay-only signal; preserve hook-blocked completion without accepting unrelated resumed background results. Add a blocked-hook regression case alongside the existing background-result boundary tests.

### 2. P2 — Acceptance does not close assignment execution consistently

Locations: `apps/backend/src/services/projects/service.ts:310–316`; `apps/backend/src/services/projects/store.ts:513–551`.

Reproduction: finish/report A → Pause → queue instructions B → accept report A → Resume. Acceptance checks only whether the reporting turn ended. The pending input remains attached to A, and reservation executes it using the latest assignment without checking that assignment is open. B therefore runs and reports under an accepted assignment. After B finishes, the Project is `idle`, the old A report remains accepted, and the agent exposes `canRetry=false`.

Confirmed with the real store and Node 22/better-sqlite3; the primary reviewer reran the probe. Source: `.context/core-review-probe/assignments-node.ts` (bundled executable beside it).

Fix: put the invariant behind an assignment transition operation. Reject acceptance when the same assignment has pending inputs or an open dispatch, or deliberately transfer pending work into a fresh assignment. Reservation should retain input assignment ownership and refuse accepted assignments. Other contributors' assignments need not block acceptance.

### 3. P2 — Fresh managed composers lose cross-panel drafts

Location: `apps/web/src/features/projects/ui/ProjectComposer.tsx:34`, `116–122`.

Open a fresh managed workspace and click Review code or send a diff comment to chat before typing in its composer. These actions write to the shared store's `pendingContent` until the composer has been initialized. ProjectComposer reads only `composers[sessionId].draft` and seeds only on the first text change, so the staged message stays invisible. That first text change seeds the pending content and then immediately replaces it with the typed value.

Confirmed using the actual shared store: an appended review prompt was pending but invisible; the first keystroke left only that character and deleted the pending text.

Fix: use the shared composer initialization behavior on mount, preserving pending content. Reusing the store without its lifecycle contract is the abstraction mismatch here.

### 4. P2 — Coordinator chat opens resources into an invisible workspace

Location: `apps/web/src/features/projects/ui/ProjectDetailView.tsx:206–218`.

Click a workspace file, HTML preview, or ordinary browser link in the embedded coordinator conversation. TextBlock and ChatResourceCards update workspace layout/browser state, while MainLayout keeps MainContent unmounted under the Project view. The click consequently appears inert. The provided `onRevealWorkspace` callback is used only for the login-terminal action, not resource actions.

Confirmed by following both resource-opening paths and the desktop layout branch. Explicit Open workspace still works.

Fix: pass a host resource-opening/reveal action through the session context and invoke it when opening resources. The shared chat must not assume that its workspace is already visible.

### 5. P2 — Report and document links bypass application navigation

Locations: `apps/web/src/features/projects/ui/ProjectOverview.tsx:191–193`; `apps/web/src/features/projects/ui/ProjectFileDialog.tsx:140–143`.

Both new MarkdownRenderer uses omit link handlers. In the connected web app, an ordinary HTTPS link therefore navigates the current app tab away from Deus; relative document links resolve against the app URL instead of the Project's versioned content. This can also discard in-memory drafts on navigation.

Confirmed from the default renderer's anchor behavior. This is distinct from finding 4: report documents do not use the existing chat resource handlers at all.

Fix: handle external links explicitly and resolve Project document references against the displayed content revision, including historical reports.

### 6. P2 — Capacity-waiting agents are exposed as idle

Location: `apps/backend/src/services/projects/store.ts:763–769`.

With contributor concurrency set to one, reserve a dispatch for contributor A and leave ready contributor B waiting for capacity with its initial input. B cannot reserve a dispatch, but the detail projection labels it `idle`. Both the UI and `get_agent_status` consume this projection, so the human and coordinator receive an incorrect account of outstanding work.

Confirmed with the real store/SQLite. Source: `.context/core-review-probe/queue.ts` (bundled executable beside it); the primary reviewer reran it.

Fix: select and use the pending-input indicator already present in the query. A ready agent with eligible pending work should be queued even before a dispatch is reserved.

## Additional abstraction feedback

Delivered agent questions currently retain their input ID but omit their sender (`store.ts:533–538`). A two-contributor probe demonstrated questions delivered in A/B order and outcome records in B/A order, without a direct question-to-agent association. The coordinator can recover that association by inspecting transcripts, so this is not counted among the six confirmed failures. Nevertheless, preserving source agent/session/turn metadata in the delivered message is a small, useful improvement: `send_to_agent` requires both an agent ID and the question's `replyTo` ID.

The main boundaries remain reasonable for local execution: a managed Agent owns a workspace, the existing session/turn pipeline executes it, and Project coordination remains in the backend. These findings do not justify extracting a general workflow engine or a speculative cloud SDK. The useful refactors are narrower: enforce assignment transitions together, preserve input identity through dispatch, share composer initialization, and make resource navigation an explicit responsibility of the chat's host.

## Review limits and exclusions

This was a focused code review with isolated probes, not a repeat of the previous full test suite or UI qualification. The existing broad tests do not cover the failure cases above. No model-backed product turn was launched for this review.

Preparation continues through Pause, but the documented promise specifically concerns cancellation of active turns; this was not promoted to a cancellation bug. Source restart deliberately requires explicit reconciliation and already has a test asserting that behavior; it was not misreported as a missing automatic retry. Deferred cloud execution, interrupted setup recovery, and continuous GitHub status refresh were not treated as regressions.
