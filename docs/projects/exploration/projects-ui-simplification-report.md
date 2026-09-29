# Local Projects — shared UI and cancellation qualification

15 September 2026. This supplements the earlier implementation/review reports. The authoritative shipped-behavior guide is [docs/local-projects.md](../../../docs/local-projects.md). Cloud execution remains future work.

## Product changes

Projects appear directly below Automations in the sidebar, with collapsible rows and pushed Working/Queued/Ready/Done states. There is no all-Projects screen. The plus opens the same prompt modal used for workspaces: one brief, fixed local Claude model, and a title derived from the first line. Ordinary workspace creation retains its branch/cloud/empty-prompt behavior.

Project detail shares the workspace header, split-panel controls, chat, composer, model display and content tabs. Overview and Documents are the two Project-specific tabs beside existing Files, Changes, Terminal and other available workspace tools. Opening an agent workspace retains a Back to Project action, including content-only and phone layouts. Drafts survive navigation. Permanent Pause/Resume controls are removed; shared Stop and contextual recovery remain.

Documents use the existing FileTree and the shared FilePreview extracted from FileViewer. Logical folders come from the immutable Project manifest; there is no second document-list model. Current context files are editable with expected-revision conflict handling. Result links open pinned read-only bytes in the same pane. The phone layout opens a full-width preview with Back to files. The shared tree now replaces programmatic selection rather than adding a second selected file, and expands selected ancestors explicitly.

The design file and README mapping were updated through Pencil and saved. The old all-Projects frame is marked historical.

## Real browser qualification

Driven in visible Chrome with actual DOM clicks/typing, at 1440×900 and 390×844. Phone qualification uses a responsive viewport, not physical hardware. Native computer-use attachment had timed out earlier; Playwright controlled the visible browser. Prior reports separately record Electron shell qualification.

- Sidebar placement, disclosure, live state and no all-Projects route.
- Shared creation, fixed model, ordinary workspace parity, phone Enter/newlines.
- Project → agent workspace → Project with retained draft; expand/restore panels and Files/Changes.
- Folder navigation, Markdown/source toggle, pinned result file, correct single selection, selected-folder expansion, close/reopen.
- Two-browser publication conflict: preserve local draft across pushed revision, reject stale publication, compare latest bytes, explicitly publish. Original brief restored afterward.
- Lost creation responses: actual server creation succeeded, two response failures exhausted automatic retry, manual retry reused the same ID and returned one Project. Coordinator report accepted, row showed Done, test project archived without deleting evidence.
- Fast Stop all after send plus queued follow-up: actual engine cancellation after 1,348 ms; cancelled prompt has only its user echo, no assistant/tool execution. Successor dispatched once after the first terminal and published one accepted report.
- Shared composer Stop while a confirmed foreground Node timer was running: observed PID exited 149 ms after the click; engine recorded cancelled. Contextual recovery ran one follow-up in the same native conversation; accepted report showed Done.

Live cancellation evidence: [project-ui-cancellation-final-evidence.json](project-smoke/project-ui-cancellation-final-evidence.json), [warm Stop log](project-smoke/project-ui-warm-stop.log), [queued Stop log](project-smoke/project-ui-queued-stop.log). The final fixture has no open dispatches; SQLite integrity check is `ok` and foreign-key check is empty.

## Bugs exposed and repaired

The live fast-Stop exercise exposed three real cancellation windows: cancellation while SDK startup/idle waits were pending; runtime admission before the harness began tracking the turn; and the public Claude SDK interrupt leaving queued prompts runnable. Cancellation is now retained from admission, checked after waits, and queued prompt shutdown waits for actual child exit before ending the turn. Ordinary admitted interrupts keep their existing warm-query path. Stream failure also waits for exit, and delayed interrupt receipts are scoped to their original prompt.

A public SDK spawn hook tracks exit; no private SDK control calls or duplicate kill timer were added. Deterministic tests include a real SDK child that ignores SIGTERM and reaches the SDK's forced kill. The downstream patch remains explicit until an upstream release carries it. Fresh-install testing also caught Bun's new-file patch mode issue; the small process tracker was moved beside its sole owning generator instead of adding install-side permission workarounds.

Separately, a definitive `turnActive` rejection preserves the prepared Project dispatch, inputs and request ID and retries only after the existing turn ends. Unknown admission remains uncertain. This avoids losing queued instructions while preserving the one-writer boundary.

## Automated validation

- Backend: 1,140 passed / 92 files.
- Deus agent-server: 88 passed, seven conditional skips / 13 files.
- Frontend/shared: 864 passed / 105 files.
- Upstream non-live core/server: 492 passed, one conditional skip / 53 files.
- Application typecheck, targeted UI lint, upstream TypeScript/Biome, diff checks and web/agent-server builds passed.

The final six-file patch also passed a frozen install from an empty verification directory with a fresh private Bun cache: all six files byte-match upstream, the lock stayed unchanged, and no extra directories or obsolete helper file appeared. [Install evidence](bun-patches/queued-cancel/six-file-final/verification.json). After rebuilding and restarting, a final browser smoke verified retained Done/report state and desktop/phone document navigation with no page errors.

Full suite logs and browser scripts are retained in [project-smoke](project-smoke/). Earlier failed attempts are preserved as diagnostic history; their generic PASS lines are not proof of cancellation. The final evidence above checks actual engine outcomes, persisted tool activity and process exit.

## Remaining boundaries

Local Projects are useful for bounded parallel tasks with human acceptance. This does not establish reliable model initiative on every prompt, arbitrary active-process crash recovery, durable offscreen human approvals, or production cloud execution. Real GitHub PR creation/merge was not exercised; association/provenance has automated coverage. Keep those qualifications explicit rather than adding speculative frameworks to this local implementation.
