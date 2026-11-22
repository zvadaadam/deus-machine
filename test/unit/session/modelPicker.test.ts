import { createElement, type PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ModelPicker } from "@/features/session/ui/ModelPicker";

vi.mock("@/assets/agents", () => ({ getAgentLogo: () => null }));
vi.mock("@/components/ui/dropdown-menu", () => {
  const contents = ({ children }: PropsWithChildren) => children;
  return {
    DropdownMenu: contents,
    DropdownMenuTrigger: contents,
    DropdownMenuContent: contents,
    DropdownMenuLabel: contents,
    DropdownMenuItem: contents,
    DropdownMenuGlide: () => null,
  };
});

it("keeps the chat's Thinking column beside an empty model list", () => {
  const html = renderToStaticMarkup(
    createElement(ModelPicker, {
      agentHarness: "gemini",
      model: "gemini:remembered",
      lists: [
        { harness: "gemini", source: "catalog", models: [], error: "Sign in to see models." },
      ],
      thinkingLevel: "high",
      thinkingLevels: [],
      hasMessages: true,
      onThinkingLevelChange: () => {},
    })
  );
  expect(html).toContain("Sign in to see models.");
  expect(html).toContain("Open AI Settings");
  expect(html).toContain("Thinking");
  expect(html).toContain("has no thinking control.");
});
