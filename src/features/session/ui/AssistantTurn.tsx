/**
 * Assistant Turn Component
 *
 * Wraps consecutive assistant messages into a collapsible "turn".
 * A turn = all assistant messages between user messages.
 *
 * Behavior:
 * - Latest turn while working: Expanded (user sees tool calls in real-time)
 * - Latest turn when done: Auto-collapses with smooth animation (only summary visible)
 * - Previous turns: Collapsed by default (user sees summary + stats)
 * - Click header to toggle expand/collapse at any time
 *
 * Structure:
 * ┌─ TurnStatsHeader (clickable, shows "Collapse" or metrics)
 * ├─ Collapsible (hides intermediate messages when collapsed)
 * │  ├─ Tool call 1
 * │  ├─ Tool call 2
 * │  └─ Intermediate text
 * └─ Summary message (always visible - last REAL message in turn)
 * └─ [optional] "Turn interrupted" annotation (when turn was cancelled)
 *
 * Cancellation design:
 * The sidecar writes an empty placeholder message with stop_reason: "cancelled"
 * on user cancel. That placeholder is a persistence mechanism — not content.
 * We skip over it so the last real message is the summary, and render
 * "Turn interrupted" as an annotation below the actual content.
 */

import { useMemo, useState, memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Message } from "@/shared/types";
import { MessageItem } from "./MessageItem";
import { ToolGroupBlock } from "./blocks";
import { TurnStatsHeader } from "./TurnStatsHeader";
import { suppressAutoScrollOnExpand } from "../hooks";
import { useSession } from "../context";
import { calculateTurnStats, groupMessageToolStreaks } from "./utils";
import { match } from "ts-pattern";
import { Square } from "lucide-react";

interface AssistantTurnProps {
  messages: Message[];
  isLatest: boolean; // Controls default expanded state
  isWorking: boolean; // Whether AI is currently working
}

/**
 * Memoized: Previous turns (isLatest=false, isWorking=false) never change after
 * they're sealed. Only the latest turn re-renders as new messages stream in.
 * This prevents O(N) re-renders across all historical turns on every new message.
 */
export const AssistantTurn = memo(function AssistantTurn({
  messages,
  isLatest,
  isWorking,
}: AssistantTurnProps) {
  const { parseContent, toolResultMap } = useSession();

  // User can manually toggle, but defaults to isLatest
  const [isManuallyExpanded, setIsManuallyExpanded] = useState<boolean | null>(null);

  // Determine if expanded: manual override OR default to isLatest AND isWorking.
  // While working: expanded so user sees tool calls in real-time.
  // When done: auto-collapses to show only the summary message (final text).
  // User can always click the header to re-expand.
  const isExpanded = isManuallyExpanded !== null ? isManuallyExpanded : isLatest && isWorking;

  // Calculate statistics for this turn (memoized to avoid recalculation)
  const stats = useMemo(
    () => calculateTurnStats(messages, parseContent, toolResultMap),
    [messages, parseContent, toolResultMap]
  );

  // Detect if the last message is a cancellation sentinel.
  // The sidecar writes an empty message with stop_reason: "cancelled" on user cancel.
  // That message is metadata, not content — skip over it to find the real summary.
  const isCancelled = useMemo(() => {
    const last = messages[messages.length - 1];
    try {
      const parsed = JSON.parse(last.content);
      return (parsed.message?.stop_reason as string) === "cancelled";
    } catch {
      return false;
    }
  }, [messages]);

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

  // Group consecutive tool-only hidden messages into streaks.
  // The sidecar stores each tool call as a separate message row. Without this,
  // loading from DB shows tools individually instead of grouped.
  const groupedHidden = useMemo(
    () => groupMessageToolStreaks(hiddenMessages, parseContent),
    [hiddenMessages, parseContent]
  );

  return (
    <div className="assistant-turn flex min-w-0 flex-col" style={{ contain: "layout style" }}>
      {/* Stats header - always visible for multi-message turns */}
      {hiddenMessages.length > 0 && (
        <TurnStatsHeader
          stats={stats}
          isExpanded={isExpanded}
          onClick={() => {
            if (!isExpanded) suppressAutoScrollOnExpand();
            setIsManuallyExpanded(!isExpanded);
          }}
          hiddenMessageCount={hiddenMessages.length}
        />
      )}

      {/* Collapsible section — AnimatePresence for enter/exit opacity fade.
          When collapsed, intermediate messages unmount entirely — no DOM weight
          from tool groups, subagent trees, or thinking blocks. */}
      <AnimatePresence>
        {isExpanded && hiddenMessages.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: [0.165, 0.84, 0.44, 1] as const }}
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
                    isSealed={!(isLatest && isWorking)}
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
          isWorking={isWorking && isLatest}
        />
      )}
    </div>
  );
});
