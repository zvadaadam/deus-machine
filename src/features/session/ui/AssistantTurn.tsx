/**
 * Assistant Turn Component
 *
 * Wraps consecutive assistant messages into a collapsible "turn".
 * A turn = all assistant messages between user messages.
 *
 * Behavior:
 * - Latest turn: Always expanded (user sees everything)
 * - Previous turns: Collapsed by default (user sees summary + stats)
 * - Click header to toggle expand/collapse
 *
 * Structure:
 * ┌─ TurnStatsHeader (clickable, shows aggregated stats)
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

interface AssistantTurnProps {
  messages: Message[];
  isLatest: boolean; // Controls default expanded state
  isWorking: boolean; // Whether AI is currently working
}

export function AssistantTurn({ messages, isLatest, isWorking }: AssistantTurnProps) {
  const { parseContent, toolResultMap } = useSession();

  // User can manually toggle, but defaults to isLatest
  const [isManuallyExpanded, setIsManuallyExpanded] = useState<boolean | null>(null);

  // Determine if expanded: manual override OR default to isLatest
  const isExpanded = isManuallyExpanded !== null ? isManuallyExpanded : isLatest;

  // Calculate statistics for this turn (memoized to avoid recalculation)
  const stats = useMemo(
    () => calculateTurnStats(messages, parseContent, toolResultMap),
    [messages, parseContent, toolResultMap]
  );

  // Split messages: all except last = hidden, last = summary (always visible)
  const summaryMessage = messages[messages.length - 1];
  const hiddenMessages = messages.slice(0, -1);

  // Check if this is the last message in the turn (always true for summary message)
  const isLastInTurn = true;

  return (
    <div className="assistant-turn flex min-w-0 flex-col">
      {/* Stats header - hide while AI is actively working, show once complete or for old turns */}
      {hiddenMessages.length > 0 && !(isLatest && isWorking) && (
        <TurnStatsHeader
          stats={stats}
          isExpanded={isExpanded}
          onClick={() => setIsManuallyExpanded(!isExpanded)}
          hiddenMessageCount={hiddenMessages.length}
        />
      )}

      {/* Collapsible section - intermediate messages and tool calls */}
      {hiddenMessages.length > 0 && (
        <Collapsible open={isExpanded}>
          <CollapsibleContent>
            <div className="flex min-w-0 flex-col gap-1">
              {hiddenMessages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  isLatestAssistant={false} // Not the latest, so text is muted
                  isLastInTurn={false} // Not the last in turn
                  isWorking={false} // Hidden messages are always complete
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Summary message - always visible */}
      <MessageItem
        message={summaryMessage}
        isLatestAssistant={isLatest}
        isLastInTurn={isLastInTurn}
        isWorking={isWorking && isLatest} // Only latest turn can be "working"
      />
    </div>
  );
}
