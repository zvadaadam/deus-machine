/**
 * Parts Renderer
 *
 * Renders assistant messages from the unified Parts model instead of
 * legacy content blocks. Each PartRow's `data` field is parsed into
 * a typed Part object and dispatched to the appropriate renderer.
 *
 * Part types:
 * - TEXT     -> ChatMarkdown (reuses existing TextBlock style)
 * - REASONING -> ThinkingBlock (reuses existing component)
 * - TOOL    -> ToolPartBlock (new, renders from TOOL Part state machine)
 * - COMPACTION -> subtle indicator (or null)
 */

import { memo, useMemo } from "react";
import { match } from "ts-pattern";
import type { PartRow } from "@/shared/types";
import type { TextPart, ReasoningPart, ToolPart, CompactionPart } from "@shared/messages/types";
import { TextBlock } from "./TextBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolPartBlock } from "./ToolPartBlock";
import { Layers } from "lucide-react";

interface PartsRendererProps {
  parts: PartRow[];
  /** True only for the last text part in the actively-streaming turn. */
  isStreamingTurn?: boolean;
}

type ParsedPart =
  | { type: "TEXT"; part: TextPart; row: PartRow }
  | { type: "REASONING"; part: ReasoningPart; row: PartRow }
  | { type: "TOOL"; part: ToolPart; row: PartRow }
  | { type: "COMPACTION"; part: CompactionPart; row: PartRow };

function parsePart(row: PartRow): ParsedPart | null {
  try {
    const part = JSON.parse(row.data);
    return { type: row.type as ParsedPart["type"], part, row };
  } catch {
    if (import.meta.env.DEV) {
      console.warn("[PartsRenderer] Failed to parse part data:", row.id, row.data);
    }
    return null;
  }
}

/**
 * Memoized: parts array reference changes when new data arrives from WS delta.
 */
export const PartsRenderer = memo(function PartsRenderer({
  parts,
  isStreamingTurn = false,
}: PartsRendererProps) {
  const parsed = useMemo(() => {
    return parts
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map(parsePart)
      .filter((p): p is ParsedPart => p !== null);
  }, [parts]);

  if (parsed.length === 0) return null;

  // Find the last TEXT part index for streaming dimming
  let lastTextIndex = -1;
  if (isStreamingTurn) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].type === "TEXT") {
        lastTextIndex = i;
        break;
      }
    }
  }

  return (
    <>
      {parsed.map((item, index) =>
        match(item)
          .with({ type: "TEXT" }, ({ part, row }) => {
            const isStreaming = isStreamingTurn && index === lastTextIndex;
            return (
              <TextBlock
                key={row.id}
                block={{ type: "text", text: part.text }}
                role="assistant"
                weight={isStreaming ? "muted" : "normal"}
              />
            );
          })
          .with({ type: "REASONING" }, ({ part, row }) => (
            <ThinkingBlock key={row.id} block={{ type: "thinking", thinking: part.text }} />
          ))
          .with({ type: "TOOL" }, ({ part, row }) => (
            <ToolPartBlock key={row.id} part={part} partRow={row} />
          ))
          .with({ type: "COMPACTION" }, ({ part, row }) => (
            <div key={row.id} className="flex items-center gap-2 px-2 py-1 text-xs opacity-50">
              <Layers className="h-3 w-3" />
              <span>{part.auto ? "Auto-compacted" : "Compacted"}</span>
            </div>
          ))
          .exhaustive()
      )}
    </>
  );
});
