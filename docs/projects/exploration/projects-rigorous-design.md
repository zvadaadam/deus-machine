# Local Projects: independent product/design and test-credibility review

Reviewed 2026-09-14 against the current working-tree implementation, including untracked Project modules. This is a source-traced review; the root reviewer owns live UI and real-model verification. I made no production changes, started no app, and contacted no external services.

Scope: the declared local, one-repository, fixed-Claude-model, current-conversation implementation in `docs/local-projects.md`. Missing cloud execution, fresh managed conversations, folder coordinators and multiple repositories are not findings. `AGENTS.md` and `CLAUDE.md` were read. The required `.claude/skills/deus-code-style/` directory is absent, and no matching installed skill was found; review follows existing token/component conventions.

## Assessment

The core shape is useful and reasonably restrained: the backend owns durable inputs and scheduling, children use separate existing worktrees, the agent-server relays scoped tools, and the frontend reuses the existing conversation renderer. Immutable file revisions, per-dispatch frozen prompts, explicit outcome delivery and operation receipts address real coordination problems. There is no reason to extract a generic workflow engine or cloud abstraction for this scope.

The human control surface is less complete than the durable backend. In particular, instructions can become invisible while queued, idle execution is presented as a reviewable result, and the reused error UI includes recovery buttons with no action. These are observable behavior issues, not aesthetic preferences.

## Findings

### P2 — Queued directions disappear before they enter the transcript, with no inspection or correction surface

Primary locations:

- `apps/web/src/features/projects/ui/ProjectComposer.tsx:49`: an accepted request clears the draft and shows only a transient “Message queued” toast.
- `apps/web/src/features/projects/ui/ProjectDetailView.tsx:261`: only an aggregate queued-message count is shown.
- `shared/projects.ts:97`: the detail DTO has `pendingInputCount`, but no pending input IDs, text, recipients or delivery states.
- `apps/backend/src/routes/projects.ts:25`: messages can be appended; there is no endpoint for listing, superseding or cancelling queued inputs.
- `apps/backend/src/services/projects/store.ts:423`: queued directions are stored in `project_inputs`; the conversation prompt is built later at `:522` and sent at `service.ts:654`.

Scenario: pause a Project, send “Change the button label to Save”, then “Also rename the export”, and leave/reopen the page. The draft is gone, the current transcript cannot show either direction yet, and the user sees a count. They cannot confirm the exact text or recipient, remove a mistaken instruction, or distinguish a human instruction from a child outcome counted in the same number. They can append a correction, but the unwanted instructions remain executable. Sending while an agent is busy produces the same gap until the next dispatch.

Minimum correction: expose durable pending inputs per recipient with their exact text and state. Permit cancelling/superseding inputs only before dispatch reservation, and make a reserved/uncertain input visibly non-editable. This directly uses the existing input identity and `superseded_at` model rather than adding another queue.

### P2 — “Ready for review” means merely no open dispatch, even without a result or with queued work

Primary locations:

- `apps/backend/src/services/projects/store.ts:880`: `projectSummary` falls through to `ready` whenever there is no archive, Project pause, attention, exhaustion, preparation or open dispatch.
- `apps/backend/src/services/projects/store.ts:801`: the summary projection does not consider pending inputs or a reviewable coordinator report/current assignment.
- `apps/web/src/features/projects/ui/ProjectStatus.tsx:14`: `ready` becomes a green check and “Ready for review”.

Scenario A: a coordinator completes a normal turn saying it needs further direction, without publishing a report. Once that dispatch closes, the Project is green “Ready for review” with zero results. Scenario B: agent-server is disconnected but the backend/browser remain connected, and a human queues work into an otherwise idle Project. `runProjects` returns at `service.ts:587`; the Project remains “Ready for review” while work is queued and cannot run. Individually stopped members are also not reflected in the Project summary once their turns settle.

The normal idle case has `canRetry` in the DTO, but `ProjectOverview.tsx:97` shows Continue only if the agent or Project is paused or the agent needs attention. The user can manually send another instruction, yet the overall label incorrectly implies delivered work.

Minimum correction: separate idle/waiting from reviewable output. Base “Ready for review” on a settled coordinator report for the relevant assignment, while showing pending work and executor unavailability explicitly. Do not interpret all quiescence as success.

### P2 — Managed conversation error recovery renders buttons that do nothing

Primary locations:

- `apps/web/src/app/layouts/ChatArea.tsx:168`: managed workspaces intentionally pass no `onOpenNewTab`.
- `apps/web/src/features/projects/ui/ProjectDetailView.tsx:205`: embedded Project conversation also supplies no `onOpenNewTab`.
- `apps/web/src/features/session/ui/SessionPanel.tsx:318`: `handleRetryInNewChat` only calls `onOpenNewTab?.()`.
- `apps/web/src/features/session/ui/SessionPanel.tsx:392` and `:500`: that wrapper is still always passed to Chat as a defined callback.
- `apps/web/src/features/session/ui/Chat.tsx:457`: Chat renders New session / Retry in new chat for context limits, rate limits, network failures, process exit and general errors whenever the callback is defined.

Scenario: a managed Claude turn fails with a network/process error or reaches context limits. The user clicks the visible retry/new-session action. Nothing happens because the wrapper closes over an absent callback. This affects both the Project view and the child workspace view.

Fresh managed conversations being deferred is acceptable. Advertising them as functioning error recovery is not. Supply an explicit managed recovery action that maps to supported Continue/Resume, or omit the button and explain the available recovery. The ordinary conversation renderer can remain shared; its recovery capability needs to be explicit.

Related source observation, not independently reproduced: the embedded Project's authentication “Log in” handler at `SessionPanel.tsx:309` only changes workspace layout and queues a terminal command; it does not navigate out of the Project view. Check that the action actually reveals the terminal to the human.

### P2 — A routine file revision conflict leaves the document editor with no way to complete the edit

Primary locations:

- `apps/web/src/features/projects/ui/ProjectFileDialog.tsx:31`: the document is loaded with the revision fixed when the dialog was opened.
- `apps/web/src/features/projects/ui/ProjectFileDialog.tsx:43`: every save uses the same original `file.revision`.
- `apps/web/src/features/projects/ui/ProjectFileDialog.tsx:46` and `:96`: failure retains the draft and displays an error, but no latest-version read/rebase/compare action exists.
- `apps/backend/src/services/projects/store.ts:601`: publishing correctly rejects a stale global content revision.
- `apps/backend/src/services/projects/store.ts:645`: every result report advances that same global revision, including a report with no files.

Scenario: open and edit `brief.md`, then let a child publish a report while the dialog remains open. Publishing the brief now returns “Project files changed. Read the latest revision and retry your edit.” Further Publish clicks always send the old revision, even if the brief itself did not change. The UI cannot follow its own recovery instruction. Closing/reopening obtains the newest version but loses the in-memory edit; the human must manually copy it elsewhere and paste it back.

Keep conditional publication. Add an explicit latest-version comparison/retry path that retains the draft; if only unrelated files changed, safely refresh the expected manifest revision after verifying the edited file's base hash still matches. Do not silently overwrite another editor's changed brief.

## Assignment provenance issue handed to boundary reviewer

Independent source trace identified an acceptance/concurrent-turn race: `controlProject` at `service.ts:239` checks closure of the report's own turn only; accepting an older report can mark the assignment accepted while a later dispatch is running. New input then creates a new assignment (`store.ts:411`), but an old active dispatch's `report()` chooses the latest assignment (`store.ts:630`) rather than its dispatch assignment. The root's boundary/correctness reviewers own deterministic verification and severity for this issue, so it is not duplicated above.

## PRs, usable output and questions

- PR association/provenance separation is sensible. `pull-requests.ts:105` requires an actual persisted report source, and workspace lookups deliberately avoid inventing a creator turn (`:151`). Two batched queries avoid PR-by-PR database work (`:229`).
- PR status is only a cached observation. The UI uses any non-null `checkedAt` as verified (`ProjectPullRequests.tsx:27`) but does not display its age. Report-only links are correctly labelled “Reported link”. Independent PR refresh is explicitly deferred; do not claim an always-current PR monitor. Displaying “last checked” and providing an explicit refresh would make the limit understandable without adding a polling service.
- Reports link to the correct agent conversation/workspace, and result files are read at the report's pinned revision (`ProjectOverview.tsx:209`). This preserves review evidence. Accept does not merge code; that is consistent with the documented scope.
- There is no structured code integration contract in report metadata: report fields contain summary, text documents and PR URLs, with no commit SHA/target integration reference. The coordinator prompt asks for a combined result but does not specifically require committing, integrating children and validating the combined tree (`store.ts:515`). This is a live qualification gap, not proof of a code defect: a real coordinator may use Git competently. The root's two-child deliverable exercise should verify that the final product exists in one usable checkout and passes combined tests, rather than merely yielding two successful reports.
- Existing structured human question overlays remain wired in the shared SessionPanel (`:403`). Contributor-to-coordinator questions are durable Project inputs, only admitted after their source turn yields (`store.ts:465`). The Project overview has no explicit “waiting for your answer” state; actual native questions from an offscreen child should be exercised before claiming human attention handling is complete.
- Browser/backend reconnect UI exists: `ProjectsPage.tsx:30` includes ConnectionBanner, and `useQuerySubscription.ts:71` recreates subscriptions on reconnect. Do not report an absent reconnect banner. Agent-server connectivity is a different boundary; its disconnect callback currently only logs (`services/agent/service.ts:101`).

## What the automated tests actually establish

The new tests are valuable; their use of mocks does not invalidate their limited claims. The documentation already states scripted execution and simulated owner restart. The large overall suite count should not be interpreted as end-to-end reliability of every new Project behavior.

- `projects.test.ts` exercises real SQLite transactions, immutable blobs, queue reservations, limits, question/reply constraints, outcome deduplication and bounded projections. Its helpers create session/ready rows directly, so it does not establish executor behavior.
- `projects-wire-integration.test.ts` uses real Hono routes, SQLite, Git workspace preparation, the Project scheduler, backend agent link, upstream wire server and lifecycle persistence. That is a useful integration test.
- However, it mocks `query-engine.invalidate`, WebSocket broadcast and PR refresh (`:22–27`). It therefore does not establish frontend WS snapshot/delta correctness or reconnect rendering.
- Its `invoke()` directly builds source session/turn/invocation IDs and calls `HostRpc.requestProjectTool` (`:67–80`); it bypasses the actual Claude MCP handler/tool schema/source capture. Those pieces have separate unit tests.
- It replaces the runtime's execution, admission and cancellation (`:232–257`). The scripted child publishes text claiming tests passed (`:175–179`) but writes no implementation files and runs no combined-product tests. The wire test is a coordination test, not a delivered software test.
- “Owner restart” is `stopProjects(); startProjects()` in one process (`:382–383`), with the same store, database handle, runtime and module memory retained. The test does not prove operating-system crash recovery, actual SDK resumption, lost acknowledgements across process lifetime, or setup-script interruption recovery. The docs appropriately disclaim broad crash proof.
- `projects-tools.test.ts` mocks HostRpc, while `projects-engine-source.test.ts` separately checks per-engine source binding. Together they offer good local evidence, but a real Claude run remains necessary for the full tool path.

Useful next evidence is targeted: visible queued-instruction handling, two contributors with combined integration, a real human question, a failed turn's supported recovery action, and loss/reconnect while work is admitted. Broad additional mocked happy-path tests would not close these gaps.

## Follow-up implementation requested by root

After the independent review, the root reviewer authorized fixing the dead recovery actions. Changed `SessionPanel.tsx`, `Chat.tsx`, and `ProjectDetailView.tsx` only:

- Managed error cards now offer **Project controls**. From the Project's embedded coordinator conversation this switches mobile to Overview, scrolls the overview to the Agents controls and focuses it. From a managed workspace it opens that Project; its Overview tab and Project controls are available there.
- Ordinary New session / Retry in new chat is supplied only when tab creation has a real callback. The “Start a new chat” rate-limit instruction is likewise conditional on that capability.
- **Log in** in the Project's embedded coordinator conversation sets the workspace terminal and pending login command, then reveals the coordinator workspace so the terminal is visible.

Validation: `bun run typecheck` passed; ESLint on the three files passed with zero errors and the existing TanStack Virtual React Compiler compatibility warning in Chat; formatting and `git diff --check` passed. No native rebuild or UI automation performed. Root owns live UI verification and matching Pencil design synchronization. The other review findings above remain open unless addressed by root/other reviewers.

### Document conflict recovery and final design synchronization

Root subsequently authorized implementing the document conflict flow and owning its Pencil sync. `ProjectFileDialog.tsx` now retains the draft after a publication conflict, disables publication until **Load latest version** succeeds, displays the latest read-only content next to the retained editable draft (vertically), and offers **Publish my draft** using the loaded revision and a fresh request ID. Loading does not publish. Further concurrent publication causes another conflict and requires another load; a failed load keeps the draft and retry action. Cancelling discards the edit explicitly and resets the comparison state. Frontend typecheck, targeted ESLint, formatting and diff whitespace checks passed.

Pencil synchronization is saved in `design/deus.pen`, accessed only via Pencil MCP. The active file was verified as this worktree. Added `DS/ProjectMessageQueue`, `30p` managed recovery/status states, `49r` desktop queued instructions, `73q` mobile queued instructions, and `66r` / `66s` conflict/comparison dialogs. Updated `49p` with idle/queued examples and `design/README.md` with the mappings. Root's queue component and the correctness reviewer's new status labels are represented. All colors, fonts and radii reuse existing variables; existing reusable buttons and chat/sidebar components were reused. The Project component board was repositioned above its screens after growing it to avoid overlap.

Visual verification: inspected screenshots after saving/relaunching Pen to clear its known stale render/layout cache; the final desktop/mobile and recovery screenshots rendered correctly and structural checks reported no clipped nodes in the new desktop composition or component board. Exported review images to `.context/projects-review-design/`: `GkwPL.png` (conflict), `YTE7e.png` (comparison), `FbS3q.png` (recovery/statuses), `jB9yQ.png` (desktop queue), `KELgf.png` (mobile queue). No main-app UI interactions or native rebuild were performed by this reviewer. Root still owns actual app verification.

Final synchronization correction: moved the overview queue below all Agents and before Pull requests in both `49r` and `73q`, matching `ProjectOverview.tsx:154`. The composer queue stays above its input. Verified the resulting child order and mobile screenshot, saved the design, and refreshed desktop/mobile exports.

Live verification reported by the root reviewer: actual two-tab document conflict, latest-version comparison, merging edits and explicit publication all passed through the main UI. The real error card's **Project controls** navigation also passed. These are root-observed checks, distinct from this reviewer's source/typecheck/Pencil verification.

Final artifact readability sync: root implemented relative artifact labels and dialog titles, removed report-owned files from Context, and used Shiki source rendering for non-Markdown files. Updated `DS/ProjectResult` to `review.md`, synchronized Context descriptions in both original and queued desktop/mobile Overview states, and added `66t · Project result — source file` (`yAmFH`). Its monospaced, whitespace-preserving read-only source depicts the immediate plaintext fallback before syntax highlighting loads, retaining the published version and result provenance. Inspected source-viewer, result, desktop and mobile screenshots; saved Pen and exported `yAmFH.png` / `YVSMX.png` alongside refreshed queue screenshots. `design/README.md` records the implementation mapping. Main-app verification remains root-owned.
