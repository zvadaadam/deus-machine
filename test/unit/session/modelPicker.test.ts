import { createElement, type PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageInput } from "@/features/session/ui/MessageInput";
import { ModelPicker } from "@/features/session/ui/ModelPicker";
import { queryKeys } from "@/shared/api/queryKeys";
import { useChatModel } from "@/shared/hooks/useModelLists";

vi.mock("@/assets/agents", () => ({ getAgentLogo: () => null }));
vi.mock("@/features/session/hooks/useCloudSlashItems", () => ({ useCloudSlashItems: () => [] }));
vi.mock("@/components/ui/dropdown-menu", () => {
  const contents = ({ children }: PropsWithChildren) => children;
  return {
    DropdownMenu: contents,
    DropdownMenuTrigger: contents,
    DropdownMenuContent: ({ children }: PropsWithChildren) =>
      createElement("section", null, children),
    DropdownMenuLabel: contents,
    DropdownMenuItem: contents,
    DropdownMenuGlide: () => null,
  };
});

it("shows the same model read in the picker and on Send, and offers Settings only for an empty answer", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const queryKey = [...queryKeys.settings.agentModels, null];
  function Composer({ sendDisabledReason }: { sendDisabledReason?: string }) {
    const selection = useChatModel({ cloud: false, harness: "gemini" });
    return createElement(MessageInput, {
      sessionId: "cold",
      sending: false,
      sendDisabledReason,
      selection,
      onSend: () => true,
    });
  }
  const render = (sendDisabledReason?: string) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(Composer, { sendDisabledReason }))
      )
    );
  function expectNotice(message: string, offersSettings: boolean, inline = true) {
    const html = render();
    const menu = html.match(/<section>.*?<\/section>/s)?.[0];
    expect(menu).toContain(message);
    expect(menu).toContain("Thinking");
    expect(menu).not.toContain("has no thinking control.");
    expect(menu?.includes("Open AI Providers")).toBe(offersSettings);
    const send = html.match(/<button[^>]*aria-label="Send message"[^>]*>/)?.[0];
    expect(send).toContain('disabled=""');
    expect(send).toContain(`title="${message}"`);
    expect(html.includes(`>${message}</p>`)).toBe(inline);
  }

  expectNotice("Reading models…", false, false);
  const waiting = "You can send this draft when the chat opens.";
  expect(render(waiting)).toContain(`>${waiting}</p>`);
  await expect(
    client.fetchQuery({
      queryKey,
      queryFn: async () => {
        throw new Error("Engine disconnected");
      },
      retry: false,
    })
  ).rejects.toThrow("Engine disconnected");
  expectNotice("Could not read the model list.", false);
  client.setQueryData(queryKey, {
    lists: [{ harness: "gemini", source: "catalog", models: [], error: "Sign in to see models." }],
  });
  expectNotice("Sign in to see models.", true);
  client.setQueryData(queryKey, {
    lists: [
      {
        harness: "gemini",
        source: "live",
        models: [
          {
            harness: "gemini",
            id: "gemini-4-neon",
            label: "Gemini 4 Neon",
            thinking: { levels: [] },
          },
        ],
      },
    ],
  });
  const ready = render();
  expect(ready).toContain("Gemini 4 Neon has no thinking control.");
  expect(ready).not.toContain("Open AI Providers");
  expect(ready).toContain('title="Send message (Enter)"');
  client.clear();
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
  expect(html).toContain("Open AI Providers");
  expect(html).toContain("Thinking");
  expect(html).not.toContain("has no thinking control.");
});

it("keeps a remembered model in the picker without offering another model's thinking levels", () => {
  const html = renderToStaticMarkup(
    createElement(ModelPicker, {
      agentHarness: "gemini",
      model: "gemini:remembered",
      lists: [
        {
          harness: "gemini",
          source: "live",
          models: [
            { harness: "gemini", id: "other", label: "Other", thinking: { levels: ["high"] } },
          ],
        },
      ],
      thinkingLevel: "high",
      thinkingLevels: ["high"],
      hasMessages: true,
      onThinkingLevelChange: () => {},
    })
  );
  expect(html).toContain("remembered");
  expect(html).toContain("Thinking");
  expect(html).not.toContain('aria-label="Thinking effort"');
  expect(html).not.toContain("has no thinking control.");
});
