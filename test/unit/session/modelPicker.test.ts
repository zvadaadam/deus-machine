import { createElement, type PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { HarnessModels } from "@shared/models";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageInput } from "@/features/session/ui/MessageInput";
import { ModelPicker } from "@/features/session/ui/ModelPicker";
import { queryKeys } from "@/shared/api/queryKeys";
import { useChatModel } from "@/shared/hooks/useModelLists";

vi.mock("@/shared/hooks/useGateways", () => ({ useGateways: () => ({ data: [] }) }));
vi.mock("@/assets/agents/cliproxyapi.svg?react", () => ({ default: () => null }));
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
    expect(html.replace(menu!, "").includes(`>${message}</p>`)).toBe(inline);
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
    createElement(
      TooltipProvider,
      null,
      createElement(ModelPicker, {
        agentHarness: "gemini",
        model: "gemini:remembered",
        lists: [
          { harness: "gemini", source: "catalog", models: [], error: "Sign in to see models." },
        ],
        thinkingLevel: "high",
        hasMessages: true,
        onThinkingLevelChange: () => {},
      })
    )
  );
  expect(html).toContain("Sign in to see models.");
  expect(html).toContain("Open AI Providers");
  expect(html).toContain("Thinking");
  expect(html).not.toContain('aria-label="Thinking effort"');
  expect(html).not.toContain("has no thinking control.");
});

it("offers the harness's thinking levels for a chat on an unlisted model", () => {
  const harness = "codex-app-server";
  const lists: HarnessModels[] = [
    {
      harness,
      source: "live",
      models: [{ harness, id: "current", label: "Current", thinking: { levels: ["low", "high"] } }],
    },
  ];
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(ModelPicker, {
        agentHarness: harness,
        model: "codex-app-server:older-model",
        lists,
        thinkingLevel: "high",
        hasMessages: true,
        onThinkingLevelChange: () => {},
      })
    )
  );
  expect(html).toContain("older-model");
  const controls = html.split('aria-label="Thinking effort"')[1]?.split("</div>")[0];
  expect(controls).toContain(">Low</span>");
  expect(controls).toContain(">High</span>");
  expect(html).not.toContain("has no thinking control.");
});

it("opens a gateway chat on its source and agent, and leaves an unknown effort off its chip", () => {
  const gateway = {
    ref: "cliproxyapi",
    preset: "cliproxyapi" as const,
    formats: ["responses" as const],
    revision: "gen",
    baseUrl: "http://localhost",
    models: [
      {
        id: "internal-astra",
        provider: "openai",
        label: "GPT 6.2 Astra",
        runner: "codex-app-server" as const,
      },
      { id: "image", provider: "openai", excluded: "hidden" as const },
      { id: "mystery", provider: "", label: "Mystery" },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(ModelPicker, {
        agentHarness: "codex-app-server",
        model: "gateway:codex-app-server:gen:internal-astra",
        lists: [],
        gateways: [gateway],
        thinkingLevel: "high",
        hasMessages: true,
        onThinkingLevelChange: vi.fn(),
      })
    )
  );
  expect(html).toContain("Select model, currently GPT 6.2 Astra");
  expect(html).toContain("Your subscriptions");
  expect(html).toContain("CLIProxyAPI · Codex");
  expect(html).not.toContain("via Codex");
  expect(html).not.toContain(" · Proxy");
  expect(html).not.toContain("Chosen by proxy");
  expect(html).not.toContain("Model details");
  expect(html).toContain("Search models");
  expect(html).not.toContain('aria-label="Thinking effort"');
  expect(html).not.toContain(">Mystery<");
});

it("opens the matching gateway on a shared model id and presents its only runner as a label", () => {
  const catalog = {
    baseUrl: "https://openrouter.ai/api",
    formats: ["responses" as const],
    models: [
      { id: "one", label: "Shared", provider: "openai", runner: "codex-app-server" as const },
    ],
  };
  const gateways = [
    { ...catalog, ref: "router", preset: "openrouter" as const, revision: "rev-a" },
    { ...catalog, ref: "office", preset: "custom" as const, revision: "rev-b" },
  ];
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(ModelPicker, {
        model: "gateway:codex-app-server:rev-a:one",
        agentHarness: "codex-app-server",
        lists: [],
        gateways,
        thinkingLevel: "high",
        hasMessages: true,
        onThinkingLevelChange: vi.fn(),
      })
    )
  );
  expect(html).toContain("OpenRouter · Codex");
  expect(html).toContain('aria-label="OpenRouter"');
  expect(html).toContain('aria-label="Custom');
  expect(html).toContain('aria-label="Agent"');
  expect(html).not.toContain('aria-label="Agents"');
});

it("lets a person reach a source beyond the rail and see the search field's keyboard focus", () => {
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(ModelPicker, {
        model: "gateway:codex-app-server:rev:hello",
        agentHarness: "codex-app-server",
        lists: [],
        thinkingLevel: "low",
        onThinkingLevelChange: vi.fn(),
        gateways: [
          {
            ref: "gateway",
            revision: "rev",
            preset: "custom",
            baseUrl: "http://localhost",
            formats: ["responses", "messages"],
            models: [{ id: "hello", label: "Hello", provider: "" }],
          },
        ],
      })
    )
  );
  expect(html.match(/<[^>]+aria-label="Account sources"[^>]*>/)?.[0]).toContain("overflow-y-auto");
  expect(html).toContain("Claude Code");
  expect(html).toContain("Codex");
  expect(html.match(/<input\b[^>]*aria-label="Search models"[^>]*>/)?.[0]).toContain(
    "focus-visible:"
  );
  expect(html).not.toContain("focus-visible:ring-0");
});
