# Project agent notifications: ownership and minimal contract

Read-only architecture exploration, 2026-09-14. Everything below marked proposed is a Deus design, not observed Cursor server behavior.

## Reuse the durable conversation path

Local envelopes enter `AgentEventHandler.handle` through `agent/service.ts:74`; cloud engine events enter the same handler through `agent/cloud/driver.ts:253`. The handler folds canonical events and persists before publishing to UI (`event-handler.ts:298`, `:334`). `persistTurn` atomically upserts a turn and its optional session status (`persistence.ts:225`). Turn identity is `(session_id, turn_id)` (`db/turns.ts:30`, `shared/schema.ts:200`). This supplies the terminal facts a Project needs.

The existing transcript query already returns messages with parts, turn outcomes, compactions and pagination (`query-engine.ts:450`). Build an agent-facing read service on these data functions, not the UI's WebSocket connection. Reads need Project membership/authorization, bounded output, and node routing. Completed-turn snapshots are a sensible default. Live reads must identify partial/gapped content: persistence intentionally skips token deltas and stores settled part snapshots (`event-handler.ts:334`). `messages.seq` is insertion order, not a revision cursor for a mutable transcript.

Existing UI subscriptions are ephemeral Maps per connection, with memory-only message cursors (`query-engine.ts:106`). `q:event` broadcasts envelopes to frontends (`event-handler.ts:159`). Neither makes a model aware of an event or starts another turn. That is the missing Project service.

## Proposed v1 tools

- `ReadAgentTranscript(agentId, turnIds?|cursor?, limit?)` returns an authoritative bounded view with outcomes, source/session IDs, continuation, compaction/gap/partial metadata. Fetch a short final-result view first when sufficient. A cursor belongs to the read contract's snapshot, not a raw live message insertion sequence.
- `SendAgentMessage(agentId, message, operationId)` returns `queued`, `admitted`, or a typed rejection with stable operation/turn identity. Default busy behavior is queue for the next turn. Do not claim “agent received/acted” merely because a socket write succeeded.
- Created Project agents are watched automatically; creation atomically records membership, intended initial turn, notification target and durable dispatch before execution can start. An optional `SubscribeToAgent(agentId, events, since?/includeCurrent?)` supports adoption/additional watchers, with a durable subscription ID. No model polling loop is needed.
- `StopAgent(agentId, turnId?)` preserves confirmed versus unconfirmed cancellation. Existing APIs already expose that distinction (`agent/service.ts:170`, `commands.ts:658`).

Project tools call backend/cloud-authority services directly, following the current automation tool path (`agent/service.ts:243`). They must not route through an open frontend. Agent Server executes tool calls; it does not own the durable inbox.

## Minimal notification records and flow

Keep this as a Project inbox with delivery state, not a general event bus. The existing membership relation can carry the default coordinator watch. Add a separate subscription record only for explicit, independently configured watchers.

Each durable notification has a stable source key, Project/recipient, source session/turn or assignment, event type, short immutable payload, creation order, and delivery operation/turn reference. A terminal key can be `(project, recipient, source session, source turn, terminal)`; don't key it by websocket sequence. Cloud driver sequences are synthetic per connection (`cloud/driver.ts:253`, `:954`). Use the Project inbox's own durable sequence/cursor for ordered consumption.

The short envelope contains agent/session identity, assignment reference when present, turn identity, execution outcome, final excerpt, and result/PR references. References can be followed when available; notification does not wait indefinitely for a PR lookup, and absence of a PR is not failure. Read full transcripts only as needed. Child output remains attributed source material, not higher-priority instructions.

Write terminal fact and enqueue its notification atomically at the authority, or record the terminal fact durably and use an idempotent reconciliation scan that cannot permanently miss the gap. Current `persistTurn` is an appropriate transaction seam; raw live-event callbacks alone are insufficient. `hydrateCloudSnapshot` deliberately restores history without historical live effects (`event-handler.ts:48`, `:184`), so startup/reconnect must compare persisted terminal turns with notification keys and insert missing rows. Never emit completion if the terminal persistence failed.

Register watches before dispatch. Late subscription must capture a consistent starting cursor plus matching current terminal state in one authority operation; otherwise a very fast child can finish between reading status and watching. For adoption, replay the requested turn/current state, not every old conversation turn indiscriminately.

## Busy coordinator and failure semantics

Persist child events immediately. When coordinator admission is free, claim a bounded ordered batch, freeze the batch payload/IDs, and dispatch one follow-up using a stable turn ID. Events arriving later remain pending for the next batch. Serialize this with user messages through the same admission service; `commands.ts:387` rejects active turns and pending user questions count as active. Do not interrupt a question/approval or run parallel coordinator turns accidentally. Pause disables automatic dispatch but retains the inbox.

Persist batch claims before sending. If acknowledgement is lost, reconcile the same target turn ID; do not mint a new one and duplicate work. Distinguish queued, admitted, and terminal delivery outcomes. An admitted notification turn is not proof the coordinator handled every item successfully; failed turns leave discoverable input and can resume/re-present references. At-least-once delivery plus stable IDs is the honest contract. Subsequent side-effecting tools must also be idempotent; model reasoning itself cannot be promised exactly once.

Watch only child/selected source sessions, excluding the coordinator and notification-generated self events. Cause IDs and bounded batching prevent immediate feedback loops. No automatic wake is needed for every token or status repaint.

`idle` is not assignment success: current `event-facts.ts:66` maps end_turn, max_tokens, refusal and request limits to idle. Recoverable errors mean execution continues (`event-facts.ts:150`); `session.ended` concerns runtime/session lifetime. Notify distinct execution outcomes. Assignment acceptance/completion is a separate product fact established by explicit result/report and validation.

Cloud Projects run this inbox, reconciliation and dispatcher at cloud authority, even with all UIs disconnected. The desktop's cloud fold is then a projection; it must not become a second scheduler. Confirm private AGNT admission/idempotency retention before relying on indefinite retry guarantees.
