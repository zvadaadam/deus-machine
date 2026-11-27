import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceItem } from "@/features/sidebar/ui/WorkspaceItem";
import { useWorkingDuration } from "@/shared/hooks";
import type { Workspace } from "@shared/types/workspace";

vi.mock("@/features/automations", () => ({ useAutomationForWorkspace: () => undefined }));
vi.mock("@/shared/hooks", async (original) => ({
  ...(await original<typeof import("@/shared/hooks")>()),
  useWorkingDuration: vi.fn(() => ({ duration: 5_000 })),
}));

const early = "2026-11-24T00:01:00Z";
const late = "2026-11-24T00:02:00Z";
function render(workspace: Partial<Workspace>) {
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          TooltipProvider,
          null,
          createElement(WorkspaceItem, {
            workspace: {
              id: "w",
              title: "Orbit",
              slug: "orbit",
              kind: "worktree",
              state: "ready",
              setup_status: "completed",
              current_session_id: "current",
              ...workspace,
            } as Workspace,
            isActive: false,
            onClick: vi.fn(),
          })
        )
      )
    );
  } finally {
    client.clear();
  }
}

it.each(["completed", "failed"] as const)(
  "shows the working grid and duration cleanly with setup %s",
  (setup_status) => {
    for (const [current, sibling] of [
      ["working", "idle"],
      ["idle", "working"],
      ["working", "working"],
    ] as const) {
      const html = render({
        setup_status,
        session_status: current,
        latest_message_sent_at: late,
        chats: [
          { id: "current", status: current, last_user_message_at: late, error_category: null },
          { id: "sibling", status: sibling, last_user_message_at: early, error_category: null },
        ],
      });
      expect(html).toMatch(/<canvas[^>]*aria-hidden="true"/);
      expect(html).toContain('aria-label="Workspace Orbit, working"');
      expect(html).toContain("5s");
      expect(html).not.toContain('title="Setup failed"');
      expect(useWorkingDuration).toHaveBeenLastCalledWith({
        status: "working",
        latestMessageSentAt: sibling === "working" ? early : late,
      });
    }
  }
);

it("shows a background question's dot beside the working grid without sidebar setup clutter", () => {
  const html = render({
    setup_status: "failed",
    session_status: "working",
    chats: [
      { id: "current", status: "working", last_user_message_at: early, error_category: null },
      { id: "sibling", status: "needs_response", last_user_message_at: late, error_category: null },
    ],
  });
  expect(html).toContain('aria-label="Workspace Orbit, working, waiting for your answer"');
  expect(html).toMatch(/<canvas[^>]*aria-hidden="true"/);
  expect(html).toContain("bg-accent-gold");
  expect(html).not.toContain('title="Setup failed"');
});
