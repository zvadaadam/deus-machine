import { HelpCircle, GitCompare, MessageCircle, Terminal } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { cn } from "@/shared/lib/utils";
import { extractText, OutputBlock, ICON_CLS } from "./shared";
import type { ToolRendererProps } from "../../chat-types";
import { getPathLeaf } from "../utils/getPathLeaf";

type AskUserQuestionInput = {
  question?: string;
  options?: unknown;
};

type DiffCommentInput = {
  file?: string;
  lineNumber?: number;
  body?: string;
};

function isQuestionInput(value: unknown): value is AskUserQuestionInput {
  return !!value && typeof value === "object";
}

function isDiffCommentInput(value: unknown): value is DiffCommentInput {
  return !!value && typeof value === "object";
}

function toQuestionList(questions: unknown): AskUserQuestionInput[] {
  return Array.isArray(questions) ? questions.filter(isQuestionInput) : [];
}

function toDiffCommentList(comments: unknown): DiffCommentInput[] {
  return Array.isArray(comments) ? comments.filter(isDiffCommentInput) : [];
}

function toStringList(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : [];
}

export function AskUserQuestionToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { questions } = toolUse.input ?? {};
  const questionList = toQuestionList(questions);
  const output = toolResult ? extractText(toolResult.content) : "";
  const isCancelled = output.includes("cancelled");

  const firstQuestion = questionList.length > 0 ? (questionList[0].question ?? "") : "";
  const preview = firstQuestion
    ? firstQuestion.length > 50
      ? `${firstQuestion.slice(0, 50)}...`
      : firstQuestion
    : "";

  return (
    <BaseToolRenderer
      toolName="Ask User"
      icon={<HelpCircle className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        preview ? <span className="text-muted-foreground truncate">{preview}</span> : null
      }
      renderContent={() => (
        <div className="space-y-2 px-2 pb-2">
          {questionList.map((question, index) => {
            const options = toStringList(question.options);
            return (
              <div key={index} className="space-y-1">
                <div className="text-foreground text-sm">{question.question}</div>
                {options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {options.map((option, optionIndex) => (
                      <span
                        key={optionIndex}
                        className="bg-muted/60 text-muted-foreground rounded-md px-2 py-0.5 text-xs"
                      >
                        {option}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

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

export function GetWorkspaceDiffToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { file, stat } = toolUse.input ?? {};
  const safeFile = typeof file === "string" ? file : "";
  const output = toolResult ? extractText(toolResult.content) : "";
  const preview = safeFile ? getPathLeaf(safeFile, "all changes") : stat ? "stat" : "all changes";

  return (
    <BaseToolRenderer
      toolName="Workspace Diff"
      icon={<GitCompare className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="text-muted-foreground truncate font-mono">{preview}</span>
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

export function DiffCommentToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { comments } = toolUse.input ?? {};
  const commentList = toDiffCommentList(comments);
  const output = toolResult ? extractText(toolResult.content) : "";
  const count = commentList.length;

  return (
    <BaseToolRenderer
      toolName="Diff Comment"
      icon={<MessageCircle className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        count > 0 ? (
          <span className="text-muted-foreground">
            {count} comment{count !== 1 ? "s" : ""}
          </span>
        ) : null
      }
      renderContent={() => (
        <div className="space-y-2 px-2 pb-2">
          {commentList.map((comment, index) => (
            <div key={index} className="bg-muted/30 rounded-md px-3 py-2 text-xs">
              <span className="text-muted-foreground font-mono">
                {comment.file}:{comment.lineNumber}
              </span>
              <div className="text-foreground mt-1">{comment.body}</div>
            </div>
          ))}

          {output && <div className="text-muted-foreground text-xs">{output}</div>}
        </div>
      )}
    />
  );
}

export function GetTerminalOutputToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { source } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const headerMatch = output.match(/^\[(.+?)\]/);
  const sourceLabel = headerMatch?.[1] || source || "auto";

  return (
    <BaseToolRenderer
      toolName="Terminal Output"
      icon={<Terminal className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => <span className="text-muted-foreground">{sourceLabel}</span>}
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
