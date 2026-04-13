import { Globe } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { cn } from "@/shared/lib/utils";
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";
import type { ToolRendererProps } from "../../chat-types";

export function WebFetchToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { url, prompt } = toolUse.input ?? {};
  const isError = toolResult?.is_error;

  // Parse result content
  const result =
    toolResult && !isError
      ? typeof toolResult.content === "string"
        ? toolResult.content
        : JSON.stringify(toolResult.content, null, 2)
      : "";

  const hasResult = result && result.trim().length > 0;

  // Extract domain from URL for preview
  const getDomain = () => {
    if (!url) return "";
    try {
      const u = new URL(url);
      return u.hostname.replace("www.", "");
    } catch {
      return url;
    }
  };

  return (
    <BaseToolRenderer
      toolName="Web Fetch"
      icon={<Globe className={cn(TOOL_ICON_CLS, TOOL_COLORS.WebFetch)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <span className={cn("text-muted-foreground truncate text-sm", "font-mono")}>
          {getDomain()}
        </span>
      )}
      renderContent={() => {
        // No result message
        if (!hasResult) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">
              No content returned
            </div>
          );
        }

        // Result display
        return (
          <div
            className={cn(
              "text-foreground font-mono text-sm leading-5",
              "overflow-x-auto rounded-md px-3 py-2",
              "bg-muted/50 border-border border",
              "chat-scroll-contain max-h-96 overflow-y-auto"
            )}
          >
            <pre className="m-0 break-words whitespace-pre-wrap">{result}</pre>
          </div>
        );
      }}
    />
  );
}
