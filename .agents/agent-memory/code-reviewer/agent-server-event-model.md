---
name: Agent-Server Granular Event Model
description: Architecture of the turn/message/part lifecycle event system in agent-server
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
- `message.created` → creates message row
- `message.done` → updates `stop_reason`
- `part.created` / `part.delta` → broadcast only (no persistence)
- `turn.completed` → invalidate

Legacy `message.parts` / `message.parts_finished` / `PartsAccumulator` / `persistAssistantMessage` / `persistToolResultMessage` — all removed.

## Known patterns

- Claude: multiple `message.created` / `message.done` per turn (one per API call)
- Codex: single `message.created` / `message.done` per turn
- `onBlockStop` emits `part.created` (not `part.done`) for tool parts transitioning to RUNNING — this is intentional (the tool isn't done yet, it's a state update)
- Tool parts use `INSERT OR REPLACE` because the same partId transitions through states (PENDING → RUNNING → COMPLETED)
