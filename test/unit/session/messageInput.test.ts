import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { MessageInput } from "@/features/session/ui/MessageInput";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionStatus } from "@shared/enums";

// Render the actual composer and toolbar; unrelated provider pickers don't
// need a live settings connection to verify whether a user can stop a turn.
vi.mock("@/features/session/ui/ModelPicker", () => ({ ModelPicker: () => null }));
// A cloud chat's `/` menu reads Customize's live state: none unless a test sets some.
const cloudSkills = vi.hoisted(() => ({
  items: [] as { name: string; description: string; kind: "skill" }[],
}));
vi.mock("@/features/session/hooks/useCloudSlashItems", () => ({
  useCloudSlashItems: () => cloudSkills.items,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useLayoutEffect: react.useEffect };
});

describe("composer Stop availability", () => {
  it.each([
    ["working", true],
    ["needs_response", true],
    ["needs_plan_response", true],
    ["idle", false],
    ["error", false],
  ] satisfies [SessionStatus, boolean][])("%s shows Stop: %s", (sessionStatus, canStop) => {
    const client = new QueryClient();
    try {
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            TooltipProvider,
            null,
            createElement(MessageInput, {
              sessionId: `stop-${sessionStatus}`,
              sending: false,
              sessionStatus,
              onStop: vi.fn(),
              onSend: vi.fn(),
            })
          )
        )
      );
      expect(html.includes('title="Stop execution"')).toBe(canStop);
    } finally {
      client.clear();
    }
  });
});

describe("the composer's placeholder", () => {
  const placeholder = (workspaceKind: "worktree" | "cloud") => {
    const client = new QueryClient();
    try {
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            TooltipProvider,
            null,
            createElement(MessageInput, {
              sessionId: `placeholder-${workspaceKind}`,
              workspaceKind,
              workspacePath: workspaceKind === "cloud" ? null : "/Users/me/rocket",
              sending: false,
              sessionStatus: "idle",
              onStop: vi.fn(),
              onSend: vi.fn(),
            })
          )
        )
      );
      return /placeholder="([^"]*)"/.exec(html)?.[1];
    } finally {
      client.clear();
    }
  };

  it("names / skills in a cloud chat only when its menu has something", () => {
    cloudSkills.items = [];
    expect(placeholder("cloud")).toBe("Ask a follow-up… (@ files)");
    cloudSkills.items = [{ name: "review", description: "Review", kind: "skill" }];
    expect(placeholder("cloud")).toBe("Ask a follow-up… (@ files, / skills)");
    cloudSkills.items = [];
  });

  it("names / skills on this computer", () => {
    expect(placeholder("worktree")).toBe("Ask a follow-up… (@ files, / skills)");
  });
});
