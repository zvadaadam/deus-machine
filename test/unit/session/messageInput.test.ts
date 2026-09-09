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
