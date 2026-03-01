# Message Envelope Pattern (session-writer ↔ frontend)

## What It Is

`saveAssistantMessage` in `sidecar/db/session-writer.ts` wraps message content in an
envelope object whenever `message.stop_reason` is truthy:

```
Normal (no stop_reason):  content = JSON.stringify([block1, block2, ...])
With stop_reason:         content = JSON.stringify({ message: { stop_reason }, blocks: [...] })
```

## Important: ALL end_turn Messages Are Wrapped

The comment in `session-writer.ts` says only "cancelled" messages use the envelope —
this is misleading. The condition is `message.stop_reason ? envelope : flat`, and the
Claude SDK's normal completion stop_reason IS `"end_turn"` (truthy). So every normal
Claude response from the SDK is stored in envelope format too.

The comment should read: "any message with a stop_reason (including end_turn) uses the
envelope; messages where stop_reason is absent/undefined use the flat array format."

## Frontend Unwrapping

`normalizeContentBlocks` in `session.queries.ts` (the `typeof blocks === "object"` branch):
```ts
if ("blocks" in blocks && Array.isArray((blocks as { blocks?: unknown }).blocks)) {
  return normalizeContentBlocks((blocks as { blocks: unknown[] }).blocks);
}
```
This runs before the `parseContent` result is used anywhere in the UI. All consumers
(Chat.tsx, MessageItem, calculateTurnStats, groupTools, SubagentGroupBlock) see unwrapped
blocks arrays.

## AssistantTurn stop_reason Detection

`AssistantTurn.tsx` reads `stop_reason` DIRECTLY from the raw `summaryMessage.content`
JSON (before `parseContent`), via a separate `useMemo`. This is intentional — `parseContent`
discards the envelope, so you need to parse it separately to get the stop_reason.

Rendering branches:
- `stopReason === "cancelled"` → "Turn interrupted" pill (Square icon)
- `stopReason && stopReason !== "end_turn"` → AlertCircle error border wrapping a `MessageItem`
- Otherwise (null, "end_turn", or no envelope) → normal `MessageItem`

## False-Positive Risk

The envelope detection (`"blocks" in blocks && Array.isArray(blocks.blocks)`) could
false-positive if a real content block ever has a `blocks` field. Standard Claude SDK
types (text, image, tool_use, tool_result, thinking) do NOT have a `blocks` field.
MCP tool output that stores its result as `{ blocks: [...] }` would be misidentified.
This is a low-likelihood edge case, but worth keeping in mind if MCP tool results start
displaying incorrectly.

A more robust guard would also require `"message" in blocks`, since the envelope always
has both fields: `{ message: { stop_reason }, blocks: [...] }`.

## stop_reason Values from Claude SDK

Known values that pass through:
- `"end_turn"` — normal completion (excluded from error branch)
- `"cancelled"` — user interrupted (synthetic, injected by sidecar, not SDK)
- `"max_tokens"` — context limit hit (shows AlertCircle)
- `"stop_sequence"` — custom stop sequence (shows AlertCircle — may be benign, not an error)

`"stop_sequence"` triggering the error branch is potentially misleading UX (it's not always
an error), but since the sidecar rarely produces it in practice this is low priority.
