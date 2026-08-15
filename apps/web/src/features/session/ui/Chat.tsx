import { match } from "ts-pattern";
import type { Compaction, Message, SessionStatus } from "@/shared/types";
import { MessageItem } from "./MessageItem";
import { AssistantTurn } from "./AssistantTurn";
import { CompactionChip } from "./CompactionChip";
import { WorkspaceEmptyState } from "./WorkspaceEmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ChevronDown, TerminalSquare, MessageSquarePlus, TriangleAlert, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";

import { useWorkingDuration } from "@/shared/hooks";
import { useAutoScroll } from "../hooks";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef, useEffect } from "react";
import { AnimatePresence, m } from "framer-motion";
import { CircularPixelGrid, type CircularPixelGridVariant } from "./CircularPixelGrid";
import { agentActivity, groupIntoTurns } from "@zvada/agent-server/protocol";
import { conversationView } from "../lib/conversationView";
import { insertCompactions, type ChatTimelineItem, type Turn } from "../lib/chatTimeline";

const USER_PADDING_CLASS = "pb-8";
const TIGHT_PADDING_CLASS = "pb-1";

/**
 * Turn Types (defined in ../lib/chatTimeline so the compaction placement is
 * testable outside React).
 *
 * A turn = consecutive messages with the same role (user or assistant)
 * - UserTurn: Single user message
 * - AssistantTurn: One or more consecutive assistant messages
 * - CompactionMarker: a positional divider spliced between turns
 */

/**
 * Calculate spacing classes for turns using PADDING (not margin).
 *
 * Padding is used instead of margin because virtual items are absolutely
 * positioned — margins don't affect layout. Padding is included in
 * getBoundingClientRect().height, so the virtualizer's measureElement
 * captures spacing correctly.
 *
 * Spacing logic:
 * - First turn: Top padding (pt-8 for user, pt-1 for assistant)
 * - User turn after assistant: Generous top padding (pt-8)
 * - User turn after user: No extra padding
 * - Assistant turn: No top padding
 * - Bottom padding: User turns add pb-8, assistant turns add minimal padding
 */
function getTurnSpacingClasses(
  turn: ChatTimelineItem,
  prevTurn: ChatTimelineItem | null,
  nextTurn: ChatTimelineItem | null,
  isFirst: boolean
): string {
  const isUser = turn.type === "user";

  const topClass = (() => {
    // Compaction divider: breathing room on both sides, it IS the seam.
    if (turn.type === "compaction") return isFirst ? "pt-6" : "pt-4";

    if (isUser) {
      if (isFirst) return "pt-8";
      if (prevTurn?.type === "user") return "pt-0";
      if (prevTurn?.type === "compaction") return "pt-4";
      return "pt-8";
    }

    // Assistant turn
    if (isFirst) return "pt-1";
    if (prevTurn?.type === "compaction") return "pt-2";
    return "pt-0";
  })();

  const bottomClass = (() => {
    if (turn.type === "compaction") {
      return "pb-0";
    }

    if (isUser) {
      return USER_PADDING_CLASS;
    }

    // Assistant turn
    if (nextTurn?.type === "user") {
      return "pb-0";
    }

    if (nextTurn) {
      return TIGHT_PADDING_CLASS;
    }

    return "pb-0";
  })();

  return cn(topClass, bottomClass);
}

interface ChatProps {
  messages: Message[];
  /** Positional compaction markers, spliced between the turns they belong to. */
  compactions?: Compaction[];
  loading: boolean;
  sessionStatus: SessionStatus;
  errorMessage?: string | null;
  /** Structured error category from classifyError (e.g. "auth", "rate_limit") */
  errorCategory?: string;
  agentHarness?: string | null;
  latestMessageSentAt?: string | null;
  onStop?: () => void; // Callback to stop/cancel the session
  onOpenLoginTerminal?: () => void;
  onRetryInNewChat?: () => void;
  /** True when there are older messages beyond the loaded window */
  hasOlder?: boolean;
  /** True when a load-older request is in flight */
  loadingOlder?: boolean;
  /** Callback to load older messages (button-triggered) */
  onLoadOlder?: () => void;
  workspaceRepoName?: string | null;
  workspaceParentBranch?: string | null;
  isFirstSession?: boolean;
  /** The harness answered `resumed: false` — this chat's context was lost. */
  contextLost?: boolean;
  onDismissContextLost?: () => void;
  /** Incremented by SessionPanel when the human clicks Send. */
  userSendCount?: number;
  className?: string;
}

const NO_COMPACTIONS: Compaction[] = [];

export function Chat({
  messages,
  compactions = NO_COMPACTIONS,
  loading,
  sessionStatus,
  errorMessage,
  errorCategory,
  agentHarness,
  latestMessageSentAt,
  onOpenLoginTerminal,
  onRetryInNewChat,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  workspaceRepoName,
  workspaceParentBranch,
  isFirstSession,
  contextLost = false,
  onDismissContextLost,
  userSendCount = 0,
  className,
}: ChatProps) {
  // Chat owns its scroll behavior entirely — refs, hook, and button.
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const { showScrollButton, handleScrollToBottomClick } = useAutoScroll({
    messages,
    messagesContainerRef,
    userSendCount,
  });

  // --- Message entrance animation tracking ---
  // Counter-based: only the turn at index > maxAnimatedTurnIndex gets the
  // entrance animation. Simpler than a Set, immune to unbounded growth,
  // and prepended messages automatically skip animation (their indices
  // are below the counter).
  const maxAnimatedTurnIndex = useRef(-1);
  // Pre-seed on first render with turns so initial load doesn't animate.
  // Without this, the last historical turn always plays the entrance animation.
  // Only seeds when conversation loaded with existing messages — new
  // conversations (starting empty) should animate their first turn.
  const isFirstTurnsRender = useRef(true);
  const initialMessageCount = useRef(messages.length);
  // Tracks which turns have started their entrance animation. Keeps the CSS
  // class applied across re-renders so streaming updates don't interrupt the
  // 400ms chatItemEnter animation mid-play (which causes visible jumps).
  const animatedTurnsRef = useRef(new Set<number>());

  // Track working duration
  const { formattedDuration } = useWorkingDuration({
    status: sessionStatus,
    latestMessageSentAt,
  });

  // Memoize message filtering to avoid re-parsing JSON on every render
  // Filter messages: skip subagent children (they render nested under Task tool blocks)
  const renderableMessages = useMemo(() => {
    return messages.filter((message) => {
      // Skip subagent messages
      if (message.parent_tool_call_id) return false;
      // User messages always render
      if (message.role === "user") return true;
      // Assistant messages with parts render
      if (message.parts && message.parts.length > 0) return true;
      // Keep cancelled messages for "Response stopped" badge
      if (message.cancelled_at) return true;
      // Skip empty messages (message.created arrived but no parts yet — will appear once parts come)
      return false;
    });
  }, [messages]);

  /**
   * The rows the engine's read-only projections are asked about. One adapter,
   * three selectors — see `lib/conversationView`.
   */
  const conversation = useMemo(
    () => conversationView(renderableMessages, sessionStatus === "working"),
    [renderableMessages, sessionStatus]
  );

  /**
   * What the agent is doing right now → the CircularPixelGrid variant.
   *
   * `idle` DURING an active turn means "between observable activities" (a tool
   * just completed, the model is about to speak but the stream has not said so
   * yet), not "finished" — so it maps to the default working animation, which
   * is also what a non-working session shows.
   */
  const agentSubState = useMemo((): CircularPixelGridVariant => {
    if (sessionStatus !== "working") return "generating";
    return match(agentActivity(conversation))
      .with("thinking", () => "thinking" as const)
      .with("tool_running", () => "toolExecuting" as const)
      .with("tool_failed", () => "error" as const)
      .otherwise(() => "generating" as const);
  }, [sessionStatus, conversation]);

  /**
   * Group consecutive messages into turns.
   *
   * The boundaries are the engine's: a run breaks when the speaker or the turn
   * changes, and `isLatest` is set on the FINAL group only — the guard that
   * keeps a finished turn out of streaming mode in the gap between "user sends"
   * and "first assistant part arrives" (without it, the completed answer above
   * visibly reverts to "working").
   *
   * The groups come back in order, so each is a contiguous slice of
   * `renderableMessages` and the rows themselves never round-trip.
   */
  const turns = useMemo(() => {
    const turnList: Turn[] = [];
    let index = 0;
    let latestUserSentAt: string | null = null;

    for (const group of groupIntoTurns(conversation)) {
      const start = index;
      index += group.entries.length;
      const slice = renderableMessages.slice(start, index);

      if (group.role === "user") {
        // One row per user turn: the engine emits exactly one echo per turn, so
        // a run of user entries can only be one message.
        slice.forEach((message, offset) => {
          latestUserSentAt = message.sent_at ?? null;
          turnList.push({ type: "user", message, messageIndex: start + offset });
        });
        continue;
      }

      turnList.push({
        type: "assistant",
        messages: slice,
        firstMessageIndex: start,
        isLatest: group.isLatest,
        // The clock starts when the user asked, which is the turn before this.
        startedAt: latestUserSentAt,
      });
    }

    return turnList;
  }, [conversation, renderableMessages]);

  // Compaction markers are positional siblings of turns, not messages — they
  // splice in AFTER grouping so a divider never lands inside a turn.
  const timeline = useMemo(() => insertCompactions(turns, compactions), [turns, compactions]);

  // Advance maxAnimatedTurnIndex after commit (useEffect runs once per commit,
  // not twice in StrictMode). During render, shouldAnimate reads the ref purely.
  // Without this separation, StrictMode double-render advances the counter on the
  // first invocation, so the second invocation (which produces DOM) never applies
  // the chat-item-enter CSS class.
  useEffect(() => {
    if (isFirstTurnsRender.current && timeline.length > 0) {
      isFirstTurnsRender.current = false;
      // Only suppress entrance animation for turns loaded from DB (existing
      // conversation). New conversations (started empty) should animate their
      // first turn — skipping the seed lets shouldAnimate fire naturally.
      if (initialMessageCount.current > 0) {
        maxAnimatedTurnIndex.current = timeline.length - 1;
      }
      return;
    }
    const newMax = timeline.length - 1;
    if (newMax > maxAnimatedTurnIndex.current) {
      // Mark this turn for animation. The Set ensures the CSS class persists
      // across re-renders so the 400ms animation isn't interrupted.
      animatedTurnsRef.current.add(newMax);
      maxAnimatedTurnIndex.current = newMax;
      // Clean up after animation completes (400ms duration + 100ms buffer).
      setTimeout(() => animatedTurnsRef.current.delete(newMax), 500);
    }
  }, [timeline.length]);

  // Pre-compute spacing for each turn (needed because virtualizer skips
  // off-screen items — can't compute spacing from DOM neighbors).
  const turnSpacings = useMemo(() => {
    return timeline.map((item, i) =>
      getTurnSpacingClasses(
        item,
        i > 0 ? timeline[i - 1] : null,
        i < timeline.length - 1 ? timeline[i + 1] : null,
        i === 0
      )
    );
  }, [timeline]);

  // ── Virtualizer ──────────────────────────────────────────────────────────
  // Only renders visible turns + overscan buffer. TanStack Virtual v3 uses
  // an internal ResizeObserver on each measureElement ref to auto-detect
  // height changes from expand/collapse — no manual remeasurement needed.
  const estimateSize = useCallback(
    (index: number) => {
      const turn = timeline[index];
      if (!turn) return 100;
      if (turn.type === "compaction") return 36;
      if (turn.type === "user") return 60;
      // Scale estimate with message count — collapsed turns with many hidden
      // messages show a compact header + summary, while expanded turns (latest)
      // need more space. Prevents positioning glitches during scroll.
      const msgCount = turn.messages.length;
      if (msgCount <= 1) return 120;
      if (msgCount <= 3) return 200;
      return 200 + (msgCount - 3) * 40;
    },
    [timeline]
  );

  const getItemKey = useCallback(
    (index: number) => {
      const item = timeline[index];
      if (!item) return index;
      if (item.type === "compaction") return `compaction:${item.compaction.compaction_id}`;
      return item.type === "user" ? item.message.id : item.messages[0].id;
    },
    [timeline]
  );

  const virtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize,
    overscan: 8,
    getItemKey,
  });

  // Calculate indicator margin based on last message role
  const indicatorMarginClass = useMemo(() => {
    const lastRenderableRole = renderableMessages.length
      ? renderableMessages[renderableMessages.length - 1].role
      : null;
    return lastRenderableRole === "user" ? "mt-0" : "mt-1";
  }, [renderableMessages]);

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      {/* Scroll container — absolute inset-0 fills the positioning wrapper */}
      <div
        id="chat-messages"
        role="log"
        aria-live="polite"
        className="absolute inset-0 overflow-x-hidden overflow-y-auto px-3 pt-4 md:px-6 md:pt-6"
        ref={messagesContainerRef}
      >
        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-12 w-12 rounded-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-4 w-[90%]" />
            <Skeleton className="h-4 w-[80%]" />
          </div>
        ) : messages.length === 0 ? (
          <WorkspaceEmptyState
            repoName={workspaceRepoName}
            parentBranch={workspaceParentBranch}
            isFirstSession={isFirstSession}
          />
        ) : (
          <>
            <div className="flex min-h-0 min-w-0 flex-col pb-32">
              {/* Load-older button — shown at the top when there are older messages */}
              {hasOlder && (
                <div className="flex h-10 items-center justify-center">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted flex items-center gap-2 rounded-full px-3 py-1.5 text-xs transition-colors"
                    onClick={onLoadOlder}
                    disabled={loadingOlder}
                  >
                    {loadingOlder ? (
                      <>
                        <div className="border-foreground/20 border-t-foreground/60 h-3.5 w-3.5 animate-spin rounded-full border-2" />
                        <span>Loading earlier messages</span>
                      </>
                    ) : (
                      <span>Load earlier messages</span>
                    )}
                  </button>
                </div>
              )}
              {/* Virtual container — only visible turns + overscan are in the DOM.
                  Position: relative creates the containing block for absolute children.
                  Height = getTotalSize() so the scroll container's scrollHeight is correct. */}
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  width: "100%",
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const turnIndex = virtualItem.index;
                  const turn = timeline[turnIndex];
                  if (!turn) return null;

                  const spacingClass = turnSpacings[turnIndex];

                  // Animate new turns only. The counter comparison catches the first
                  // render; the Set keeps the class applied for 300ms so the 200ms
                  // CSS animation isn't interrupted by streaming re-renders.
                  // Safe during streaming because animations fire per-TURN (not per-
                  // message) — streaming adds messages to the existing turn without
                  // changing turns.length, so no spurious re-animations.
                  const shouldAnimate =
                    (turnIndex === timeline.length - 1 &&
                      turnIndex > maxAnimatedTurnIndex.current) ||
                    animatedTurnsRef.current.has(turnIndex);

                  // A compaction is not a message — it gets no message id.
                  const messageId = match(turn)
                    .with({ type: "user" }, (t) => t.message.id)
                    .with({ type: "assistant" }, (t) => t.messages[0].id)
                    .with({ type: "compaction" }, () => undefined)
                    .exhaustive();

                  return (
                    <div
                      key={virtualItem.key}
                      ref={virtualizer.measureElement}
                      data-index={virtualItem.index}
                      data-message-id={messageId}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <div
                        className={cn(
                          spacingClass,
                          "chat-turn-wrapper min-w-0",
                          shouldAnimate && "chat-item-enter"
                        )}
                      >
                        {match(turn)
                          .with({ type: "user" }, (t) => (
                            <MessageItem message={t.message} isLastInTurn={true} />
                          ))
                          .with({ type: "assistant" }, (t) => (
                            <AssistantTurn
                              messages={t.messages}
                              isLatest={t.isLatest}
                              isWorking={sessionStatus === "working"}
                              startedAt={t.startedAt}
                            />
                          ))
                          .with({ type: "compaction" }, (t) => (
                            <CompactionChip compaction={t.compaction} />
                          ))
                          .exhaustive()}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Context lost — the harness silently started a fresh session
                  instead of resuming. Non-blocking: the composer stays live. */}
              <AnimatePresence>
                {contextLost && (
                  <m.div
                    key="session-context-lost"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15, ease: [0.25, 0.46, 0.45, 0.94] }}
                    className="mt-1 mr-auto w-fit max-w-[60%]"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="border-warning/20 border-l-warning bg-warning/5 flex items-center gap-2.5 rounded-lg border border-l-2 px-3 py-2">
                      <TriangleAlert
                        className="text-warning/60 h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="text-warning text-sm font-medium">
                        Session context was lost — the agent started fresh instead of resuming.
                      </span>
                      {onDismissContextLost && (
                        <button
                          type="button"
                          onClick={onDismissContextLost}
                          className="text-warning/50 hover:text-warning focus-visible:ring-ring -mr-1 shrink-0 rounded-md p-0.5 transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
                          aria-label="Dismiss"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </m.div>
                )}
              </AnimatePresence>

              {/* Session-level error — rendered inline in the chat flow (law of locality) */}
              <AnimatePresence>
                {sessionStatus === "error" && errorMessage && (
                  <m.div
                    key="session-error"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15, ease: [0.25, 0.46, 0.45, 0.94] }}
                    className={cn("mr-auto", "mt-1 w-fit max-w-[60%]")}
                    role="alert"
                    aria-live="assertive"
                  >
                    <div className="border-destructive/20 border-l-destructive bg-destructive/5 flex items-center gap-4 rounded-lg border border-l-2 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-destructive/80 text-xs font-medium">
                          {match(errorCategory)
                            .with("auth", () => "Authentication Error")
                            .with("rate_limit", () => "Rate Limited")
                            .with("context_limit", () => "Limit Reached")
                            .with("network", () => "Connection Error")
                            .with("db_write", () => "Database Error")
                            .with("process_exit", () => "Process Crashed")
                            .otherwise(() =>
                              agentHarness
                                ? `${agentHarness.charAt(0).toUpperCase() + agentHarness.slice(1)} Error`
                                : "Error"
                            )}
                        </p>
                        <p className="text-foreground/80 mt-0.5 text-sm break-words">
                          {errorMessage}
                        </p>
                        {errorCategory === "rate_limit" && (
                          <p className="text-muted-foreground mt-1 text-xs">
                            Start a new chat to try again.
                          </p>
                        )}
                        {errorCategory === "process_exit" && (
                          <p className="text-muted-foreground mt-1 text-xs">
                            The agent process exited unexpectedly. Try sending your message again.
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {match(errorCategory)
                          .with("auth", () =>
                            onOpenLoginTerminal ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={onOpenLoginTerminal}
                              >
                                <TerminalSquare className="mr-1.5 h-3.5 w-3.5" />
                                Log in
                              </Button>
                            ) : null
                          )
                          .with("context_limit", () =>
                            onRetryInNewChat ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={onRetryInNewChat}
                              >
                                <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" />
                                New session
                              </Button>
                            ) : null
                          )
                          .with("rate_limit", () =>
                            onRetryInNewChat ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={onRetryInNewChat}
                              >
                                Retry in new chat
                              </Button>
                            ) : null
                          )
                          .with("network", () =>
                            onRetryInNewChat ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={onRetryInNewChat}
                              >
                                Retry in new chat
                              </Button>
                            ) : null
                          )
                          .with("process_exit", () =>
                            onRetryInNewChat ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={onRetryInNewChat}
                              >
                                Retry in new chat
                              </Button>
                            ) : null
                          )
                          .otherwise(() =>
                            onRetryInNewChat ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={onRetryInNewChat}
                              >
                                Retry in new chat
                              </Button>
                            ) : null
                          )}
                      </div>
                    </div>
                  </m.div>
                )}
              </AnimatePresence>
              <AnimatePresence>
                {sessionStatus === "working" && (
                  <m.div
                    key="working-indicator"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2, ease: [0.215, 0.61, 0.355, 1] }}
                    role="status"
                    aria-live="polite"
                    aria-label={`Working for ${formattedDuration || "0.0s"}`}
                    className={cn(
                      "mr-auto flex items-center gap-2 px-2 py-1.5",
                      indicatorMarginClass
                    )}
                  >
                    <CircularPixelGrid
                      variant={agentSubState}
                      size={20}
                      resolution={12}
                      className="flex-shrink-0"
                    />
                    <span className="text-foreground ml-1 font-mono text-xs tracking-tight tabular-nums opacity-50">
                      {formattedDuration || "0.0s"}
                    </span>
                  </m.div>
                )}
              </AnimatePresence>
            </div>
          </>
        )}
      </div>

      {/* Scroll to bottom button — floats over the chat scroll area */}
      <div
        className={`pointer-events-auto absolute right-6 bottom-4 z-10 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
          showScrollButton
            ? "scale-100 opacity-100"
            : "pointer-events-none scale-90 opacity-0 motion-reduce:scale-100"
        }`}
      >
        <Button
          variant="secondary"
          size="icon"
          className="rounded-full shadow-lg transition-shadow duration-200 hover:shadow-xl motion-reduce:transition-none"
          onClick={handleScrollToBottomClick}
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
          aria-controls="chat-messages"
        >
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
