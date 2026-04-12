/**
 * Buffered Text Block
 *
 * Wraps TextBlock with useTextBuffer for smooth streaming.
 * Exists as a separate component because hooks can't be called
 * conditionally inside PartsRenderer's map callback.
 *
 * During streaming: shows text smoothly via buffer (muted opacity).
 * After done: falls through to regular TextBlock (no buffer needed).
 */

import { useTextBuffer } from "../../hooks/useTextBuffer";
import { TextBlock } from "./TextBlock";

interface BufferedTextBlockProps {
  text: string;
  isStreaming: boolean;
}

export function BufferedTextBlock({ text, isStreaming }: BufferedTextBlockProps) {
  const displayText = useTextBuffer(text, isStreaming);

  return (
    <TextBlock
      block={{ type: "text", text: displayText }}
      role="assistant"
      weight={isStreaming ? "muted" : "normal"}
    />
  );
}
