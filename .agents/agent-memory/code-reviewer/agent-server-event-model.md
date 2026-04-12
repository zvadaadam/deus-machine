---
name: Agent-Server Granular Event Model (PR gnhf/i-would-love-to-impr-9017a3)
description: Architecture of the new turn/message/part lifecycle event system in agent-server, including known gaps and patterns
type: project
---

# Agent-Server Granular Event Model

## What changed

Refactored from batch `message.parts` + `message.parts_finished` emissions to granular lifecycle events:
`turn.started` → `message.created` → (`part.created` / `part.delta` / `part.done`)\* → `message.done` → `turn.completed`

## Critical gap (RESOLVED — 2026-04-11)

All 7 new event types (`turn.started`, `message.created`, `part.created`, `part.delta`, `part.done`, `message.done`, `turn.completed`) were added to `AgentEventSchema` in `shared/agent-events.ts`. The backend `event-handler.ts` now handles them via `.exhaustive()`. The legacy `message.parts` and `message.parts_finished` events and the `PartsAccumulator` have been removed as dead code.

## FinishReason import missing in codex-adapter.ts

`FinishReason` is used as a type assertion (`as FinishReason`) in `codex-adapter.ts` lines 426 and 437 but is never imported. `FinishReason` is only imported in `adapter.ts`. This is a compile error.

## `stop_reason` field absent from ClaudeAssistantEvent type

`claude-adapter.ts` line 280 accesses `event.message.stop_reason` but `ClaudeAssistantEvent.message` in `claude-events.ts` has no `stop_reason` field. TypeScript compile error. The non-streaming path always passes `undefined` as `stopReason` to `closeMessage()`.

## Subagent result count heuristic is fragile

`handleResult()` in `claude-adapter.ts` at `activeCount >= 2` returns early AND sets `turnCompletedEmitted = true`, preventing `finish()` from also emitting it. But the check `activeCount >= 2` as "skip this is a nested subagent result" is a heuristic — if two sequential subagents complete at the same time, `turn.completed` is never emitted for the outer turn.

## `onBlockStop` re-emits `part.created` instead of `part.done` for tool parts

When a streaming `content_block_stop` arrives for a tool block, `onBlockStop` calls `created(updated)` at line 539, which emits `part.created` (again) for the now-fully-parsed tool part. The initial `part.created` was already emitted from `onBlockStart`. Consumers see two `part.created` for the same tool — the second with complete input, first with empty input. Should be `part.done` for the second emission to signal the tool is now ready.

## `handleExecApproval` emits `part.created` for an existing part (codex-adapter)

When `exec_approval_request` arrives for an existing `call_id` (lines 246-258), it mutates the existing part but emits `part.created` instead of `part.done`. Consumers that track lifecycle by event type will incorrectly treat this as a brand-new part.

## CLI `spawnServer` logs stderr only, stdout discarded

In `cli.ts`, `proc.stdout` is only used to detect the LISTEN_URL line. After that, stdout from the server is silently dropped. Server console.log output is lost. Should pipe stdout to the log file too, or just use the same logStream.

## `handleResult` with `activeCount >= 2` skips `lastFinishReason`

When `activeCount >= 2`, the function returns early before `mapResultSubtype` is called, so `lastFinishReason` is never set. `finish()` then emits `turn.completed` with `finishReason: undefined`. This means parallel-subagent turns always have unknown finish reason.

## Codex CLI adapter: no `turn.started` emitted

`codex-adapter.ts`'s `handleTurnStarted()` only fires when a `task_started` event is received. If the Codex CLI doesn't emit `task_started` (which it doesn't always), `turn.started` and `message.created` are never emitted. The Codex SDK adapter (`codex-sdk-adapter.ts`) correctly emits them from `turn.started`. The two adapters for Codex (CLI vs SDK) have divergent guarantees — the CLI adapter relies on the CLI event model which may not always send `task_started`.

## Backend event-handler is still on the old model

`event-handler.ts` still handles `message.parts` and `message.parts_finished` via `PartsAccumulator`. The agent-server no longer emits these events (it emits the new granular events instead). The PartsAccumulator and `persistMessagePartsFinished` are now dead code unless the old events are also preserved during the dual-write period.

**Why:** The commit messages say "dual-write period" but the new code does NOT dual-write — it replaces, not supplements, the old emissions.
