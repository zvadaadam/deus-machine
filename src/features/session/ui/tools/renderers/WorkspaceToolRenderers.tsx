/**
 * Workspace MCP Tool Renderers
 *
 * Specialized renderers for the 4 workspace tools:
 * - AskUserQuestion: Shows questions asked and user responses
 * - GetWorkspaceDiff: Shows diff output
 * - DiffComment: Shows comments posted on diff
 * - GetTerminalOutput: Shows terminal output
 */

import { HelpCircle, GitCompare, MessageCircle, Terminal } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { cn } from "@/shared/lib/utils";
import { extractText, OutputBlock, ICON_CLS } from "./shared";
import type { ToolRendererProps } from "../../chat-types";

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

export function AskUserQuestionToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { questions } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const isCancelled = output.includes("cancelled");

  // Build preview from first question
  const firstQuestion =
    Array.isArray(questions) && questions.length > 0 ? questions[0].question : "";
  const preview = firstQuestion
    ? firstQuestion.length > 50
      ? firstQuestion.slice(0, 50) + "..."
      : firstQuestion
    : "";

  return (
    <BaseToolRenderer
      toolName="Ask User"
      icon={<HelpCircle className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        preview ? <span className="text-muted-foreground truncate text-xs">{preview}</span> : null
      }
      renderContent={() => (
        <div className="space-y-2 px-2 pb-2">
          {/* Questions */}
          {Array.isArray(questions) &&
            questions.map((q: any, i: number) => (
              <div key={i} className="space-y-1">
                <div className="text-foreground text-sm">{q.question}</div>
                {Array.isArray(q.options) && q.options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map((opt: string, j: number) => (
                      <span
                        key={j}
                        className="bg-muted/60 text-muted-foreground rounded-md px-2 py-0.5 text-xs"
                      >
                        {opt}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}

          {/* Response */}
          {output && (
            <div
              className={cn(
                "rounded-md px-3 py-2 text-sm",
                isCancelled
                  ? "bg-muted/30 text-muted-foreground italic"
                  : "bg-primary/10 text-foreground"
              )}
            >
              {output}
            </div>
          )}
        </div>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// GetWorkspaceDiff
// ---------------------------------------------------------------------------

export function GetWorkspaceDiffToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { file, stat } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";

  // Build preview
  const preview = file ? file.split("/").pop() || file : stat ? "stat" : "all changes";

  return (
    <BaseToolRenderer
      toolName="Workspace Diff"
      icon={<GitCompare className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="text-muted-foreground truncate font-mono text-xs">{preview}</span>
      )}
      renderContent={() =>
        output ? (
          <OutputBlock>{output}</OutputBlock>
        ) : (
          <div className="text-muted-foreground px-2 pb-2 text-xs italic">No changes found</div>
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// DiffComment
// ---------------------------------------------------------------------------

export function DiffCommentToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { comments } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const count = Array.isArray(comments) ? comments.length : 0;

  return (
    <BaseToolRenderer
      toolName="Diff Comment"
      icon={<MessageCircle className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        count > 0 ? (
          <span className="text-muted-foreground text-xs">
            {count} comment{count !== 1 ? "s" : ""}
          </span>
        ) : null
      }
      renderContent={() => (
        <div className="space-y-2 px-2 pb-2">
          {/* Comment list */}
          {Array.isArray(comments) &&
            comments.map((c: any, i: number) => (
              <div key={i} className="bg-muted/30 rounded-md px-3 py-2 text-xs">
                <span className="text-muted-foreground font-mono">
                  {c.file}:{c.lineNumber}
                </span>
                <div className="text-foreground mt-1">{c.body}</div>
              </div>
            ))}

          {/* Result */}
          {output && <div className="text-muted-foreground text-xs">{output}</div>}
        </div>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// GetTerminalOutput
// ---------------------------------------------------------------------------

export function GetTerminalOutputToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { source } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";

  // Extract source label from output header (format: "[Terminal - running]")
  const headerMatch = output.match(/^\[(.+?)\]/);
  const sourceLabel = headerMatch?.[1] || source || "auto";

  return (
    <BaseToolRenderer
      toolName="Terminal Output"
      icon={<Terminal className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => <span className="text-muted-foreground text-xs">{sourceLabel}</span>}
      renderContent={() =>
        output ? (
          <OutputBlock>{output}</OutputBlock>
        ) : (
          <div className="text-muted-foreground px-2 pb-2 text-xs italic">
            No terminal output available
          </div>
        )
      }
    />
  );
}
