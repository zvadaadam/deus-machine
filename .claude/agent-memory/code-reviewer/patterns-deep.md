# Deep Pattern Notes (overflow from MEMORY.md)

## Error Classification + Session Writer Patterns (Confirmed)

- `classifyStopReason` in `error-classifier.ts`: maps SDK `stop_reason` to `ClassifiedError | null`.
  `"end_turn"` and `"stop_sequence"` return `null` (normal). `"max_tokens"` → `context_limit`.
  Unknown stop reasons (future SDK variants) also return `null` (safe default).
- `classifyStopReason` is called INSIDE the message loop (on `type === "assistant"` messages),
  NOT in the catch block. This is the correct placement — the SDK does not throw for max_tokens,
  it just sets stop_reason on the message.
- `session-writer.ts` stores flat content arrays for normal messages, but still writes
  `{ message: { stop_reason: "cancelled" }, blocks: [...] }` for cancelled turns so the
  frontend can detect cancellation from DB content after reload.
- `normalizeContentBlocks` in `session.queries.ts` retains the envelope detection shim for backward
  compat with old DB rows. The shim key: `"message" in blocks && "blocks" in blocks`.
- `AssistantTurn.tsx` reads `stop_reason` via `JSON.parse(summaryMessage.content).message?.stop_reason`.
- `onStop` is declared in `ChatProps` but NOT destructured in `Chat.tsx` function body — dead prop.
- New error patterns: billing/subscription → auth; 5xx → network (retryable, 5s); image dimension
  limit, too large, max turns, output token limit, budget exceeded → context_limit.
- Tests for new patterns in `error-classifier.ts` are MISSING for billing, 5xx, too-large, and
  budget-exceeded cases (only `classifyStopReason` tests were added, not the new `classifyError` patterns).

## Chat Auto-Scroll + Virtualization Architecture (Confirmed)

- `useAutoScroll` uses a single `isPausedRef` bool + `ResizeObserver` on `container.firstElementChild`.
- **ResizeObserver firstElementChild bug (KNOWN)**: Effect runs once on mount, observes firstElementChild
  at that time. If `loading` starts `true`, the skeleton is the firstElementChild. After loading completes
  the ResizeObserver watches a detached element. Auto-scroll via ResizeObserver doesn't work for first session.
- Counter-based animation (`maxAnimatedTurnIndex` ref): `shouldAnimate` requires BOTH: `turnIndex === turns.length - 1`
  AND `turnIndex > maxAnimatedTurnIndex.current`. Animation fires ONLY for the absolute last turn.
- **Initial load bug**: Counter starts at -1, increments during render, making last turn animate on initial load.
- **Prepend re-animation bug**: After prepend, all indices shift up; last item re-animates.
- `RetryCountdown`: `useState` initializer only runs on mount. If `durationMs` changes, `remaining` is NOT reset.

## PRStatus / GhCliStatus Patterns (Confirmed)

- `PRStatus.pr_url` is optional; falling back to `""` produces `href=""` → `tauri://localhost/` reload.
- `PRStatus.pr_state` includes `"closed"` — must handle, not just "merged"/"open".
- `derivePRActionState` in `src/features/workspace/lib/prState.ts` is the single source of truth. No tests yet.
- `PRActionState` discriminated union: 11 variants. `match().exhaustive()` used in PRActions.tsx.
- `FAILING_CONCLUSIONS` and `PENDING_STATES` sets defined INSIDE request handler — re-created per request. Move to module scope.

## Border Radius System (10-Token Scale, Confirmed)

- Token scale: 2xs(2px) → xs(4px) → sm(6px) → md(8px) → lg(10px) → xl(12px) → 2xl(16px) → 3xl(20px) → 4xl(24px) → full(9999px)
- Two-layer: @theme defines `--radius-*: calc(var(--radius-*-base) * var(--corner-radius-scale))`.
- Squircle @supports block sets `--corner-radius-scale: 1.25` globally.
- Legacy `--radius: 0.5rem` kept in :root for backward compat.

## Sidecar Resume / AgentSessionId Patterns (Confirmed)

- `agent_session_id` = Claude SDK's internal conversation ID (not app sessions.id). Required for `resume:` in SDK options.
- `agentSessionIdCaptured` flag is one-shot per generator lifecycle.
- `reconcileStuckSessions` must run AFTER DB init but BEFORE socket accepts connections.
- `saveAgentSessionId` does NOT call `notifyBackend` — internal bookkeeping only.
- Double `updated_at` write in `saveAgentSessionId` is redundant (AFTER UPDATE trigger fires anyway).
