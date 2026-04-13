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
  CompactionPart,
} from "@shared/messages/types";
import { TextBlock } from "./TextBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { StreamingReasoningBlock } from "./StreamingReasoningBlock";
import { BufferedTextBlock } from "./BufferedTextBlock";
import { ToolPartBlock } from "./ToolPartBlock";
import { PartToolGroupBlock } from "./PartToolGroupBlock";
import { groupPartItems } from "../utils/groupParts";
import { Layers } from "lucide-react";

interface PartsRendererProps {
  parts: Part[];
  isStreamingTurn?: boolean;
}

export const PartsRenderer = memo(function PartsRenderer({
  parts,
  isStreamingTurn = false,
}: PartsRendererProps) {
  // Sort by partIndex (assigned by adapter at creation time)
  const sorted = useMemo(
    () => [...parts].sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0)),
    [parts]
  );

  // Group consecutive read-only tool parts into collapsible streaks
  const grouped = useMemo(() => groupPartItems(sorted, isStreamingTurn), [sorted, isStreamingTurn]);

  if (grouped.length === 0) return null;

  // Find the last TEXT part for streaming dimming
  let lastTextPartId: string | null = null;
  if (isStreamingTurn) {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].type === "TEXT") {
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
    </>
  );
});

function renderPart(part: Part, lastTextPartId: string | null, isStreamingTurn: boolean) {
  return match(part)
    .with({ type: "TEXT" }, (p: TextPart) => {
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
    .with({ type: "REASONING" }, (p: ReasoningPart) => {
      const isActivelyStreaming = isStreamingTurn && p.state === "STREAMING";
      if (isActivelyStreaming) {
        return <StreamingReasoningBlock key={p.id} text={p.text} />;
      }
      return <ThinkingBlock key={p.id} part={p} durationSec={getReasoningDurationSec(p)} />;
    })
    .with({ type: "TOOL" }, (p: ToolPart) => <ToolPartBlock key={p.id} part={p} />)
    .with({ type: "COMPACTION" }, (p: CompactionPart) => (
      <div key={p.id} className="flex items-center gap-2 px-2 py-1 text-xs opacity-50">
        <Layers className="h-3 w-3" />
        <span>{p.auto ? "Auto-compacted" : "Compacted"}</span>
      </div>
    ))
    .exhaustive();
}

function getReasoningDurationSec(part: ReasoningPart): number | undefined {
  const start = part.time?.start;
  const end = part.time?.end;

  if (!start || !end) return undefined;

  const durationMs = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;

  return Math.max(2, Math.round(durationMs / 1_000));
}
