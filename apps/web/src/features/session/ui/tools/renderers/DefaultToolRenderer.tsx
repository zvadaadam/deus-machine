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

export function DefaultToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const firstInputKey = Object.keys(toolUse.input || {})[0];
  const firstInputValue = firstInputKey
    ? String(toolUse.input[firstInputKey]).substring(0, 40)
    : "";

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
