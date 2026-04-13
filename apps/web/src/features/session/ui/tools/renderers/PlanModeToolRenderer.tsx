// Renderers for EnterPlanMode and ExitPlanMode tools.
//
// EnterPlanMode: clean status indicator.
// ExitPlanMode: renders the full plan markdown inline from toolUse.input.plan.
//   The Claude model includes the plan text in the ExitPlanMode tool input,
//   so it's persisted in the messages table and survives restarts.

import { ClipboardList, FileText } from "lucide-react";
import { TOOL_ICON_CLS, TOOL_ICON_MUTED_CLS } from "../toolColors";
import { ChatMarkdown } from "@/components/markdown";
import { BaseToolRenderer } from "../components";
import type { ToolRendererProps } from "../../chat-types";

export function EnterPlanModeToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  return (
    <BaseToolRenderer
      toolName="EnterPlanMode"
      icon={<ClipboardList className={`${TOOL_ICON_CLS} ${TOOL_ICON_MUTED_CLS}`} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => <span className="text-muted-foreground text-sm">Entered plan mode</span>}
    />
  );
}

export function ExitPlanModeToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const plan = typeof toolUse.input?.plan === "string" ? toolUse.input.plan.trim() : "";

  if (!plan) {
    // No plan content — fall back to simple status indicator
    return (
      <BaseToolRenderer
        toolName="ExitPlanMode"
        icon={<FileText className={`${TOOL_ICON_CLS} ${TOOL_ICON_MUTED_CLS}`} />}
        toolUse={toolUse}
        toolResult={toolResult}
        isLoading={isLoading}
        renderSummary={() => (
          <span className="text-muted-foreground text-sm">Plan ready for review</span>
        )}
      />
    );
  }

  // Render plan inline as a markdown card
  return (
    <div className="border-border/40 bg-muted/20 my-2 rounded-xl border">
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <FileText className={`${TOOL_ICON_CLS} ${TOOL_ICON_MUTED_CLS}`} />
        <span className="text-foreground/70 text-sm font-medium">Plan</span>
      </div>
      <div className="px-4 pt-1 pb-3">
        <ChatMarkdown>{plan}</ChatMarkdown>
      </div>
    </div>
  );
}
