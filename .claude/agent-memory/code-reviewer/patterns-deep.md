# Deep Pattern Notes (overflow from MEMORY.md)

## Status Event Pipeline (Confirmed, 2026-03-04)

- **Bug 1 (workspace matching)**: `session:status-changed` carries `workspaceId` (from `lookupWorkspaceId()` in session-writer).
  Frontend matching: `(workspaceId && ws.id === workspaceId) || ws.current_session_id === sessionId`.
  Fallback is backward-compat for Codex sessions and older events without workspaceId.
- **Hardcoded `agentType: "claude"`** in `session-writer.ts` `sendStatusChanged()` calls — correct for now
  (session-writer is only called from Claude path), but breaks if Codex sessions ever route through it.
- **Bug 2 (Tauri null deserialization)**: `dbGetMessages()` in `src/platform/tauri/db.ts` now builds payload
  conditionally, omitting `null` fields. Rust's `Option<i64>` can't deserialize JSON null.
- **Bug 3 (Strict Mode race)**: `registerListener(promise)` pattern with `cancelled` flag + `unlistenFns[]`
  array. Both `useSessionEvents` and `useGlobalSessionNotifications` use this pattern.
  WARNING: `registerListener` swallows `listen()` rejections silently — `.catch()` handler missing.
  `listen()` can fail if Tauri is unavailable, but this is gated by `if (!isTauriEnv)` before the effect body.
- **Optimistic workspace status**: `onMutate` sets `session_status: "working"` in `["workspaces", "by-repo"]` cache.
  `onError` rolls it back to `"idle"`. Matches by `current_session_id` (not `workspaceId` — no workspaceId
  available in onMutate context). This is intentionally less precise than the event-based path.
- **reconcileStuckSessions**: Called at agent-server startup. Does NOT emit status-changed events for reconciled
  sessions — frontend will pick up via the `invalidateQueries` on `useSessionEvents` mount.

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
- **StrictMode animation fix**: Counter is now advanced in `useEffect([turns.length])` (post-commit)
  instead of render-time mutation. Render reads the ref as a pure read. This correctly fixes
  the StrictMode double-render bug where the counter was advanced on pass 1, leaving pass 2 with no animation.
- **animatedTurnsRef Set**: New `Set<number>` ref tracks turns mid-animation. CSS class persists across
  streaming re-renders for the 150ms chatItemEnter duration. Cleaned up with `setTimeout(300ms)`.
  `shouldAnimate` now also gates on `sessionStatus !== "working"` to prevent blink during virtualizer reflow.
- **`shouldAnimate` gate during streaming**: `sessionStatus !== "working"` prevents the opacity animation
  from firing while the virtualizer continuously repositions items via `transform: translateY()`.
  translateY animations on children compose with parent reposition transforms, causing visible blinks.
- **1-frame animation gap (confirmed)**: After a new turn is appended, `maxAnimatedTurnIndex.current`
  is set to `turns.length - 1` in the useEffect, which fires AFTER the first paint. So on the first paint
  the turn gets `chat-item-enter`, and on the second paint the counter catches up. This is the desired behavior.
- **Single-block streak key**: `ToolGroupBlock` key = `s.blocks[0].id` — no guard for empty `blocks`
  array, but `groupToolStreaks` always emits `streakBlocks.length > 0` before flushing, so safe.
- **chatItemEnter duration change**: Changed from 220ms to 150ms. The cleanup setTimeout in Chat.tsx
  is 300ms (150ms animation + 150ms buffer). Comments in Chat.tsx at lines 161/352/355 still say "220ms" — stale.
- **ToolGroupBlock showHeader change**: Changed from `isSealed && blocks.length >= 2` to `blocks.length >= 2`.
  Now shows header during streaming (when 2+ tools in streak), collapsed on seal. The `isExpanded` default
  changed from `!showHeader` to `!isSealed` — correctly starts expanded during streaming, collapses on seal.
- **AssistantTurn streaming/completed split**: Two render paths. Streaming: `groupedAll` = all messages
  through `groupMessageToolStreaks`. Completed: `hiddenMessages` (all but last) + `summaryMessage` (last).
  `groupedHidden` is computed unconditionally (even during streaming) — wasted O(n) work but memoized.
- **TurnStatsHeader during streaming**: The header shows when `hiddenMessages.length > 0` regardless of
  streaming state. During streaming it acts as a count indicator. Clicking the header during streaming
  toggles `isManuallyExpanded` but has NO visible effect (streaming path ignores isExpanded).
  This is intentional per the comment but creates confusing UX — the button appears interactive
  but shows no visible change, and aria-expanded state is misleading.
- `AUTO_RESUME_MS` (10s timer) removed — replaced with `PAUSE_COOLDOWN_MS` (500ms date comparison in handleScroll).
  **Reinstated in rAF-chase rewrite** (zvadaadam/fix-chat-animations): `AUTO_RESUME_MS = 10_000` returned.
  `PAUSE_COOLDOWN_MS = 500` still present for inertia absorption on scroll re-engagement.
- `RetryCountdown`: `useState` initializer only runs on mount. If `durationMs` changes, `remaining` is NOT reset.
- `groupToolStreaks` correctly handles empty input (returns []) and single-block case (one ToolStreak with isTrailing=true).
- `lastTextBlockIndex` scan in `MessageItem` runs at render time (not memoized). Comment at line 176 incorrectly
  says "Memoized" — it is not. Acceptable since it's O(n) over a small array, but comment is misleading.

## rAF Chase Loop Pattern — Wheel-Based Pause (zvadaadam/fix-chat-animations, 2026-03, iteration 2)

- **Architecture**: rAF chase loop (unchanged from iteration 1). Pause detection switched from scroll
  event (other tool) to wheel event (another tool). Wheel fires BEFORE scrollTop updates, so it cannot be
  overpowered by the loop.
- **`lastOwnScrollAtRef`**: Stamped by every chase-loop tick AND by `scrollToBottom` instant path.
  Wheel handler ignores events within `OWN_SCROLL_WINDOW_MS` (80ms) of last stamp. Covers ~2 rAF
  frames with safety headroom for slow frames.
- **`OWN_SCROLL_WINDOW_MS = 80ms` analysis**: At 60fps one rAF frame = 16.7ms. Two frames = 33ms.
  80ms covers ~5 frames, providing 2.5x headroom for 24fps slow devices. Appropriate.
- **`WHEEL_UP_THRESHOLD = -4`**: Lower than competitor defaults (-12) to match macOS trackpad which fires many
  small deltas. Risk: very light resting-finger contact on trackpad fires deltaY < -4 and pauses.
  Mitigated by `OWN_SCROLL_WINDOW_MS` guard preventing false triggers during chase motion.
- **Nested scrollable handling (CONFIRMED CORRECT for majority case)**: The old approach
  walked the DOM to find the nearest scrollable ancestor. The new approach attaches the wheel
  listener to `container` (the chat scroll element) directly — it only receives events that bubble
  to it, meaning events inside nested scrollables with `overscroll-behavior: contain` AND
  `overflow: auto/scroll` will still bubble the wheel event up to container. The `passive:true`
  listener on container receives the wheel event regardless of whether a child consumed scroll.
  **This is a known gap**: any nested scrollable that is itself at-top (cannot scroll up further)
  will chain the wheel event to the container. The `overscroll-behavior: contain` CSS on nested
  scrollables prevents actual scrollTop chaining, but does NOT stop wheel event bubbling. So if the
  user wheel-ups inside a code block that is already scrolled to its top, the wheel event bubbles
  to the chat container and pauses auto-scroll. This is acceptable UX (rare case, user can resume
  by scrolling to bottom). The OLD DOM-walk approach was more precise but had the race condition.
- **BOTTOM_THRESHOLD changed from 5px to 24px**: This widens the re-engagement zone. Users get
  auto-resume 24px above true bottom. Tolerable for UX but increases false-resume risk for short
  messages. Acceptable trade-off.
- **`stopChase` missing from messages-effect dep array (BUG)**: At line 331, the messages effect
  dep array is `[messages, resume, startChase]`. The effect calls `stopChase()` at lines 315 and 328. `stopChase` is a `useCallback` with stable identity (empty implicit deps from `[]`), but
  React's exhaustive-deps rule considers this a violation. In practice harmless because `stopChase`
  is referentially stable. Nevertheless it should be added.
- **`syncGeometry` stop+2-frame-restart**: Cancels the rAF, waits 2 frames for layout, then
  restarts only if not paused. Called from Chat.tsx prepend scroll restoration. Correct pattern.
- **Idle self-stop + force-restart (CONFIRMED CORRECT)**: `chaseRafRef = null` + `isPausedRef =
false` is the self-stopped state. Messages effect handles this via unconditional `stopChase() +
startChase()` (not just `startChase()`, which guards against double-start). Force-restart pattern
  correct.
- **`scrollToBottom(smooth=true)` race**: Still present from iteration 1. `chaseFactorRef` reset
  via `setTimeout(500ms)`. If chase completes before 500ms, reset fires late (harmless). Safe.
- **`chat-scroll-contain` pattern**: `overscroll-behavior: contain` on nested scrollable tool
  result areas prevents scroll chaining. Does NOT prevent wheel event bubbling to parent (see above).
  Two remaining gaps from iteration 1 still present (UnifiedDiff inline style, CodeBlock horizontal).
- **`motion` vs `m`**: Pre-existing violation, NOT introduced by this branch.
- **`suppressAutoScrollOnExpand` removed (CONFIRMED COMPLETE)**: No call sites remain.
- **`initialMessageCount` ref pattern (Chat.tsx)**: Unchanged. Still correct.
- **Auto-resume timer removed**: `AUTO_RESUME_MS` / `resumeTimerRef` fully removed. Resume is now
  explicit only (scroll-to-bottom, send-message, click button). No 10s silent resume. This is a
  behavior change — the comment in the old MEMORY.md entry noting "reinstated" is now wrong again.

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

## Agent-server Resume / AgentSessionId Patterns (Confirmed)

- `agent_session_id` = Claude SDK's internal conversation ID (not app sessions.id). Required for `resume:` in SDK options.
- `agentSessionIdCaptured` flag is one-shot per generator lifecycle.
- `reconcileStuckSessions` must run AFTER DB init but BEFORE socket accepts connections.
- `saveAgentSessionId` does NOT call `notifyBackend` — internal bookkeeping only.
- Double `updated_at` write in `saveAgentSessionId` is redundant (AFTER UPDATE trigger fires anyway).

## Agent-server-Owns-Send Pattern (zvadaadam/agent-server-error-logging, 2026-03)

- `saveUserMessage()` in `session-writer.ts` uses `db.transaction()` for atomic INSERT message +
  UPDATE session status='working'. This is the entry point for all user messages in the desktop path.
- `onQuery` handler in `index.ts` calls `saveUserMessage` BEFORE dispatching the agent. If DB write
  fails, returns `{ accepted: false }` — nothing persisted, clean rollback.
- `sendQuery` changed from fire-and-forget notification to an RPC request that returns `QueryAckResponse`.
  Frontend throws if `ack.accepted === false`, which triggers `onError` to roll back optimistic UI.
- `onQuery` in `frontend-client.ts` uses `requireTunnel()` (first tunnel in Set) to register the handler.
  When a second client connects, the method is registered ONLY on the first tunnel's RpcConnection —
  the second client cannot send queries. This is a latent bug for multi-tunnel scenarios.
- `updateSessionStatus` spin-waits 200ms on SQLITE_BUSY — blocks the event loop (better-sqlite3 is sync
  but Node.js still has an event loop; 200ms is visible lag). Acceptable for rare retry case.
- Atomicity test in session-writer.test.ts (`does not persist anything when transaction fails`) has NO
  assertion on mockDbRun — it only checks result.ok. If the mock setup were wrong the test would still pass.
- `saveUserMessage` does NOT call `notifyBackend("session:message", ...)` before notifying — but it
  DOES call it (line 146 of session-writer.ts). Correct.
- Flat content format: new user/assistant messages stored as JSON arrays directly (no envelope wrapper).
  Old rows may have envelope — `normalizeContentBlocks` has backward-compat shim.
- `parent_tool_use_id` promoted from JSON envelope to dedicated DB column — `msg.parent_tool_use_id`
  now read directly instead of parsing JSON envelope.
