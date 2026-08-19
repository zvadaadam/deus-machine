import { match } from "ts-pattern";
import type { Compaction, Message, SessionStatus } from "@/shared/types";
import type { WorkspaceKind } from "@shared/enums";
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
import { CloudEnvGroup, useCloudEnvEntries } from "./CloudEnvProgress";
import { buildChatTimeline } from "../lib/chatTimeline";

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
  /** Enables the ephemeral cloud environment progress stack (cloud lane). */
  workspaceId?: string | null;
  /** Cloud workspaces get sandbox copy in the empty state. */
  workspaceKind?: WorkspaceKind;
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
  workspaceId,
  workspaceKind,
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

  // Cloud setup story — spliced into the timeline chronologically (after the
  // send that triggered it, before the reply). Empty for local workspaces.
  const cloudEnvEntries = useCloudEnvEntries(workspaceId);

  // Everything derived from the rows: which ones render, the turns they group
  // into, the compaction markers between them, each slot's padding, and what
  // the agent is doing. All pure — see `lib/chatTimeline`.
  const {
    items: timeline,
    spacings: turnSpacings,
    activity,
    lastRole,
  } = useMemo(
    () => buildChatTimeline(messages, compactions, sessionStatus === "working", cloudEnvEntries),
    [messages, compactions, sessionStatus, cloudEnvEntries]
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
    return match(activity)
      .with("thinking", () => "thinking" as const)
      .with("tool_running", () => "toolExecuting" as const)
      .with("tool_failed", () => "error" as const)
      .otherwise(() => "generating" as const);
  }, [sessionStatus, activity]);

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

  // ── Virtualizer ──────────────────────────────────────────────────────────
  // Only renders visible turns + overscan buffer. TanStack Virtual v3 uses
  // an internal ResizeObserver on each measureElement ref to auto-detect
  // height changes from expand/collapse — no manual remeasurement needed.
  const estimateSize = useCallback(
    (index: number) => {
      const turn = timeline[index];
      if (!turn) return 100;
      if (turn.type === "compaction") return 36;
      if (turn.type === "cloudEnv") return 32; // collapsed one-liner
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
      if (item.type === "cloudEnv") return `cloudEnv:${item.entries[0]?.id ?? index}`;
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

  // The working indicator sits tighter under a user message than under a
  // finished assistant turn.
  const indicatorMarginClass = lastRole === "user" ? "mt-0" : "mt-1";

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
        ) : timeline.length === 0 ? (
          // Empty means NOTHING to show — no messages AND no env markers. A
          // fresh cloud workspace provisioning before its first message has a
          // timeline (the spliced cloudEnv item), so it renders through the
          // one virtualized flow below, top-of-flow like a first agent turn.
          <WorkspaceEmptyState
            repoName={workspaceRepoName}
            parentBranch={workspaceParentBranch}
            isFirstSession={isFirstSession}
            kind={workspaceKind}
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

                  // Markers (compaction, env story) are not messages — no id.
                  const messageId = match(turn)
                    .with({ type: "user" }, (t) => t.message.id)
                    .with({ type: "assistant" }, (t) => t.messages[0].id)
                    .with({ type: "compaction" }, () => undefined)
                    .with({ type: "cloudEnv" }, () => undefined)
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
                          .with({ type: "cloudEnv" }, (t) => <CloudEnvGroup entries={t.entries} />)
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
