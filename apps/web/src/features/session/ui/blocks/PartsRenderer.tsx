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
import type {
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  ImagePart,
  FilePart,
  UnknownPart,
} from "@shared/protocol-types";
import { TextBlock } from "./TextBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { StreamingReasoningBlock } from "./StreamingReasoningBlock";
import { BufferedTextBlock } from "./BufferedTextBlock";
import { ToolPartBlock } from "./ToolPartBlock";
import { PartToolGroupBlock } from "./PartToolGroupBlock";
import { ChatResourceCards } from "./ChatResourceCards";
import { groupPartItems } from "../utils/groupParts";
import { Paperclip } from "lucide-react";
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

  // Find the last text part for streaming dimming
  let lastTextPartId: string | null = null;
  if (isStreamingTurn) {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].type === "text") {
        lastTextPartId = sorted[i].id;
        break;
      }
    }
  }

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
          .with({ kind: "part" }, ({ item }) => renderPart(item, lastTextPartId, isStreamingTurn))
          .exhaustive()
      )}
      <ChatResourceCards resources={resources} />
    </>
  );
});

function renderPart(part: Part, lastTextPartId: string | null, isStreamingTurn: boolean) {
  return (
    match(part)
      .with({ type: "text" }, (p: TextPart) => {
        const isActivelyStreaming = isStreamingTurn && p.id === lastTextPartId;
        if (isActivelyStreaming) {
          return <BufferedTextBlock key={p.id} text={p.text} isStreaming={true} />;
        }
        return (
          <TextBlock
            key={p.id}
            block={{ type: "text", text: p.text }}
            role="assistant"
            weight="normal"
          />
        );
      })
      .with({ type: "reasoning" }, (p: ReasoningPart) => {
        const isActivelyStreaming = isStreamingTurn && p.state === "streaming";
        if (isActivelyStreaming) {
          return <StreamingReasoningBlock key={p.id} text={p.text} />;
        }
        return <ThinkingBlock key={p.id} part={p} durationSec={getReasoningDurationSec(p)} />;
      })
      .with({ type: "tool" }, (p: ToolPart) => <ToolPartBlock key={p.id} part={p} />)
      // The user echo can carry attachments; the model never emits them.
      .with({ type: "image" }, (p: ImagePart) => (
        <img
          key={p.id}
          src={p.url ?? `data:${p.mimeType};base64,${p.data ?? ""}`}
          alt="attachment"
          className="border-border max-h-64 rounded-md border"
        />
      ))
      .with({ type: "file" }, (p: FilePart) => (
        <div key={p.id} className="flex items-center gap-2 px-2 py-1 text-xs opacity-70">
          <Paperclip className="h-3 w-3" />
          <span>{p.filename ?? p.mimeType}</span>
        </div>
      ))
      .exhaustive()
  );
}

/** Reasoning duration, from the part's epoch-ms stamps. */
function getReasoningDurationSec(part: ReasoningPart): number | undefined {
  const start = part.time?.start;
  const end = part.time?.end;

  if (start === undefined || end === undefined) return undefined;

  const durationMs = end - start;
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;

  return Math.max(2, Math.round(durationMs / 1_000));
}
