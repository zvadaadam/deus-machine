/**
 * Default Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Fallback renderer for unknown/unsupported tools.
 * Supports MCP server tools with mixed content (text + images).
 *
 * BEFORE: 70 LOC
 * AFTER: ~25 LOC → Now ~80 LOC (with content block rendering)
 */

import { Wrench } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { chatTheme } from "../../theme";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";

/**
 * Content block types from MCP server tools
 */
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

/**
 * Type guard: Check if content is an array of content blocks
 */
function isContentBlockArray(content: any): content is ContentBlock[] {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((item) => item && typeof item === "object" && "type" in item)
  );
}

/**
 * Render individual content block (text or image)
 */
function ContentBlockRenderer({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return (
      <div className="text-foreground text-sm leading-relaxed whitespace-pre-wrap">
        {block.text}
      </div>
    );
  }

  if (block.type === "image") {
    const { data, media_type } = block.source;
    const dataUrl = `data:${media_type};base64,${data}`;

    return (
      <img
        src={dataUrl}
        alt="Tool output"
        className="border-border/40 max-w-full rounded-lg border shadow-sm"
      />
    );
  }

  // Unknown block type - show JSON
  return (
    <pre className="bg-muted/60 border-border/60 overflow-x-auto rounded-lg border p-3 font-mono text-xs">
      {JSON.stringify(block, null, 2)}
    </pre>
  );
}

export function DefaultToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  // Extract first input value as preview (if available)
  const firstInputKey = Object.keys(toolUse.input || {})[0];
  const firstInputValue = firstInputKey
    ? String(toolUse.input[firstInputKey]).substring(0, 40)
    : "";

  return (
    <BaseToolRenderer
      toolName={toolUse.name || "Unknown Tool"}
      icon={
        <Wrench
          className={cn(
            chatTheme.tools.iconSize,
            chatTheme.tools.iconBase,
            "text-muted-foreground"
          )}
        />
      }
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() =>
        firstInputValue ? (
          <span className={cn(chatTheme.blocks.tool.contentHierarchy.summary, "font-mono")}>
            {firstInputValue}
          </span>
        ) : undefined
      }
      renderContent={({ toolUse, toolResult }) => {
        // Check if output is content block array (MCP tools with text/images)
        const hasContentBlocks = toolResult && isContentBlockArray(toolResult.content);

        return (
          <div className="space-y-3 px-2 pb-2">
            {/* Input */}
            <div>
              <div className="text-muted-foreground mb-1 text-xs font-semibold">Input:</div>
              <pre className="bg-muted/60 border-border/60 max-h-[200px] overflow-x-auto overflow-y-auto rounded-lg border p-3 font-mono text-xs">
                {JSON.stringify(toolUse.input, null, 2)}
              </pre>
            </div>

            {/* Output */}
            {toolResult && (
              <div>
                <div className="text-muted-foreground mb-1 text-xs font-semibold">Output:</div>

                {hasContentBlocks ? (
                  // Render content blocks (text + images)
                  <div className="space-y-3">
                    {(toolResult.content as ContentBlock[]).map((block, index) => (
                      <ContentBlockRenderer key={index} block={block} />
                    ))}
                  </div>
                ) : (
                  // Fallback: Show JSON for unknown structure
                  <pre className="bg-muted/60 border-border/60 max-h-[200px] overflow-x-auto overflow-y-auto rounded-lg border p-3 font-mono text-xs">
                    {typeof toolResult.content === "object"
                      ? JSON.stringify(toolResult.content, null, 2)
                      : toolResult.content}
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
