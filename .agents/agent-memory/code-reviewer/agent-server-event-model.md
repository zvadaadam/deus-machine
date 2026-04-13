---
name: Agent-Server Granular Event Model
description: Architecture of the turn/message/part lifecycle event system in agent-server, plus known correctness gaps
type: project
---

# Agent-Server Granular Event Model

## Event lifecycle

`turn.started` → `message.created` → (`part.created` / `part.delta` / `part.done`)\* → `message.done` → `turn.completed`

All 7 events have Zod schemas in `shared/agent-events.ts` (`AgentEventSchema` discriminated union).
The `PartEvent` type in `shared/agent-events.ts` is shared by agent-server and backend.

## Backend handling

`event-handler.ts` handles the canonical lifecycle with `.exhaustive()`:

- `part.done` → persists to `parts` table + broadcasts `q:event`
- `message.created` → creates message row (INSERT) + invalidates → triggers q:delta to frontend
- `message.done` → updates `stop_reason` only
- `part.created` / `part.delta` → broadcast only (no persistence)
- `turn.completed` → no-op (session.idle handles UI update)

Legacy `message.parts` / `message.parts_finished` / `PartsAccumulator` / `persistAssistantMessage` / `persistToolResultMessage` — all removed.

## Known correctness gaps

### CRITICAL: parent_tool_use_id not written on message.created

`persistMessageCreated()` in `persistence.ts` INSERTs only `(id, session_id, role, sent_at)`.
`event.parentToolCallId` is never written to `messages.parent_tool_use_id`.
As a result, the q:delta that flows to the frontend carries `parent_tool_use_id: null`.
`subagentMessages` map in `SessionPanel.tsx` (grouped by `message.parent_tool_use_id`) is always empty.
`ToolPartBlock.tsx` line 129: `subagentMessages.has(part.toolCallId)` is always false → SubagentGroupBlock never renders.
Fix: `INSERT OR REPLACE INTO messages (id, session_id, role, sent_at, parent_tool_use_id) VALUES (?, ?, ?, ?, ?)` with `event.parentToolCallId ?? null`.

### CRITICAL: part:created/part:done q:event skips message.created q:delta race

Frontend `mutateParts` skips if message not in cache. `message.created` triggers `persistAndInvalidate`
which fires q:delta. Part events are q:event (real-time, no round-trip). Under load, q:event
can arrive before q:delta is processed → parts are silently dropped.
Fix: buffer part events for unknown messageIds with a short TTL (e.g., 200ms) and retry.

### BUG: Chat.tsx `agentSubState` reads `lastPart.data` instead of `lastPart.state`

`Chat.tsx` line 259: `JSON.parse(lastPart.data)` — `Part` objects have no `.data` field (that's `PartRow`).
For TOOL parts, the state is at `lastPart.state.status` directly.
`lastPart.data` is `undefined` → `JSON.parse(undefined)` throws → falls through to `toolExecuting`.
The catch block returns `"toolExecuting"` so the indicator always shows tool-executing when any TOOL part
is last, even for COMPLETED tools. This is a stale `PartRow` assumption surviving the refactor.

## Known patterns

- Claude: multiple `message.created` / `message.done` per turn (one per API call)
- Codex: single `message.created` / `message.done` per turn
- `onBlockStop` emits `part.created` (not `part.done`) for tool parts transitioning to RUNNING — intentional (tool isn't done yet, it's a state update)
- Tool parts use `INSERT OR REPLACE` because the same partId transitions through states (PENDING → RUNNING → COMPLETED)
- `nextPartIndex` is computed as `this.parts.length - this.messagePartsStart` — correct per-message index
- `completeToolPart` preserves `partIndex` from the original ToolPart (spread) — correct
- `partIndex` is `optional` (z.number().optional()) — persisted as `seq = part.partIndex ?? 0`, which means missing partIndex silently maps to seq 0, but the adapters always pass a value

## SubagentGroupBlock rendering path (when working)

ToolPartBlock reads `subagentMessages` from SessionContext.
subagentMessages is populated in SessionPanel from `message.parent_tool_use_id`.
Currently broken because persistMessageCreated doesn't write parent_tool_use_id.
