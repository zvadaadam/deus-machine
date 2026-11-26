import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Automation } from "@shared/types";
import { AutomationDetail } from "@/features/automations/ui/AutomationDetail";
import { automationKeys } from "@/features/automations/api/automations.queries";

vi.mock("@/shared/hooks/useQuerySubscription", () => ({ useQuerySubscription: vi.fn() }));
vi.mock("@/features/session/lib/openChat", () => ({ openChat: vi.fn() }));

it("offers one manual run from a paused automation's empty history", () => {
  const automation: Automation = {
    id: "nightly",
    name: "Nightly",
    prompt: "Summarize changes",
    status: "paused",
    cron: "0 9 * * *",
    timezone: "UTC",
    environment: "repo",
    session_policy: "fresh_session",
    organization_id: null,
    repository_id: null,
    workspace_id: null,
    model: null,
    thinking_level: null,
    paused_reason: null,
    next_run_at: null,
    last_run_at: null,
    consecutive_failures: 0,
    created_by: "user",
    synced_at: "",
    updated_at: "",
  };
  const client = new QueryClient();
  client.setQueryData(automationKeys.runs(automation.id), []);
  const panel = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AutomationDetail, { automation, onBack: vi.fn(), onEdit: vi.fn() })
    )
  );
  expect(panel).toMatch(/<button\b(?:(?!disabled)[^>])*>Run now<\/button>/);
  expect(panel).toContain("Choose Run now to run once while the schedule is paused.");
  client.clear();
});
