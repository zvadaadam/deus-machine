/**
 * Block Renderer
 *
 * Smart dispatcher that renders different content block types.
 * Handles text, tool_use, tool_result, and thinking blocks.
 *
 * CRITICAL: Links tool_use blocks with their corresponding tool_result blocks
 * using the toolResultMap. tool_result blocks are NOT rendered standalone -
 * they're only displayed as part of their tool_use block.
 */

import { match } from "ts-pattern";
import type { ContentBlock, MessageRole } from "@/shared/types";
import { cn } from "@/shared/lib/utils";
import { TextBlock } from "./TextBlock";
import { ToolUseBlock } from "./ToolUseBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { useSession } from "../../context";

interface BlockRendererProps {
  block: ContentBlock | string;
  index: number;
  role?: MessageRole;
  isLastTextBlock?: boolean; // For text weight (muted vs normal)
}

export function BlockRenderer({ block, index, role, isLastTextBlock }: BlockRendererProps) {
  const { toolResultMap } = useSession();
  // Handle null/undefined blocks gracefully
  if (!block) {
    if (import.meta.env.DEV) {
      console.warn("[BlockRenderer] Received null/undefined block at index:", index);
    }
    return null;
  }

  // Determine text weight: last text block in completed turn is 'normal' (white), others are 'muted' (subtle)
  const weight = isLastTextBlock ? "normal" : "muted";

  // Handle string blocks (convert to text block)
  if (typeof block === "string") {
    return <TextBlock block={{ type: "text", text: block }} role={role} weight={weight} />;
  }

  // Dispatch based on block type
  return match(block)
    .with({ type: "text" }, (b) => <TextBlock block={b} role={role} weight={weight} />)
    .with({ type: "image" }, (b) => {
      // Display-only image in chat (no remove button)
      // User: compact 80×80 thumbnails; Assistant: larger inline display
      const isUser = role === "user";
      return (
        <div
          className={cn(
            "border-border/60 overflow-hidden rounded-lg border",
            isUser && "h-[80px] w-[80px] shrink-0"
          )}
        >
          <img
            src={`data:${b.source.media_type};base64,${b.source.data}`}
            alt="Pasted image"
            className={isUser ? "h-full w-full object-cover" : "max-h-64 max-w-full object-contain"}
          />
        </div>
      );
    })
    .with({ type: "tool_use" }, (b) => (
      <ToolUseBlock block={b} toolResult={toolResultMap.get(b.id)} />
    ))
    .with({ type: "tool_result" }, () => null)
    .with({ type: "thinking" }, (b) => <ThinkingBlock block={b} />)
    .otherwise((b) => {
      if (import.meta.env.DEV) {
        console.warn("[BlockRenderer] Unknown block type:", (b as { type?: string }).type, b);
      }
      return null;
    });
}
