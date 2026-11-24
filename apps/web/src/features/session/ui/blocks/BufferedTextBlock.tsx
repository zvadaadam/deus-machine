import type { BubbleJoins } from "../bubble";
import { useTextBuffer } from "../../hooks/useTextBuffer";
import { TextBlock } from "./TextBlock";

interface BufferedTextBlockProps {
  text: string;
  isStreaming: boolean;
  bubble?: BubbleJoins;
}

export function BufferedTextBlock({ text, isStreaming, bubble }: BufferedTextBlockProps) {
  return (
    <TextBlock
      block={useTextBuffer(text, isStreaming)}
      bubble={bubble}
      muted={isStreaming && !bubble}
    />
  );
}
