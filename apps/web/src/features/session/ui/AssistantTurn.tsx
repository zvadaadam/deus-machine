/**
 * Assistant Turn Component
 *
 * Wraps consecutive assistant messages into a collapsible "turn".
 * A turn = all assistant messages between user messages.
 *
 * Two rendering modes:
 *
 * STREAMING (isLatest && isWorking):
 *   All messages flow through a single groupMessageToolStreaks pipeline.
 *   No hidden/summary split — this ensures consecutive tool calls group
 *   together even when the latest message is a tool call. Non-trailing
 *   streaks seal immediately (group header appears). Trailing streak
 *   stays open (tools visible individually).
 *
 * COMPLETED (!isWorking or !isLatest):
 *   Messages split into hidden (all but last) + summary (last).
 *   Hidden messages are collapsible behind a TurnStatsHeader.
 *   Summary message is always visible (the final text response).
 *
 * Structure (completed):
 * ┌─ TurnStatsHeader (clickable, shows "Collapse" or metrics)
 * ├─ Collapsible (hides intermediate messages when collapsed)
 * │  ├─ Tool call 1
 * │  ├─ Tool call 2
 * │  └─ Intermediate text
 * └─ Summary message (always visible - last REAL message in turn)
 * └─ [optional] "Response stopped" badge (when turn was cancelled)
 *
 * Cancellation design:
 * The sidecar writes an empty placeholder message with stop_reason: "cancelled"
 * on user cancel. That placeholder is a persistence mechanism — not content.
 * We skip over it so the last real message is the summary, and render
 * "Response stopped" as a badge below the actual content.
 */

import { useMemo, useState, memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Message } from "@/shared/types";
import { MessageItem } from "./MessageItem";
import { ToolGroupBlock } from "./blocks";
import { TurnStatsHeader } from "./TurnStatsHeader";

import { useSession } from "../context";
import { calculateTurnStats, groupMessageToolStreaks } from "./utils";
import { isCancelledMessage } from "../lib/contentParser";
import { match } from "ts-pattern";
import { Square } from "lucide-react";

interface AssistantTurnProps {
  messages: Message[];
  isLatest: boolean; // Controls default expanded state
  isWorking: boolean; // Whether AI is currently working
}

/**
 * Previous turns (isLatest=false, isWorking=false) never change after
 * they're sealed. Only the latest turn re-renders as new messages stream in.
 * This prevents O(N) re-renders across all historical turns on every new message.
 */
export const AssistantTurn = memo(function AssistantTurn({
  messages,
  isLatest,
  isWorking,
}: AssistantTurnProps) {
  const { parseContent } = useSession();

  const [isManuallyExpanded, setIsManuallyExpanded] = useState<boolean | null>(null);
  // Latest turn always starts expanded so users can see all content,
  // especially when a session errors mid-stream (tool call as last message
  // hides the earlier text explanation in the collapsed section).
  // User can still manually collapse via TurnStatsHeader click.
  const isExpanded = isManuallyExpanded !== null ? isManuallyExpanded : isLatest;

  const stats = useMemo(() => calculateTurnStats(messages, parseContent), [messages, parseContent]);

  const isStreaming = isLatest && isWorking;

  // Detect if the last message is a cancellation sentinel.
  // The sidecar writes an empty message with stop_reason: "cancelled" on user cancel.
  // That message is metadata, not content — skip over it to find the real summary.
  const isCancelled = useMemo(
    () => isCancelledMessage(messages[messages.length - 1].content),
    [messages]
  );

  // Split messages: all except the last are hidden (collapsible), last is the summary.
  // When cancelled, the sentinel is excluded — all real messages go into hiddenMessages
  // and the "Response stopped" badge replaces the summary slot entirely.
  const { summaryMessage, hiddenMessages } = useMemo(() => {
    if (isCancelled) {
      // Strip the sentinel; everything else is collapsible content
      const real = messages.length > 1 ? messages.slice(0, -1) : [];
      return { summaryMessage: null, hiddenMessages: real };
    }
    return {
      summaryMessage: messages[messages.length - 1],
      hiddenMessages: messages.slice(0, -1),
    };
  }, [messages, isCancelled]);

  const groupedHidden = useMemo(() => {
    if (isStreaming) return [];
    return groupMessageToolStreaks(hiddenMessages, parseContent);
  }, [isStreaming, hiddenMessages, parseContent]);

  // ── Streaming data (all messages through unified pipeline) ──────────
  // During streaming, ALL messages go through groupMessageToolStreaks so
  // consecutive tool calls group together. The previous approach excluded
  // the last message from grouping (rendered solo as "summaryMessage"),
  // which meant tool grouping was never visible during streaming.
  const groupedAll = useMemo(() => {
    if (!isStreaming) return null;
    return groupMessageToolStreaks(messages, parseContent);
  }, [isStreaming, messages, parseContent]);

  return (
    <div className="assistant-turn flex min-w-0 flex-col" style={{ contain: "layout style" }}>
      {/* Stats header — visible for multi-message turns.
          During streaming, acts as a count indicator. During completed, controls collapse. */}
      {!isStreaming && hiddenMessages.length > 0 && (
        <TurnStatsHeader
          stats={stats}
          isExpanded={isExpanded}
          onClick={() => {
            setIsManuallyExpanded(!isExpanded);
          }}
          hiddenMessageCount={hiddenMessages.length}
        />
      )}

      {groupedAll ? (
        /* ── STREAMING: all messages through unified grouping pipeline ── */
        <div className="flex min-w-0 flex-col gap-1">
          {groupedAll.map((item, idx) =>
            match(item)
              .with({ kind: "message" }, ({ message }) => {
                const isLast = message.id === summaryMessage?.id;
                return (
                  <MessageItem
                    key={message.id}
                    message={message}
                    isLatestAssistant={isLast && isLatest}
                    isLastInTurn={isLast}
                    isWorking={isWorking && isLatest}
                    isStreamingTurn={true}
                  />
                );
              })
              .with({ kind: "message-tool-streak" }, ({ toolBlocks, firstToolId }) => {
                // Non-trailing streaks seal immediately (text/edit follows) so
                // the group header collapses them. Trailing streak stays unsealed
                // — tools visible individually while more may arrive.
                const isTrailing = idx === groupedAll.length - 1;
                const isSealed = !isTrailing;
                return (
                  <ToolGroupBlock
                    key={`stream-streak:${firstToolId}`}
                    blocks={toolBlocks}
                    isSealed={isSealed}
                  />
                );
              })
              .exhaustive()
          )}
        </div>
      ) : (
        /* ── COMPLETED: hidden/summary split for collapsible UI ── */
        <>
          <AnimatePresence initial={false}>
            {isExpanded && hiddenMessages.length > 0 && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] as const }}
                style={{ overflow: "hidden" }}
                className="flex min-w-0 flex-col gap-1"
              >
                {groupedHidden.map((item) =>
                  match(item)
                    .with({ kind: "message" }, ({ message }) => (
                      <MessageItem
                        key={message.id}
                        message={message}
                        isLatestAssistant={false}
                        isLastInTurn={false}
                        isWorking={false}
                      />
                    ))
                    .with({ kind: "message-tool-streak" }, ({ toolBlocks, firstToolId }) => (
                      <ToolGroupBlock
                        key={`msg-streak:${firstToolId}`}
                        blocks={toolBlocks}
                        isSealed={true}
                      />
                    ))
                    .exhaustive()
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Summary slot: either the last real message or the cancelled badge */}
          {isCancelled ? (
            <div className="border-warning/20 border-l-warning bg-warning/5 mx-2 flex items-center gap-2.5 rounded-lg border border-l-2 px-3 py-2">
              <Square className="text-warning/60 h-3.5 w-3.5 shrink-0 fill-current" />
              <span className="text-warning text-sm font-medium">Response stopped</span>
            </div>
          ) : (
            <MessageItem
              message={summaryMessage!}
              isLatestAssistant={isLatest}
              isLastInTurn={true}
              isWorking={false}
            />
          )}
        </>
      )}
    </div>
  );
});
