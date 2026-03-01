import { match } from "ts-pattern";
import type { Message, SessionStatus } from "@/shared/types";
import type { ContentBlock } from "@/features/session/types";
import { MessageItem } from "./MessageItem";
import { AssistantTurn } from "./AssistantTurn";
import { WorkspaceEmptyState } from "./WorkspaceEmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ChevronDown, TerminalSquare, MessageSquarePlus } from "lucide-react";
import { cn } from "@/shared/lib/utils";

import { useWorkingDuration } from "@/shared/hooks";
import { useAutoScroll } from "../hooks";
import { notifyPrependStart, notifyPrependEnd } from "../hooks/useAutoScroll";
import { useSession } from "../context";
import { useMemo, useRef, useEffect, useLayoutEffect } from "react";
import { AnimatePresence, m } from "framer-motion";
import { PixelGrid, type PixelGridVariant } from "./PixelGrid";

const USER_MARGIN_CLASS = "mb-8";
const TIGHT_MARGIN_CLASS = "mb-1";

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
 * Calculate spacing classes for turns (replaces message-level spacing)
 *
 * A turn = consecutive messages with the same role
 * Spacing logic:
 * - First turn: Minimal top margin
 * - User turn after assistant: Generous top margin (mt-8)
 * - User turn after user: No extra margin (consecutive user messages)
 * - Assistant turn: Tight margin (mt-1)
 * - Bottom margin: User turns add mb-8, assistant turns add minimal margin
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
      if (isFirst) return "mt-8";
      if (prevTurn?.type === "user") return "mt-0";
      return "mt-8";
    }

    // Assistant turn
    if (isFirst) return "mt-1";
    return "mt-0";
  })();

  const bottomClass = (() => {
    if (isUser) {
      return USER_MARGIN_CLASS;
    }

    // Assistant turn
    if (nextTurn?.type === "user") {
      return "mb-0";
    }

    if (nextTurn) {
      return TIGHT_MARGIN_CLASS;
    }

    return "mb-0";
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
  className,
}: ChatProps) {
  const { parseContent, toolResultMap, parentToolUseMap } = useSession();

  // Chat owns its scroll behavior entirely — refs, hook, and button.
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);

  const { showScrollButton, hasNewMessages, handleScrollToBottomClick } = useAutoScroll({
    messages,
    messagesContainerRef,
    messagesEndRef,
  });

  // --- Message entrance animation tracking ---
  // seenMessageIds: Prevents re-animation when React Query refetches or
  // the user scrolls. Only messages NOT in this set get entrance animation.
  const seenMessageIds = useRef(new Set<string>());
  // initialLoadDone: The very first batch of messages should appear instantly
  // (no stagger). We mark all initial messages as "seen" on first render.
  const initialLoadDone = useRef(false);

  // Load-older sentinel ref (placed at top of message list)
  const loadOlderSentinelRef = useRef<HTMLDivElement>(null);

  // ── Scroll-position preservation for prepend (load-older) ──────────────
  //
  // Anchor-based with continuous geometry capture — zero pre-fetch dependency.
  //
  // The key insight: capturing geometry before an async fetch is inherently
  // fragile. The fetch may take hundreds of milliseconds during which streaming
  // content changes scrollHeight, or the user scrolls, making captured values
  // stale. Any approach that depends on pre-fetch geometry will produce wrong
  // deltas under concurrent activity.
  //
  // This approach eliminates the problem entirely:
  //
  //   1. prevFirstSeqRef / prevFirstIdRef: identity of the first message.
  //      When the first seq decreases, a prepend occurred.
  //
  //   2. anchorVisualOffsetRef: the first turn element's pixel offset from
  //      the container viewport top. Captured in useLayoutEffect after EVERY
  //      committed render — always exactly one render old, never stale.
  //
  //   3. On prepend: find the element that WAS first (by data-message-id),
  //      read its new offsetTop, set scrollTop = newOffsetTop - savedOffset.
  //      All geometry reads happen in a single synchronous useLayoutEffect.
  //
  //   4. notifyPrependStart/End suppress useAutoScroll's ResizeObserver and
  //      scroll handler during the correction (module-level flags).
  const prevFirstSeqRef = useRef<number | null>(null);
  const prevFirstIdRef = useRef<string | null>(null);
  const anchorVisualOffsetRef = useRef<number>(0);

  useEffect(() => {
    if (!initialLoadDone.current && messages.length > 0) {
      // Mark all existing messages as seen so they don't animate
      messages.forEach((m) => seenMessageIds.current.add(m.id));
      initialLoadDone.current = true;
    }
  }, [messages]);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !messages.length) return;

    const currentFirstSeq = messages[0].seq;
    const currentFirstId = messages[0].id;
    const prevFirstSeq = prevFirstSeqRef.current;
    const prevFirstId = prevFirstIdRef.current;

    // ── Detect prepend: first message's seq decreased ──
    if (prevFirstSeq !== null && currentFirstSeq < prevFirstSeq && prevFirstId) {
      const anchor = container.querySelector(
        `[data-message-id="${CSS.escape(prevFirstId)}"]`
      ) as HTMLElement | null;

      if (anchor) {
        // anchor.offsetTop = position in the NEW layout (pushed down by prepended content).
        // anchorVisualOffsetRef = its visual offset captured on the PREVIOUS render —
        // always fresh because useLayoutEffect updates it on every committed render.
        notifyPrependStart();
        container.scrollTop = anchor.offsetTop - anchorVisualOffsetRef.current;
        // Re-enable auto-scroll after the browser processes the scroll write.
        requestAnimationFrame(() => {
          notifyPrependEnd();
        });
      }

      // Mark prepended messages as "seen" so they skip entrance animation
      for (const m of messages) {
        if (m.seq < prevFirstSeq) {
          seenMessageIds.current.add(m.id);
        }
      }
    }

    // ── Capture anchor geometry for the NEXT render ──
    // Runs synchronously after every committed render. The value is consumed
    // only on the next render that detects a prepend — exactly one render old.
    const firstEl = container.querySelector(
      `[data-message-id="${CSS.escape(currentFirstId)}"]`
    ) as HTMLElement | null;
    if (firstEl) {
      anchorVisualOffsetRef.current = firstEl.offsetTop - container.scrollTop;
    }

    prevFirstSeqRef.current = currentFirstSeq;
    prevFirstIdRef.current = currentFirstId;
  }, [messages]);

  // IntersectionObserver for load-older sentinel (triggers when scrolling near top).
  // No geometry capture needed — the anchor approach handles restoration entirely
  // within useLayoutEffect using continuously-captured offsets.
  useEffect(() => {
    const sentinel = loadOlderSentinelRef.current;
    const container = messagesContainerRef.current;
    if (!sentinel || !container || !hasOlder || !onLoadOlder) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loadingOlder) {
          onLoadOlder();
        }
      },
      {
        root: container,
        rootMargin: "200px 0px 0px 0px", // Trigger 200px before reaching top
        threshold: 0,
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [messagesContainerRef, hasOlder, loadingOlder, onLoadOlder]);

  // Track working duration
  const { formattedDuration } = useWorkingDuration({
    status: sessionStatus,
    latestMessageSentAt,
  });

  // Memoize message filtering to avoid re-parsing JSON on every render
  const renderableMessages = useMemo(() => {
    return messages.filter((message) => {
      // Skip subagent messages — they render nested under Task tool blocks
      if (parentToolUseMap.has(message.id)) return false;

      const contentBlocks = parseContent(message.content);
      const isArray = Array.isArray(contentBlocks);
      const onlyToolResults =
        isArray &&
        contentBlocks.length > 0 &&
        contentBlocks.every(
          (block: ContentBlock | string) =>
            typeof block === "object" && block?.type === "tool_result"
        );
      const isEmpty =
        (isArray && contentBlocks.length === 0) ||
        (!isArray && (contentBlocks == null || String(contentBlocks).trim() === ""));
      return !(onlyToolResults || isEmpty);
    });
  }, [messages, parseContent, parentToolUseMap]);

  /**
   * Derive agent sub-state from the last content block in the message stream.
   * Maps to PixelGrid animation variant:
   * - thinking: last block is ThinkingBlock (extended reasoning)
   * - generating: last block is TextBlock (streaming text)
   * - toolExecuting: last block is ToolUseBlock with no result yet
   * - error: last tool result has is_error=true
   */
  const agentSubState = useMemo((): PixelGridVariant => {
    if (sessionStatus !== "working") return "generating";

    for (let i = renderableMessages.length - 1; i >= 0; i--) {
      const msg = renderableMessages[i];
      if (msg.role !== "assistant") continue;

      const blocks = parseContent(msg.content);
      if (!Array.isArray(blocks) || blocks.length === 0) continue;

      const lastBlock = blocks[blocks.length - 1];
      if (!lastBlock || typeof lastBlock === "string") return "generating";

      return match(lastBlock)
        .with({ type: "thinking" }, () => "thinking" as const)
        .with({ type: "text" }, () => "generating" as const)
        .with({ type: "tool_use" }, (b) => {
          const result = toolResultMap.get(b.id);
          if (result?.is_error) return "error" as const;
          if (!result) return "toolExecuting" as const;
          return "generating" as const;
        })
        .otherwise(() => "generating" as const);
    }

    return "generating";
  }, [sessionStatus, renderableMessages, parseContent, toolResultMap]);

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

    // Mark the latest assistant turn
    for (let i = turnList.length - 1; i >= 0; i--) {
      if (turnList[i].type === "assistant") {
        (turnList[i] as AssistantTurnData).isLatest = true;
        break;
      }
    }

    return turnList;
  }, [renderableMessages]);

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
        className="absolute inset-0 overflow-x-hidden overflow-y-auto px-6 pt-6"
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
              {/* Load-older sentinel — triggers IntersectionObserver when near top */}
              {hasOlder && (
                <div ref={loadOlderSentinelRef} className="flex justify-center py-3">
                  {loadingOlder && (
                    <div className="bg-muted/50 flex items-center gap-2 rounded-full px-3 py-1.5">
                      <div className="border-foreground/20 border-t-foreground/60 h-3.5 w-3.5 animate-spin rounded-full border-2" />
                      <span className="text-muted-foreground text-xs">
                        Loading earlier messages
                      </span>
                    </div>
                  )}
                </div>
              )}
              {/* eslint-disable-next-line react-hooks/refs */}
              {turns.map((turn, turnIndex) => {
                const prevTurn = turnIndex > 0 ? turns[turnIndex - 1] : null;
                const nextTurn = turnIndex < turns.length - 1 ? turns[turnIndex + 1] : null;
                const spacingClass = getTurnSpacingClasses(
                  turn,
                  prevTurn,
                  nextTurn,
                  turnIndex === 0
                );

                // Attach lastMessageRef to the LAST RENDERED turn
                const isLastRendered = turnIndex === turns.length - 1;

                if (turn.type === "user") {
                  // Determine if this is a NEW message that should animate in.
                  // CSS animation replaces Framer Motion m.div: plays once on mount
                  // then the element is a plain div with zero ongoing React overhead.
                  const isNew = !seenMessageIds.current.has(turn.message.id);
                  if (isNew) seenMessageIds.current.add(turn.message.id);

                  return (
                    <div
                      key={turn.message.id}
                      data-message-id={turn.message.id}
                      ref={isLastRendered ? lastMessageRef : undefined}
                      className={cn(
                        spacingClass,
                        "chat-turn-wrapper min-w-0",
                        isNew && "chat-item-enter"
                      )}
                    >
                      <MessageItem
                        message={turn.message}
                        isLatestAssistant={false}
                        isLastInTurn={true}
                        isWorking={sessionStatus === "working"}
                      />
                    </div>
                  );
                }

                // Assistant turn — animate only when the turn FIRST appears.
                // Use the first message's ID as the turn key. When new messages
                // are appended to an existing turn (tool calls, streaming), the
                // turn key is already seen so no re-animation (no blink).
                const turnKey = turn.messages[0].id;
                const isTurnNew = !seenMessageIds.current.has(turnKey);
                if (isTurnNew) seenMessageIds.current.add(turnKey);
                // Still mark all individual message IDs for future reference
                turn.messages.forEach((msg) => seenMessageIds.current.add(msg.id));

                return (
                  <div
                    key={turn.messages[0].id}
                    data-message-id={turn.messages[0].id}
                    ref={isLastRendered ? lastMessageRef : undefined}
                    className={cn(
                      spacingClass,
                      "chat-turn-wrapper min-w-0",
                      isTurnNew && "chat-item-enter"
                    )}
                  >
                    <AssistantTurn
                      messages={turn.messages}
                      isLatest={turn.isLatest}
                      isWorking={sessionStatus === "working"}
                    />
                  </div>
                );
              })}
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
                            You can retry by sending another message.
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
                    <PixelGrid variant={agentSubState} size={15} className="flex-shrink-0" />
                    <span className="text-foreground ml-1 font-mono text-xs tracking-tight tabular-nums opacity-50">
                      {formattedDuration || "0.0s"}
                    </span>
                  </m.div>
                )}
              </AnimatePresence>
              {/* Sentinel for auto-scroll IntersectionObserver.
                  MUST be inside the content wrapper (before pb-32 padding) so it's
                  adjacent to the last message. If placed outside, the 128px padding
                  creates a dead zone where the user sees all content but the sentinel
                  is invisible — breaking auto-scroll re-engagement. */}
              <div ref={messagesEndRef} />
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
          className="relative rounded-full shadow-lg transition-shadow duration-200 hover:shadow-xl motion-reduce:transition-none"
          onClick={handleScrollToBottomClick}
          title={hasNewMessages ? "New messages below" : "Scroll to bottom"}
          aria-label={hasNewMessages ? "New messages below" : "Scroll to bottom"}
          aria-controls="chat-messages"
        >
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
          {hasNewMessages && (
            <span className="bg-primary absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full" />
          )}
        </Button>
      </div>
    </div>
  );
}

