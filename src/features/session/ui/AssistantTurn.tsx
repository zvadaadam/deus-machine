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

import { useMemo, useState } from "react";
import type { Message } from "@/shared/types";
import { MessageItem } from "./MessageItem";
import { TurnStatsHeader } from "./TurnStatsHeader";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { useSession } from "../context";
import { calculateTurnStats } from "./utils";
import { Square } from "lucide-react";
import { chatTheme } from "./theme";
import { cn } from "@/shared/lib/utils";

interface AssistantTurnProps {
  messages: Message[];
  isLatest: boolean; // Controls default expanded state
  isWorking: boolean; // Whether AI is currently working
}

export function AssistantTurn({ messages, isLatest, isWorking }: AssistantTurnProps) {
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
    <div className="assistant-turn flex min-w-0 flex-col">
      {/* Stats header - always visible for multi-message turns */}
      {hiddenMessages.length > 0 && (
        <TurnStatsHeader
          stats={stats}
          isExpanded={isExpanded}
          onClick={() => setIsManuallyExpanded(!isExpanded)}
          hiddenMessageCount={hiddenMessages.length}
        />
      )}

      {/* Collapsible section - intermediate messages and tool calls.
          forceMount keeps children in the DOM when collapsed so SubagentGroupBlock
          retains its internal expand/collapse state across turn toggles.
          Uses CSS grid rows trick for smooth height animation (see global.css). */}
      {hiddenMessages.length > 0 && (
        <Collapsible open={isExpanded}>
          <CollapsibleContent forceMount className="turn-collapsible">
            <div className="min-h-0 overflow-hidden">
              <div className="flex min-w-0 flex-col gap-1">
                {hiddenMessages.map((message) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    isLatestAssistant={false}
                    isLastInTurn={false}
                    isWorking={false}
                  />
                ))}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Summary message - always visible */}
      {isCancelled ? (
        <div className={cn(chatTheme.message.assistant.container, "flex items-center gap-1.5 py-1")}>
          <Square className="h-3 w-3 fill-current text-muted-foreground/40" />
          <span className="text-xs text-muted-foreground/60">Turn interrupted</span>
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
}
