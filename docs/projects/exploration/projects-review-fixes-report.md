# Projects review fixes and live qualification

14 September 2026. Follow-up to [the independent review](projects-independent-code-review.md).
All six findings were fixed. Browser qualification exposed additional navigation
and title ownership issues, which were also fixed. No release, push or PR was performed.

## Changes and architectural judgment

| Area                     | Failure addressed                                                                                       | Result                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude prompt ownership  | Hook-blocked prompts can finish without a user replay; replay-only admission left them running forever. | Matching command-started lifecycle admits the prompt. Foreign lifecycle IDs and unrelated background results cannot close it.                                                      |
| Result acceptance        | An older report could be accepted while its assignment still had queued/running work.                   | Acceptance checks outstanding work in its transaction; rejection leaves the operation retryable. Instructions after acceptance create a distinct assignment.                       |
| Dispatch selection       | Historical inputs could be selected as current work or exhaust the selection batch.                     | Current open assignment, session and generation are filtered in SQL before the batch limit. Historical evidence stays intact.                                                      |
| Shared composer          | Staged review prompts/diff comments were absent before typing in managed sessions.                      | Project composer restores shared session draft state and forwards send completion.                                                                                                 |
| Status and messages      | Agents waiting for capacity appeared idle; questions lacked explicit sender identity.                   | Ready pending agents are Queued; delegation, questions and replies retain source Agent/session/turn.                                                                               |
| Embedded chat navigation | Links changed hidden workspace state; connected web selected an unavailable Browser tab.                | Hosts reveal the pane, use the shared phone file dialog, or open a separate preview. Browser capability and settings govern routing.                                               |
| Published documents      | Relative Markdown links escaped the selected revision or left Deus.                                     | Targets resolve against the pinned manifest; missing/empty targets are disabled; external links open separately. Context edit permission survives navigation through result files. |
| Automatic titles         | A resumed coordinator emitted a machine outcome envelope as a conversation title.                       | Managed session titles belong to the dedicated workspace, preserving assigned names at the existing persistence boundary.                                                          |

The abstractions remain focused: Project owns durable admission and evidence;
workspace/session owns execution and transcript; the existing event path persists
terminal facts; chat hosts decide how to reveal resources. The fixes reuse the
composer, file viewer, Markdown renderer and title writer. No general workflow
engine, new transport, cloud SDK or parallel transcript renderer was added.

Durable scheduling across cancellation, acceptance and unknown execution state is
the complex part. Assignment/dispatch/input records are doing necessary work; I
would retain them and their transactional guards. This is a sound foundation for
continued local use. Cloud ownership and execution still require implementation
and qualification.

## Automated qualification

- Backend: final full suite **1,137 passed in 92 files**, including the title guard.
- Frontend/shared: **842 passed in 100 files**.
- Deus agent-server: **88 passed, 7 conditional skips**.
- Upstream agent-server: **740 passed, 7 conditional skips**.
- Application, backend and agent-server typechecks passed. Web, backend and
  agent-server builds passed; Vite retains its existing large-chunk warning.
- Final UI lint: no errors; six existing MarkdownRenderer `any` warnings.
- A fresh frozen Bun install reproduced the explicit upstream patch byte-for-byte.
  Deus still pins agent-server 0.3.8 with `patches/`; upstream work is in the linked
  `agent-server/thimphu` workspace. It has not been published upstream.
- Live SDK checks completed two hook-blocked prompts and a cold-resumed blocked
  prompt without leaving the session busy.

Logs are in [project-smoke](project-smoke/), including
`review-fixes-final-backend-tests.log`, `review-fixes-final-frontend-tests.log`,
`review-fixes-agent-tests.log`, `review-fixes-upstream-tests.log`, and build/typecheck
logs. Relevant backend tests use real SQLite, Git worktrees and WebSocket integration
alongside unit tests. Deterministic regressions cover stale sources, duplicate
effects, uncertain dispatches, queue cancellation and acceptance.

## Actual browser exercise

Created **Review fixes — local qualification** through the visible UI with Sonnet
4.6 and exactly two contributors. The isolated database is
`.context/project-smoke/deus.db`; the fixture repository is under
`.context/project-smoke/`. Creation, messages, queue removal, Pause/Resume and
acceptance used UI controls. Read-only SQLite queries corroborated persistence;
no database writes repaired or advanced the exercise.

1. Contributor one asked the coordinator about its greeting format, yielded,
   received the reply and implemented `greeting.js` plus a Node test.
2. Contributor two created `index.html` with a Ready → Passed button and
   `docs/check.md`. Both published files and reports.
3. Durable outcomes woke the coordinator, which integrated all four files and
   published the combined report at revision 3. An independent `node --test
greeting.test.js` run passed. Browser clicks verified the delivered button.
4. A staged Review Changes prompt appeared immediately in the managed composer.
   The shared draft behavior also has regression tests.
5. Report links opened the correct pinned source/document. External HTTPS links
   opened separately while Deus retained its URL.
6. A queued instruction while paused blocked acceptance with the intended error.
   Removing it through the queue permitted acceptance.
7. Desktop source links revealed Files. Phone source links opened a readable
   dialog at 390×844. Desktop web and phone HTML previews opened working separate
   pages and preserved the Project view.
8. Queued a follow-up after acceptance, stopped/restarted the isolated backend and
   agent-server, reloaded the frontend, and confirmed that pause, queued input and
   accepted report survived.
9. Resume dispatched the follow-up once in the same conversation. The coordinator
   published “Follow-up acknowledged” at revision 4; it was accepted under its new
   assignment. The original assignment still points to its original accepted report.
   Nine dispatches finished; zero open dispatches or pending inputs remained.
   SQLite integrity and foreign-key checks passed.

Screenshots are in [project-smoke/ui](project-smoke/ui/):

- `review-fixed-composer.png`
- `review-acceptance-guard.png` and `review-accepted-after-removal.png`
- `review-pinned-report-link.png`
- `review-desktop-file-navigation.png` and `review-desktop-preview-fallback.png`
- `review-mobile-file-dialog.png` and `review-deliverable-working.png`
- `review-restart-queue-preserved.png` and `review-followup-accepted.png`

The run caught the unavailable Browser-tab bug; it was fixed and retested. The
first coordinator turn only loaded tools and promised to start. One explicit
human-style nudge was needed before delegation. Subsequent question/reply, outcome
delivery, integration and restart follow-up used the normal flow. This demonstrates
useful coordination; it does not establish reliable model initiative on every run.

Native computer-use attachment timed out, so this pass drove visible Chrome with
Playwright DOM controls and screenshots. Phone checks used responsive viewport
sizes, not physical hardware. Earlier qualification separately records an Electron
launch and the larger Pocket Ledger exercise.

## Remaining boundaries

This restart was paused/settled with queued work. It does not establish recovery
from every active process kill, power loss or interrupted setup script. Unknown
execution remains conservative and requires reconciliation. Real GitHub PR
creation/merge was not exercised here; associations have automated coverage.
Cloud execution was neither implemented nor tested.

Next product work includes cloud ownership/executor integration, broader model
qualification and less technical presentation of machine outcome envelopes.
These do not require replacing the local Project/workspace/session model. Keep
the upstream patch explicit until a released version includes the qualified fixes.

The implementation guide is [docs/local-projects.md](../../../docs/local-projects.md).
Design changes are saved in `design/deus.pen`: `30q` for queue/composer/acceptance
and `73r` for the phone file dialog, mapped in `design/README.md`.
