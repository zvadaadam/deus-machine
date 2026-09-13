/**
 * Parts Renderer
 *
 * Renders assistant messages from the unified Parts model.
 * Receives Part[] directly (not PartRow[]) — no JSON parsing needed.
 *
 * Features:
 * - Tool grouping: consecutive read-only tools collapse into a header
 * - Streaming text: buffered typewriter via BufferedTextBlock
 * - Reasoning: visible during streaming, collapsed when done
 */

import { memo, useMemo } from "react";
import { match } from "ts-pattern";
import type { Part, UnknownPart } from "@shared/protocol-types";
import { PartBlock } from "./PartBlock";
import { PartToolGroupBlock } from "./PartToolGroupBlock";
import { ChatResourceCards } from "./ChatResourceCards";
import { groupPartItems } from "../utils/groupParts";
import { useSession } from "../../context";
import { extractChatResources } from "../../lib/chatResources";

interface PartsRendererProps {
  parts: Array<Part | UnknownPart>;
  isStreamingTurn?: boolean;
}

export const PartsRenderer = memo(function PartsRenderer({
  parts,
  isStreamingTurn = false,
}: PartsRendererProps) {
  const { workspacePath } = useSession();

  // Parts carry no ordering field — position is the event's knowledge, and
  // both producers (the DB page and the live fold) hand them over in order.
  // An unknown part type is preserved but not rendered (Law 6).
  const sorted = useMemo(() => parts.filter((p): p is Part => !("raw" in p)), [parts]);

  // Group consecutive read-only tool parts into collapsible streaks
  const grouped = useMemo(() => groupPartItems(sorted, isStreamingTurn), [sorted, isStreamingTurn]);
  const resources = useMemo(
    () => extractChatResources({ parts: sorted, isComplete: !isStreamingTurn, workspacePath }),
    [isStreamingTurn, sorted, workspacePath]
  );

  if (grouped.length === 0) return null;

  const lastPart = sorted.at(-1);
  const streamingTextId = lastPart?.type === "text" ? lastPart.id : undefined;

  return (
    <>
      {grouped.map((groupedItem) =>
        match(groupedItem)
          .with({ kind: "tool-streak" }, (streak) => (
            <PartToolGroupBlock
              key={`streak:${streak.firstPartId}`}
              parts={streak.parts}
              isSealed={streak.isSealed}
            />
          ))
          .with({ kind: "part" }, ({ item }) => (
            <PartBlock
              key={item.id}
              part={item}
              isStreaming={isStreamingTurn && (item.type !== "text" || item.id === streamingTextId)}
            />
          ))
          .exhaustive()
      )}
      <ChatResourceCards resources={resources} />
    </>
  );
});
