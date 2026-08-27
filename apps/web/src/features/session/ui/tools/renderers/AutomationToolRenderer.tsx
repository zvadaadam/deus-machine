/**
 * automation_update — the agent created/updated/listed automations (design
 * board 46d). Create/update render an automation card: name · humanized
 * schedule · repo · status, with a View action into the Automations view.
 * List renders compact rows; delete a one-liner.
 */

import { ClockFading } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { uiActions } from "@/shared/stores/uiStore";
import type { Automation } from "@/shared/types";
import { humanizeSchedule } from "@/features/automations/lib/schedule";
import { extractText, ICON_CLS, OutputBlock } from "./shared";
import type { ToolRendererProps } from "../../chat-types";

const MODE_LABELS: Record<string, string> = {
  create: "Create automation",
  update: "Update automation",
  delete: "Delete automation",
  view: "View automation",
  list: "List automations",
};

interface AutomationToolPayload {
  automation?: Automation;
  automations?: Automation[];
  deleted?: boolean;
}

function parsePayload(output: string): AutomationToolPayload | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed && typeof parsed === "object") return parsed as AutomationToolPayload;
  } catch {
    // Error text, not JSON — the caller falls back to plain output.
  }
  return null;
}

function automationMeta(automation: Automation): string {
  return [humanizeSchedule(automation.cron), automation.repo_name, "Deus Cloud"]
    .filter(Boolean)
    .join(" · ");
}

function AutomationCard({ automation }: { automation: Automation }) {
  return (
    <div className="border-border-subtle bg-bg-elevated mx-2 mb-2 flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <ClockFading className="text-text-primary h-3.5 w-3.5 shrink-0" />
        <span className="text-text-primary min-w-0 truncate text-sm font-medium">
          {automation.name}
        </span>
        <span className="bg-bg-selection text-text-secondary text-2xs flex h-5 shrink-0 items-center rounded-full px-2 font-medium">
          {automation.status === "active" ? "Active" : "Paused"}
        </span>
      </div>
      <span className="text-text-tertiary text-xs">{automationMeta(automation)}</span>
      <div>
        <button
          type="button"
          onClick={() => uiActions.openAutomations(automation.id)}
          className="border-border-default bg-bg-base text-text-secondary hover:text-text-primary flex h-7 items-center rounded-md border px-2.5 text-xs font-medium transition-colors duration-150"
        >
          View
        </button>
      </div>
    </div>
  );
}

export function AutomationToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const input = (toolUse.input ?? {}) as { mode?: string; name?: string };
  const mode = typeof input.mode === "string" ? input.mode : "create";
  const output = toolResult ? extractText(toolResult.content) : "";
  const payload = output ? parsePayload(output) : null;

  const summaryName =
    payload?.automation?.name ??
    (typeof input.name === "string" ? input.name : undefined) ??
    (payload?.automations ? `${payload.automations.length} automations` : undefined);

  return (
    <BaseToolRenderer
      toolName={MODE_LABELS[mode] ?? "Automation"}
      icon={<ClockFading className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        summaryName ? <span className="text-muted-foreground">{summaryName}</span> : null
      }
      renderContent={() => {
        if (payload?.automation) return <AutomationCard automation={payload.automation} />;
        if (payload?.automations) {
          return (
            <div className="mx-2 mb-2 flex flex-col gap-1">
              {payload.automations.length === 0 ? (
                <span className="text-muted-foreground px-1 text-xs italic">No automations</span>
              ) : (
                payload.automations.map((automation) => (
                  <div key={automation.id} className="flex items-baseline gap-2 px-1">
                    <span className="text-text-primary text-xs font-medium">{automation.name}</span>
                    <span className="text-text-muted text-2xs">{automationMeta(automation)}</span>
                  </div>
                ))
              )}
            </div>
          );
        }
        if (payload?.deleted) {
          return <div className="text-muted-foreground px-2 pb-2 text-xs italic">Deleted.</div>;
        }
        return output ? <OutputBlock>{output}</OutputBlock> : null;
      }}
    />
  );
}
