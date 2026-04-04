# Message Envelope Pattern (session-writer ↔ frontend)

## What It Is

`saveAssistantMessage` in `agent-server/db/session-writer.ts` wraps message content in an
envelope object only when `message.stop_reason === "cancelled"`:

```
Normal (no stop_reason or non-cancelled):  content = JSON.stringify([block1, block2, ...])
Cancelled (stop_reason === "cancelled"):   content = JSON.stringify({ message: { stop_reason: "cancelled" }, blocks: [...] })
```

This preserves cancellation detection in the frontend after page reload. Non-cancelled
stop reasons (e.g. `end_turn`, `max_tokens`) are stored as flat arrays — errors like
`max_tokens` are communicated via the session error event + DB `error_category` column,
not via envelope content.

## Frontend Unwrapping

`normalizeContentBlocks` in `session.queries.ts` detects the envelope format and unwraps it:

```ts
if ("message" in blocks && "blocks" in blocks && Array.isArray(blocks.blocks)) {
  return normalizeContentBlocks(blocks.blocks);
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
- Otherwise (null or no envelope) → normal `MessageItem`

Non-cancelled errors (max_tokens, rate_limit, etc.) are rendered from `session.error_category`
in `Chat.tsx` via the ErrorBanner, not from the message envelope.

## False-Positive Risk

The envelope detection (`"message" in blocks && "blocks" in blocks && Array.isArray(blocks.blocks)`)
could false-positive if a real content block ever has both `message` and `blocks` fields.
Standard Claude SDK types (text, image, tool_use, tool_result, thinking) do NOT have these fields.
This is a low-likelihood edge case.

## stop_reason Values from Claude SDK

Known values:

- `"end_turn"` — normal completion (stored as flat array, no special UI)
- `"cancelled"` — user interrupted (synthetic, injected by agent-server; stored in envelope)
- `"max_tokens"` — context limit hit (stored as flat array; error shown via session error_category)
- `"stop_sequence"` — custom stop sequence (stored as flat array; no special UI)
