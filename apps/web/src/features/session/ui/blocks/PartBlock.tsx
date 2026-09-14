import { match } from "ts-pattern";
import type {
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  ImagePart,
  FilePart,
} from "@shared/protocol-types";
import { Paperclip } from "lucide-react";
import { TextBlock } from "./TextBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { StreamingReasoningBlock } from "./StreamingReasoningBlock";
import { BufferedTextBlock } from "./BufferedTextBlock";
import { ToolPartBlock } from "./ToolPartBlock";

export function PartBlock({ part, isStreaming = false }: { part: Part; isStreaming?: boolean }) {
  return (
    match(part)
      .with({ type: "text" }, (p: TextPart) => {
        const isActivelyStreaming = isStreaming;
        if (isActivelyStreaming) {
          return <BufferedTextBlock key={p.id} text={p.text} isStreaming={true} />;
        }
        return <TextBlock key={p.id} block={p.text} role="assistant" weight="normal" />;
      })
      .with({ type: "reasoning" }, (p: ReasoningPart) => {
        const isActivelyStreaming = isStreaming && p.state === "streaming";
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
