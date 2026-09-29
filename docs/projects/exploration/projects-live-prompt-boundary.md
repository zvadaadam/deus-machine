# Live Pocket Ledger prompt-boundary failure

Read-only evidence captured 2026-09-14 from the isolated `.context/project-smoke/deus.db` and `rigorous-runtime.log` / `rigorous-restarted.log`, plus the Claude-native JSONL transcript. No live agents or UI were controlled during diagnosis.

Project: `01a0a0de-73d7-7437-8649-7abfa3247dfe` (Pocket Ledger — parallel delivery test).
UI contributor: `01a0a0e1-1ce4-7d92-92f7-0bc6c5526461`.
Logical session: `01a0a0e1-1ce4-73bb-acd0-332c5515ad40`.
Native session: `dfd4952d-e1f3-4179-96e0-8c4b2c823992`.
Installed engine: `@zvada/agent-server` 0.3.8, Claude SDK/CLI 0.3.220.

## Demonstrated symptom

This was an engine turn-boundary failure, not the model choosing to emit no answer. A resumed query drained a background-shell notification before processing the submitted user prompt. The notification generated a successful SDK result, and the engine attributed that result to the submitted prompt. It closed the tap, freed the active turn, and silently dropped real model output produced afterward. A subsequent coordinator nudge attached another tap and inherited the original prompt's ongoing output.

The prompt itself was not lost from Claude's native queue. Its ownership and output were lost at the engine boundary. This is material for Project capacity, source-turn authorization, accounting, and the reliability of the visible transcript.

## Minimal trace (UTC, task/file contents omitted)

| Time                      | Evidence                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17:05:02.745–17:11:03.927 | DB turn `01a0a0e1-1d15-7deb-8c80-ad22f99dffe6`: real work; output 31,542 tokens; stopReason `max_turn_requests`, finishReason `tool_use`; request maxTurns 24.                                                                                                                                                                                             |
| 17:11:04.008–17:11:05.458 | DB turn `01a0a0e6-a039-7217-a0fa-2d7c1a477e77`: success, input/output/cache/cost all zero, only user echo persisted.                                                                                                                                                                                                                                       |
| 17:11:05.343              | Native JSONL line115: enqueue a stopped-background-shell notification.                                                                                                                                                                                                                                                                                     |
| 17:11:05.422              | Native line117: enqueue Project input `01a0a0e1-f9b7-7fc3-8154-79d9101f9a01`.                                                                                                                                                                                                                                                                              |
| 17:11:05.458              | Native line124: dequeue; exactly when the DB turn ends.                                                                                                                                                                                                                                                                                                    |
| 17:11:05.466              | Native line125: Project input becomes a user message, after the DB turn has ended.                                                                                                                                                                                                                                                                         |
| 17:11:20.188–17:12:35.269 | DB turn `01a0a0e6-df72-7fcf-9397-eb92378db164`: another nudge, inherits ongoing work; output 6,418 tokens. Native line129 enqueues this nudge, line138 later removes it as an in-flight user message. It ends when the project is stopped; SDK error_during_execution with stop_reason tool_use is the separately fixed cancellation-classification issue. |
| 17:15:42.834–17:15:44.077 | After owner restart, DB turn `01a0a0ea-e16d-7911-a1a4-506f70284f0d`: again zero-token/$0 success, only user echo. Restarted runtime log51–56 confirms no assistant events.                                                                                                                                                                                 |
| 17:15:44.030              | Native line176: enqueue stopped-background-shell notification.                                                                                                                                                                                                                                                                                             |
| 17:15:44.053              | Native line178: enqueue Project input `01a0a0ea-e166-7f8c-81f3-4a2ff525e915`.                                                                                                                                                                                                                                                                              |
| 17:15:44.075–.076         | Native lines181/184: notification user message, then dequeue.                                                                                                                                                                                                                                                                                              |
| 17:15:44.083              | Native line185: Project input becomes a user message, 6 ms after DB turn end.                                                                                                                                                                                                                                                                              |
| 17:15:52.060–17:16:15.902 | Native lines188–215: model resumes, restarts static server, searches tool schemas, changes browser viewport, evaluates UI and screenshots it. These assistant/tool messages do not exist in the Deus DB.                                                                                                                                                   |
| 17:16:23.996              | DB starts turn `01a0a0eb-822c-7f77-a352-bec0e88167d3`, a nudge saying the last turn ended empty.                                                                                                                                                                                                                                                           |
| 17:16:24.018              | Native line218 enqueues that nudge while earlier work is still in progress.                                                                                                                                                                                                                                                                                |
| 17:16:44.207              | Native line220 / DB message40: the model's next paragraph about fixing mobile clipping now appears under the new DB turn.                                                                                                                                                                                                                                  |
| 17:16:52.000              | Native line228: nudge removed from queue and delivered as an in-flight input attachment.                                                                                                                                                                                                                                                                   |
| 17:19:23.550              | Native line239: report_result succeeds. DB report `01a0a0ee-3f97-7338-8b88-84c6bd157246`, revision6, files delivered.                                                                                                                                                                                                                                      |
| 17:19:35.092              | DB final turn ends with 22,702 output tokens and normal end_turn.                                                                                                                                                                                                                                                                                          |

Native source file (read-only): `~/.claude/projects/-Users-zvada-conductor-workspaces-deus-machine-libreville--context-project-smoke-repository--deus-project-01a0a0e1-c5526461/dfd4952d-e1f3-4179-96e0-8c4b2c823992.jsonl`.

The native JSONL does not persist the raw SDK result frame itself. Its notification-result ordering is inferred from the matching DB timestamps and the CLI's readable bundled source. The model work continuing after an already persisted terminal event is directly demonstrated, independent of that inference.

## Report tool and coordinator visibility

The UI agent had exactly one report_result invocation, and it completed successfully with the report ID above. There is no earlier report_result failure in stored tool parts. Its initial tool search included report_result, so the tool was available. The first genuine long turn exhausted its 24-request cap; the two brief turns were separate false terminal boundaries.

`read_agent_transcript` currently queries only text parts (`apps/backend/src/services/projects/service.ts:456–491`). The coordinator called it twice (limit30 then100) during diagnosis; tool-only messages appear as empty assistant rows. It cannot reveal tool requests/results/errors, and `truncated` has no page cursor. This is a useful product-tool gap, but adding tool parts would not recover the missing interval above because the engine dropped those events before persistence. There were no stored report failures for it to reveal.

`get_agent_status` returns the shared ProjectAgent DTO, including workspaceId but no workspace filesystem path or branch. It is enough to address another agent, but not to locate a contributor checkout for shell integration. Treat that as a bounded tool usability gap, separate from the engine failure.

## Upstream change (local, uncommitted)

Authorized linked worktree: `/Users/zvada/conductor/workspaces/agent-server/thimphu`, branch `projects-feature`.

- `packages/agent-server/src/core/agents/claude-code/generator-session.ts`: stamp a fresh UUID on each stdin prompt; record acknowledgment only for that exact UUID; ignore successful results until the current prompt is acknowledged and ignore an explicitly foreign user_message_uuid. Startup/resume errors remain visible before acknowledgment. A stream closing with an unfinished tap now fails instead of implying empty completion.
- `packages/agent-server/src/core/agents/claude-code/options.ts`: force CLI `--replay-user-messages` through existing extraArgs after operator overrides. This documented CLI flag emits user messages as acknowledgments; SDKUserMessage.uuid and SDKResultSuccess.user_message_uuid are in installed SDK types. No token-count heuristic, consumer filter, polling, or retrying user prompts.
- New `test/core/agents/claude-prompt-boundary.test.ts`: notification acknowledgment and zero/charged unrelated results before own acknowledgment; first turn stays busy and queued second send cannot relabel it; actual assistant output remains with first tap; genuine zero-token own completion; explicit foreign UUID result; startup error; unfinished-stream failure.
- Updated existing `test/core/agents/claude-turn-cost.test.ts` fixture to emit actual prompt acknowledgments.

This patch is deterministic-stream-qualified, not yet live-qualified or consumed by Deus. No installed node_modules edits, package pin change, commit, push, or release occurred in this subtask.

Validation of final local upstream patch: `bun run typecheck` passed; `bun run test` passed 739 tests across 76 files, with 7 live tests in 2 files skipped. Biome passed the changed generator/options/tests. Upstream base HEAD `b1c3e90903bf49caea0a9b6f1af1e542c43b5fb9`; all source/test changes remained uncommitted when handed to root for independent review.

## Consumer patch and live qualification (completed 2026-09-14)

The exact four reviewed source files now ship in Deus through `patches/@zvada%2Fagent-server@0.3.8.patch`, registered in root `package.json` and `bun.lock`. The original installed files matched upstream base HEAD byte for byte before preparation. The generated patch contains only the four named source files. Both root installation and a separate fresh frozen install under `.context/bun-patches/verification` match the reviewed upstream contents. Native SQLite and PTY binary SHA-256 values were unchanged. Consumer checks: 50 focused Project/cancellation tests passed; backend and agent-server typechecks passed; changed text files passed formatting. No release, push, or absolute local dependency path was used.

Bun's [official patch workflow](https://bun.com/docs/pm/cli/patch) is the reproducible dependency mechanism. Claude SDK0.3.220 has no first-class replayUserMessages option; its typed `extraArgs` option accepts CLI flags, and the [official CLI reference](https://code.claude.com/docs/en/cli-reference) documents `--replay-user-messages` as a stdin-message acknowledgment mechanism.

Root rebuilt and started the patched runtime, then submitted final guidance through the real UI. Read-only observation of `.context/project-smoke/rigorous-patched-runtime.log`, DB, and native transcript confirmed the original failure boundary now works:

- Turn `01a0a0fe-9b4e-7396-a209-dcf0b8c4ec6e` began at17:37:15.607Z.
- Coordinator native JSONL line296 at17:37:17.141Z contains the resumed stopped-background-shell notification; line299 dequeues at17:37:17.144Z, and line300 records the actual guidance under prompt UUID `1243c1c0-41d1-4fc9-8f68-0055ee7923d0` at17:37:17.146Z.
- The engine did not close the turn at that notification boundary. DB messages58–61 contain all four genuine assistant messages, under the original turn. Exactly one user message exists for it (message57); replay did not duplicate the visible user echo.
- report_result succeeded at17:38:11.762Z: report `01a0a0ff-76b1-7cd1-8e9a-fcd707b881f8`, content revision7, the correct coordinator assignment and source turn.
- The original turn ended normally at17:38:21.629Z, with 4,359 output tokens. No later nudge was required to recover its output.

Root also ran a separate cancellation/resume exercise in Local Projects verification, session `01a0a0ac-b124-73ad-96ab-1f5dbbfad427`:

- Turn `01a0a0ff-9454-7b00-89a9-3c4f80dbaa2e` was paused during an active tool-use turn. DB outcome is `{"stopReason":"cancelled","finishReason":"tool_use"}` and the Project dispatch is finished/cancelled.
- Follow-up turn `01a0a100-1097-78e9-8dfb-1cee91a44c61` produced one user message and the assistant response `Resumed successfully.` (10 output tokens), then ended normally.
- Qualification limit: the harness blocked standalone `sleep 60` before execution. The agent searched for Monitor, but Pause arrived before a Monitor command was recorded. This confirms correct cancellation classification and clean session resume; it does not demonstrate termination of a running 60-second OS sleep.

### Actual foreground-process cancellation follow-up

Root repeated the exercise using an ordinary foreground Node timer, avoiding the harness's standalone-sleep block. Read-only observation now qualifies actual process termination as well:

- Turn `01a0a101-f133-7e52-97aa-225cc4bc1050` started at17:40:54.202Z.
- Native transcript `10e3f209-48f7-48a3-9da1-8a0cf90df2a3.jsonl`, line90, records the Bash tool call at17:40:57.246Z: `node -e 'process.stdout.write("waiting\n"); setTimeout(() => {}, 60000)'`, foreground, tool timeout120000ms.
- Before Pause, the DB tool part was `in_progress`; OS PID62391, parent62389, was directly observed running that exact Node command with elapsed25s.
- Native line91 records the interrupted tool result at17:41:44.616Z; line92 the user interruption at17:41:44.617Z. DB turn ended at17:41:44.617Z with `stopReason: cancelled, finishReason: tool_use`, and Project dispatch finished/cancelled.
- A targeted read-only `ps -p 62391` check at17:41:56.334Z returned no process. The timer could not naturally finish before17:41:57.246Z (60s after the tool call was emitted, even before allowing process-spawn latency). Its absence was therefore observed before the earliest possible normal deadline.
- Final resume turn `01a0a103-5a66-798f-a131-00b122404d96` ran17:42:26.666–17:42:28.136Z, emitted exactly one user message and one assistant message (`Resumed after process cancellation.`), 13 output tokens, and ended normally.

These live checks qualify the specific corrected prompt-notification boundary and a targeted foreground subprocess cancellation/resume. They do not imply exhaustive qualification of every provider, background descendant, or operating-system failure mode.
