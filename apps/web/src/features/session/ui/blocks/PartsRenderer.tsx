import { memo, useMemo } from "react";
import type { Part, UnknownPart } from "@shared/protocol-types";
import { assistantTurnContent } from "../../lib/assistantTurnContent";
import { extractChatResources } from "../../lib/chatResources";
import { useSession } from "../../context";
import { TurnStatsHeader } from "../TurnStatsHeader";
import { PartBlock } from "./PartBlock";
import { ChatResourceCards } from "./ChatResourceCards";

interface PartsRendererProps {
  parts: Array<Part | UnknownPart>;
  isStreamingTurn?: boolean;
}

export const PartsRenderer = memo(function PartsRenderer({
  parts,
  isStreamingTurn = false,
}: PartsRendererProps) {
  const { workspacePath } = useSession();
  const blocks = useMemo(() => assistantTurnContent(parts), [parts]);
  const resources = useMemo(
    () =>
      extractChatResources({
        parts: parts.filter((part): part is Part => !("raw" in part)),
        isComplete: !isStreamingTurn,
        workspacePath,
      }),
    [parts, isStreamingTurn, workspacePath]
  );
  return (
    <>
      {blocks.map((block, i) => {
        const streaming = isStreamingTurn && i === blocks.length - 1;
        if (block.type === "activity")
          return <TurnStatsHeader key={block.id} parts={block.parts} streaming={streaming} />;
        return <PartBlock key={block.id} part={block} isStreaming={streaming} />;
      })}
      <ChatResourceCards resources={resources} />
    </>
  );
});
