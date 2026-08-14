import { useMemo } from "react";
import { match } from "ts-pattern";
import { Wrench } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { TOOL_ICON_CLS } from "../toolColors";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";

type TextContentBlock = {
  type: "text";
  text: string;
};

type ImageContentBlock = {
  type: "image";
  source: {
    type: "base64";
    data: string;
    media_type: string;
  };
};

type ContentBlock = TextContentBlock | ImageContentBlock;

function isTextContentBlock(block: unknown): block is TextContentBlock {
  if (!block || typeof block !== "object") return false;
  const record = block as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

function isImageContentBlock(block: unknown): block is ImageContentBlock {
  if (!block || typeof block !== "object") return false;
  const record = block as Record<string, unknown>;
  if (record.type !== "image" || !record.source || typeof record.source !== "object") {
    return false;
  }

  const source = record.source as Record<string, unknown>;
  return (
    source.type === "base64" &&
    typeof source.data === "string" &&
    typeof source.media_type === "string"
  );
}

function isContentBlockArray(content: unknown): content is ContentBlock[] {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((item) => isTextContentBlock(item) || isImageContentBlock(item))
  );
}

function ContentBlockRenderer({ block }: { block: ContentBlock }) {
  return match(block)
    .with({ type: "text" }, (textBlock) => (
      <div className="text-foreground text-sm leading-relaxed whitespace-pre-wrap">
        {textBlock.text}
      </div>
    ))
    .with({ type: "image" }, (imageBlock) => (
      <img
        src={`data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`}
        alt="Tool output"
        className="border-border/40 max-w-full rounded-lg border shadow-sm"
      />
    ))
    .exhaustive();
}

/** Bounded preview of a non-primitive input value — never serializes the
 *  whole payload (codex apply_patch inputs can be megabytes). */
function boundedPreview(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  return String(value);
}

/**
 * Human summary for arbitrary tool input. Unregistered tools (Codex
 * apply_patch/exec_command, MCP tools, imports) land here — never stringify
 * objects ("[object Object]"); prefer well-known keys, then any primitive,
 * then path-shaped entries of an object array (apply_patch changes), then a
 * bounded structural preview.
 */
function deriveInputSummary(input: Record<string, unknown> | undefined | null): string {
  if (!input || typeof input !== "object") return "";
  const preferred = ["path", "file_path", "command", "query", "pattern", "url", "input", "name"];
  const keys = [...preferred.filter((k) => k in input), ...Object.keys(input)];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      if (value.every((v) => typeof v === "string")) return value.join(" ");
      const first = value[0];
      if (first && typeof first === "object") {
        const p =
          (first as Record<string, unknown>).path ?? (first as Record<string, unknown>).file_path;
        if (typeof p === "string") return value.length > 1 ? `${p} (+${value.length - 1} more)` : p;
      }
    }
  }
  const firstKey = Object.keys(input)[0];
  return firstKey ? boundedPreview(input[firstKey]) : "";
}

export function DefaultToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const input = toolUse.input || {};
  const firstInputValue = useMemo(() => deriveInputSummary(input).substring(0, 60), [input]);

  return (
    <BaseToolRenderer
      toolName={toolUse.name || "Unknown Tool"}
      icon={<Wrench className={cn(TOOL_ICON_CLS, "text-muted-foreground")} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      showContentOnError
      renderSummary={() =>
        firstInputValue ? (
          <span className={cn("text-muted-foreground truncate text-sm", "font-mono")}>
            {firstInputValue}
          </span>
        ) : undefined
      }
      renderContent={({ toolUse: currentToolUse, toolResult: currentToolResult }) => {
        const contentBlocks = isContentBlockArray(currentToolResult?.content)
          ? currentToolResult.content
          : null;

        return (
          <div className="space-y-3 px-2 pb-2">
            <div>
              <div className="text-muted-foreground mb-1 text-xs font-semibold">Input:</div>
              <pre className="bg-muted/60 border-border/60 chat-scroll-contain max-h-[200px] overflow-x-auto overflow-y-auto rounded-lg border p-3 font-mono text-xs">
                {JSON.stringify(currentToolUse.input, null, 2)}
              </pre>
            </div>

            {currentToolResult && (
              <div>
                <div className="text-muted-foreground mb-1 text-xs font-semibold">Output:</div>

                {contentBlocks ? (
                  <div className="space-y-3">
                    {contentBlocks.map((block, index) => (
                      <ContentBlockRenderer key={index} block={block} />
                    ))}
                  </div>
                ) : (
                  <pre className="bg-muted/60 border-border/60 chat-scroll-contain max-h-[200px] overflow-x-auto overflow-y-auto rounded-lg border p-3 font-mono text-xs">
                    {typeof currentToolResult.content === "object"
                      ? JSON.stringify(currentToolResult.content, null, 2)
                      : currentToolResult.content}
                  </pre>
                )}
              </div>
            )}
          </div>
        );
      }}
    />
  );
}
