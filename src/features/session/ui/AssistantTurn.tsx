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
 * └─ Summary message (always visible - last message in turn)
 */

import { useMemo, useState, memo } from "react";
import type { Message } from "@/shared/types";
import { MessageItem } from "./MessageItem";
import { ToolGroupBlock } from "./blocks";
import { TurnStatsHeader } from "./TurnStatsHeader";
import { useSession } from "../context";
import { notifyUserExpand } from "../hooks/useAutoScroll";
import { anchorAndCorrect, findScrollContainer } from "../hooks/useScrollAnchor";
import { calculateTurnStats, groupMessageToolStreaks } from "./utils";
import { match } from "ts-pattern";
import { Square } from "lucide-react";
import { cn } from "@/shared/lib/utils";

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

  // Split messages: all except last = hidden, last = summary (always visible)
  const summaryMessage = messages[messages.length - 1];
  const hiddenMessages = messages.slice(0, -1);

  // Group consecutive tool-only hidden messages into streaks.
  // The sidecar stores each tool call as a separate message row. Without this,
  // loading from DB shows tools individually instead of grouped.
  const groupedHidden = useMemo(
    () => groupMessageToolStreaks(hiddenMessages, parseContent),
    [hiddenMessages, parseContent]
  );

  // Detect if the last message is a cancellation marker (stop_reason: "cancelled")
  const isCancelled = useMemo(() => {
    try {
      const parsed = JSON.parse(summaryMessage.content);
      return parsed.message?.stop_reason === "cancelled";
    } catch {
      return false;
    }
  }, [summaryMessage.content]);

  // Check if this is the last message in the turn (always true for summary message)
  const isLastInTurn = true;

  return (
    <div className="assistant-turn flex min-w-0 flex-col" style={{ contain: "layout style" }}>
      {/* Stats header - always visible for multi-message turns */}
      {hiddenMessages.length > 0 && (
        <TurnStatsHeader
          stats={stats}
          isExpanded={isExpanded}
          onClick={(e) => {
            notifyUserExpand();
            const container = findScrollContainer(e.currentTarget);
            if (container) anchorAndCorrect(e.currentTarget, container);
            setIsManuallyExpanded(!isExpanded);
          }}
          hiddenMessageCount={hiddenMessages.length}
        />
      )}

      {/* Collapsible section — intermediate messages and tool calls.
          Plain div with data-state replaces Radix Collapsible because Radix's
          useLayoutEffect kills CSS grid transitions (sets transition-duration:0s for measurement).
          Content stays in DOM so SubagentGroupBlock retains expand/collapse state. */}
      {hiddenMessages.length > 0 && (
        <div data-state={isExpanded ? "open" : "closed"} className="turn-collapsible">
          <div className="min-h-0 overflow-hidden">
            <div className="flex min-w-0 flex-col gap-1">
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
            </div>
          </div>
        </div>
      )}

      {/* Summary message - always visible */}
      {isCancelled ? (
        <div className={cn("mr-auto", "flex items-center gap-1.5 py-1")}>
          <Square className="text-muted-foreground/40 h-3 w-3 fill-current" />
          <span className="text-muted-foreground/60 text-xs">Turn interrupted</span>
        </div>
      ) : (
        <MessageItem
          message={summaryMessage}
          isLatestAssistant={isLatest}
          isLastInTurn={isLastInTurn}
          isWorking={isWorking && isLatest} // Only latest turn can be "working"
        />
      )}
    </div>
  );
});
