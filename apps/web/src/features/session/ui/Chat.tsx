import { match } from "ts-pattern";
import type { Message, SessionStatus } from "@/shared/types";
import { MessageItem } from "./MessageItem";
import { AssistantTurn } from "./AssistantTurn";
import { WorkspaceEmptyState } from "./WorkspaceEmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ChevronDown, TerminalSquare, MessageSquarePlus } from "lucide-react";
import { cn } from "@/shared/lib/utils";

import { useWorkingDuration } from "@/shared/hooks";
import { useAutoScroll } from "../hooks";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import { AnimatePresence, m } from "framer-motion";
import { CircularPixelGrid, type CircularPixelGridVariant } from "./CircularPixelGrid";

const USER_PADDING_CLASS = "pb-8";
const TIGHT_PADDING_CLASS = "pb-1";

/**
 * Turn Types
 *
 * A turn = consecutive messages with the same role (user or assistant)
 * - UserTurn: Single user message
 * - AssistantTurn: One or more consecutive assistant messages
 */
type UserTurn = {
  type: "user";
  message: Message;
  messageIndex: number;
};

type AssistantTurnData = {
  type: "assistant";
  messages: Message[];
  firstMessageIndex: number;
  isLatest: boolean;
};

type Turn = UserTurn | AssistantTurnData;

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
  turn: Turn,
  prevTurn: Turn | null,
  nextTurn: Turn | null,
  isFirst: boolean
): string {
  const isUser = turn.type === "user";

  const topClass = (() => {
    if (isUser) {
      if (isFirst) return "pt-8";
      if (prevTurn?.type === "user") return "pt-0";
      return "pt-8";
    }

    // Assistant turn
    if (isFirst) return "pt-1";
    return "pt-0";
  })();

  const bottomClass = (() => {
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
  loading: boolean;
  sessionStatus: SessionStatus;
  errorMessage?: string | null;
  /** Structured error category from classifyError (e.g. "auth", "rate_limit") */
  errorCategory?: string;
  agentType?: string | null;
  latestMessageSentAt?: string | null;
  onStop?: () => void; // Callback to stop/cancel the session
  onOpenLoginTerminal?: () => void;
  onRetryInNewChat?: () => void;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  workspaceRepoName?: string | null;
  workspaceParentBranch?: string | null;
  isFirstSession?: boolean;
  /** Incremented by SessionPanel when the human clicks Send. */
  userSendCount?: number;
  className?: string;
}

export function Chat({
  messages,
  loading,
  sessionStatus,
  errorMessage,
  errorCategory,
  agentType,
  latestMessageSentAt,
  onOpenLoginTerminal,
  onRetryInNewChat,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  workspaceRepoName,
  workspaceParentBranch,
  isFirstSession,
  userSendCount = 0,
  className,
}: ChatProps) {
  // Chat owns its scroll behavior entirely — refs, hook, and button.
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const { showScrollButton, handleScrollToBottomClick, syncGeometry } = useAutoScroll({
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

  // ── Load-older cooldown ─────────────────────────────────────────────────
  // Ref-based guard prevents rapid re-triggering when collapsed content
  // produces too little visual height to push the scroll position away
  // from the trigger zone. Cleared via rAF after prepend scroll restoration.
  const loadOlderCooldownRef = useRef(false);

  // ── Prepend scroll restoration (offset-delta approach) ──────────────────
  //
  // With virtualization, items are absolutely positioned so DOM queries
  // (offsetTop) don't work. Instead, track the virtualizer's getTotalSize()
  // before and after prepend. The delta = height added by prepended items.
  // scrollTop += delta keeps the visual position stable.
  const prevFirstSeqRef = useRef<number | null>(null);
  const prevTotalSizeRef = useRef<number | undefined>(undefined);

  // ── Scroll-position-based load-older (replaces IntersectionObserver) ────
  // Scroll-position math instead of a sentinel div.
  // Fires when scrollTop < TRIGGER_DISTANCE and no cooldown/loading active.
  // The cooldown ref prevents the infinite loop where collapsed tool groups
  // produce too little visual height to push scrollTop above the trigger zone.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !hasOlder || !onLoadOlder) return;

    const TRIGGER_DISTANCE = 200; // px from top
    let ticking = false;

    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (loadingOlder || loadOlderCooldownRef.current) return;
        if (container.scrollTop < TRIGGER_DISTANCE) {
          // Set cooldown synchronously — prevents re-entry before React re-renders.
          loadOlderCooldownRef.current = true;
          onLoadOlder();
        }
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [messagesContainerRef, hasOlder, loadingOlder, onLoadOlder]);

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
      if (message.parent_tool_use_id) return false;
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
   * Derive agent sub-state from the last content block in the message stream.
   * Maps to CircularPixelGrid animation variant:
   * - thinking: last block is ThinkingBlock / REASONING part
   * - generating: last block is TextBlock / TEXT part
   * - toolExecuting: last block is ToolUseBlock with no result / TOOL part PENDING/RUNNING
   * - error: last tool result has is_error / TOOL part ERROR
   */
  const agentSubState = useMemo((): CircularPixelGridVariant => {
    if (sessionStatus !== "working") return "generating";

    for (let i = renderableMessages.length - 1; i >= 0; i--) {
      const msg = renderableMessages[i];
      if (msg.role !== "assistant") continue;
      if (!msg.parts || msg.parts.length === 0) continue;

      const sorted = [...msg.parts].sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0));
      const lastPart = sorted[sorted.length - 1];
      if (!lastPart) return "generating";

      return match(lastPart.type)
        .with("REASONING", () => "thinking" as const)
        .with("TEXT", () => "generating" as const)
        .with("TOOL", () => {
          const status = (lastPart as import("@shared/messages/types").ToolPart).state.status;
          if (status === "ERROR") return "error" as const;
          if (status === "PENDING" || status === "RUNNING") return "toolExecuting" as const;
          return "generating" as const;
        })
        .otherwise(() => "generating" as const);
    }

    return "generating";
  }, [sessionStatus, renderableMessages]);

  /**
   * Group consecutive messages into turns
   *
   * A turn = consecutive messages with the same role
   * - User messages: Each user message is its own turn
   * - Assistant messages: Consecutive assistant messages form a single turn
   *
   * This enables turn-level collapsing (hide intermediate messages, show summary)
   */
  const turns = useMemo(() => {
    const turnList: Turn[] = [];
    let currentAssistantTurn: Message[] | null = null;
    let firstAssistantIndex = -1;

    renderableMessages.forEach((message, index) => {
      if (message.role === "assistant") {
        // Start or continue assistant turn
        if (!currentAssistantTurn) {
          currentAssistantTurn = [message];
          firstAssistantIndex = index;
        } else {
          currentAssistantTurn.push(message);
        }
      } else {
        // User message - close any open assistant turn first
        if (currentAssistantTurn) {
          turnList.push({
            type: "assistant",
            messages: currentAssistantTurn,
            firstMessageIndex: firstAssistantIndex,
            isLatest: false, // Will be updated later
          });
          currentAssistantTurn = null;
        }

        // Add user turn
        turnList.push({
          type: "user",
          message,
          messageIndex: index,
        });
      }
    });

    // Close any remaining assistant turn
    if (currentAssistantTurn) {
      turnList.push({
        type: "assistant",
        messages: currentAssistantTurn,
        firstMessageIndex: firstAssistantIndex,
        isLatest: false, // Will be updated later
      });
    }

    // Mark the latest assistant turn — but ONLY if it's the very last turn
    // in the conversation (no user message after it). A turn followed by a
    // user message is completed and must NOT enter streaming mode. Without
    // this guard, the gap between "user sends message" and "first assistant
    // response arrives" causes the previous completed turn to re-enter
    // streaming mode (expanded, dimmed) because isLatest && isWorking = true.
    const lastTurn = turnList[turnList.length - 1];
    if (lastTurn?.type === "assistant") {
      (lastTurn as AssistantTurnData).isLatest = true;
    }

    return turnList;
  }, [renderableMessages]);

  // Advance maxAnimatedTurnIndex after commit (useEffect runs once per commit,
  // not twice in StrictMode). During render, shouldAnimate reads the ref purely.
  // Without this separation, StrictMode double-render advances the counter on the
  // first invocation, so the second invocation (which produces DOM) never applies
  // the chat-item-enter CSS class.
  useEffect(() => {
    if (isFirstTurnsRender.current && turns.length > 0) {
      isFirstTurnsRender.current = false;
      // Only suppress entrance animation for turns loaded from DB (existing
      // conversation). New conversations (started empty) should animate their
      // first turn — skipping the seed lets shouldAnimate fire naturally.
      if (initialMessageCount.current > 0) {
        maxAnimatedTurnIndex.current = turns.length - 1;
      }
      return;
    }
    const newMax = turns.length - 1;
    if (newMax > maxAnimatedTurnIndex.current) {
      // Mark this turn for animation. The Set ensures the CSS class persists
      // across re-renders so the 400ms animation isn't interrupted.
      animatedTurnsRef.current.add(newMax);
      maxAnimatedTurnIndex.current = newMax;
      // Clean up after animation completes (400ms duration + 100ms buffer).
      setTimeout(() => animatedTurnsRef.current.delete(newMax), 500);
    }
  }, [turns.length]);

  // Pre-compute spacing for each turn (needed because virtualizer skips
  // off-screen items — can't compute spacing from DOM neighbors).
  const turnSpacings = useMemo(() => {
    return turns.map((turn, i) =>
      getTurnSpacingClasses(
        turn,
        i > 0 ? turns[i - 1] : null,
        i < turns.length - 1 ? turns[i + 1] : null,
        i === 0
      )
    );
  }, [turns]);

  // ── Virtualizer ──────────────────────────────────────────────────────────
  // Only renders visible turns + overscan buffer. TanStack Virtual v3 uses
  // an internal ResizeObserver on each measureElement ref to auto-detect
  // height changes from expand/collapse — no manual remeasurement needed.
  const estimateSize = useCallback(
    (index: number) => {
      const turn = turns[index];
      if (!turn) return 100;
      if (turn.type === "user") return 60;
      // Scale estimate with message count — collapsed turns with many hidden
      // messages show a compact header + summary, while expanded turns (latest)
      // need more space. Prevents positioning glitches during scroll.
      const msgCount = turn.messages.length;
      if (msgCount <= 1) return 120;
      if (msgCount <= 3) return 200;
      return 200 + (msgCount - 3) * 40;
    },
    [turns]
  );

  const getItemKey = useCallback(
    (index: number) => {
      const turn = turns[index];
      if (!turn) return index;
      return turn.type === "user" ? turn.message.id : turn.messages[0].id;
    },
    [turns]
  );

  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize,
    overscan: 8,
    getItemKey,
  });

  // ── Prepend scroll restoration (offset-delta) ──────────────────────────
  // When older messages are prepended, the virtualizer's total size grows
  // by the estimated height of the new items. Adding that delta to scrollTop
  // keeps the viewport position stable. No DOM queries needed.
  useLayoutEffect(() => {
    if (!messages.length) return;

    const currentFirstSeq = messages[0].seq;
    const prevFirstSeq = prevFirstSeqRef.current;

    if (prevFirstSeq !== null && currentFirstSeq < prevFirstSeq) {
      const newTotalSize = virtualizer.getTotalSize();
      const prevTotalSize = prevTotalSizeRef.current;
      if (prevTotalSize !== undefined) {
        const delta = newTotalSize - prevTotalSize;
        const container = messagesContainerRef.current;
        if (container && delta > 0) {
          container.scrollTop += delta;
          syncGeometry();
          requestAnimationFrame(() => {
            loadOlderCooldownRef.current = false;
          });
        }
      }
    }

    prevFirstSeqRef.current = currentFirstSeq;
    prevTotalSizeRef.current = virtualizer.getTotalSize();
  }, [messages, virtualizer, syncGeometry]);

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
              {/* Load-older spinner — outside virtualizer, at physical top */}
              {hasOlder && loadingOlder && (
                <div className="flex h-10 items-center justify-center">
                  <div className="bg-muted/50 flex items-center gap-2 rounded-full px-3 py-1.5">
                    <div className="border-foreground/20 border-t-foreground/60 h-3.5 w-3.5 animate-spin rounded-full border-2" />
                    <span className="text-muted-foreground text-xs">Loading earlier messages</span>
                  </div>
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
                  const turn = turns[turnIndex];
                  if (!turn) return null;

                  const spacingClass = turnSpacings[turnIndex];

                  // Animate new turns only. The counter comparison catches the first
                  // render; the Set keeps the class applied for 300ms so the 200ms
                  // CSS animation isn't interrupted by streaming re-renders.
                  // Safe during streaming because animations fire per-TURN (not per-
                  // message) — streaming adds messages to the existing turn without
                  // changing turns.length, so no spurious re-animations.
                  const shouldAnimate =
                    (turnIndex === turns.length - 1 && turnIndex > maxAnimatedTurnIndex.current) ||
                    animatedTurnsRef.current.has(turnIndex);

                  const messageId = turn.type === "user" ? turn.message.id : turn.messages[0].id;

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
                        {turn.type === "user" ? (
                          <MessageItem message={turn.message} isLastInTurn={true} />
                        ) : (
                          <AssistantTurn
                            messages={turn.messages}
                            isLatest={turn.isLatest}
                            isWorking={sessionStatus === "working"}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
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
                              agentType
                                ? `${agentType.charAt(0).toUpperCase() + agentType.slice(1)} Error`
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
