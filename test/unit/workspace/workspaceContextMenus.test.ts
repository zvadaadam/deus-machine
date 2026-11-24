import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { it, expect, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceItem } from "@/features/sidebar/ui/WorkspaceItem";
import { SessionTab } from "@/features/session/ui/tabs/SessionTab";
import type { ChatTab } from "@/features/session/ui/tabs/types";
import type { Workspace } from "@shared/types/workspace";

const direct = vi.hoisted(() => vi.fn());
vi.mock("@/assets/agents", () => ({ getAgentLogo: () => null }));
vi.mock("@/shared/config/webDirectMode", async (original) => ({
  ...(await original<typeof import("@/shared/config/webDirectMode")>()),
  isCloudDirectWebMode: direct,
}));
vi.mock("@/features/automations", () => ({ useAutomationForWorkspace: () => undefined }));
// Render the open menu. Browser coverage checks its trigger, focus, clipboard and positioning.
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ trigger, children }: { trigger: ReactNode; children: ReactNode }) =>
    createElement(Fragment, null, trigger, children),
  ContextMenuItem: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  ContextMenuSub: ({ label, children }: { label: ReactNode; children: ReactNode }) =>
    createElement(Fragment, null, label, children),
}));

it.each([
  [false, true, "ready"],
  [true, true, "ready"],
  [true, false, "initializing"],
  [false, false, "initializing"],
  [false, false, "error"],
] as const)(
  "offers links and available actions on web-direct %s with a chat %s in state %s",
  (webDirect, hasChat, state) => {
    direct.mockReturnValue(webDirect);
    const workspace = {
      id: "workspace",
      title: "Review",
      slug: "review",
      state,
      kind: webDirect ? "cloud" : "worktree",
      setup_status: "completed",
      status: "in-progress",
      updated_at: "2026-11-01T13:00:00Z",
      current_session_id: hasChat ? "session" : null,
      start_recoverable: state === "error",
    } as Workspace;
    const base = {
      id: "tab",
      agentHarness: "codex-app-server",
      label: "Review",
      hasStarted: false,
    };
    const tab: ChatTab = hasChat
      ? { ...base, kind: "session", sessionId: "session" }
      : { ...base, kind: "pending" };
    const client = new QueryClient();
    try {
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            TooltipProvider,
            null,
            createElement(WorkspaceItem, {
              workspace,
              isActive: false,
              onClick: vi.fn(),
              onArchive: webDirect ? undefined : vi.fn(),
              onStatusChange: webDirect ? undefined : vi.fn(),
            }),
            createElement(SessionTab, {
              workspaceId: workspace.id,
              tab,
              isActive: false,
              canClose: false,
              isWorking: false,
              isUnread: false,
              onSelect: vi.fn(),
              onKeyDown: vi.fn(),
            })
          )
        )
      );
      expect(html.match(/Copy link/g) ?? []).toHaveLength(hasChat ? 2 : 1);
      expect(html.includes(">Open workspace<")).toBe(true);
      expect(html.includes(">Open chat<")).toBe(hasChat);
      expect(html.includes("Set status")).toBe(!webDirect);
      expect(html.includes(">Archive workspace<")).toBe(!webDirect && state === "ready");
    } finally {
      client.clear();
    }
  }
);
