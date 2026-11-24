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
}));

it.each([
  [false, true, true],
  [true, true, false],
  [false, false, false],
])(
  "offers Copy link on the row and tab (web-direct %s, has chat %s)",
  (webDirect, hasChat, offered) => {
    direct.mockReturnValue(webDirect);
    const workspace = {
      id: "workspace",
      title: "Review",
      slug: "review",
      state: "ready",
      kind: "worktree",
      setup_status: "completed",
      status: "in-progress",
      updated_at: "2026-11-01T13:00:00Z",
      current_session_id: hasChat ? "session" : null,
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
            createElement(WorkspaceItem, { workspace, isActive: false, onClick: vi.fn() }),
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
      expect(html.match(/Copy link/g) ?? []).toHaveLength(offered ? 2 : 0);
    } finally {
      client.clear();
    }
  }
);
