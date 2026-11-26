import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GatewayCatalog } from "@shared/gateways";

const state = vi.hoisted(() => ({
  local: undefined as unknown,
  cloud: undefined as unknown,
  gateway: undefined as GatewayCatalog | undefined,
  readingGateways: false,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.local }) }));
vi.mock("@/shared/hooks/useGateways", () => ({
  useGateways: () => ({
    data: state.readingGateways ? undefined : state.gateway ? [state.gateway] : [],
  }),
}));
vi.mock("@/shared/hooks/useCloudModels", () => ({ useCloudModels: () => ({ data: state.cloud }) }));
vi.mock("@/platform/ws", () => ({ call: vi.fn() }));
vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: () => false }));
vi.mock("@/features/settings/api", () => ({ useDefaultThinkingLevel: () => "high" }));

const { useChatModel } = await import("@/shared/hooks/useModelLists");
const { modelPickerView } = await import("@/shared/agents/picker");
const { useNewChatSelection } =
  await import("@/features/repository/ui/composer/useNewChatSelection");
const { setStoredModel } = await import("@/features/session/lib/modelPreference");

describe("whether a chat's model list is live", () => {
  it("is per harness for a cloud chat: a Claude-only answer leaves Codex provisional", () => {
    state.cloud = { lists: [{ harness: "claude-code", source: "catalog", models: [] }] };
    const { live } = useChatModel({ cloud: true });
    // The platform's own row is authoritative, whatever its source.
    expect(live("claude-code")).toBe(true);
    expect(live("codex-app-server")).toBe(false);
  });

  it("is a local harness's live row only", () => {
    state.local = {
      lists: [
        { harness: "claude-code", source: "live", models: [] },
        { harness: "codex-app-server", source: "catalog", models: [] },
      ],
    };
    const { live } = useChatModel({ cloud: false });
    expect(live("claude-code")).toBe(true);
    expect(live("codex-app-server")).toBe(false);
    state.local = {};
    expect(useChatModel({ cloud: false }).live("claude-code")).toBe(false);
  });
});

describe("the harnesses a picker offers", () => {
  it.each([false, true])(
    "shows an empty tab for a harness omitted from a successful model read (cloud: %s)",
    (cloud) => {
      state.local = state.cloud = {
        lists: [{ harness: "claude-code", source: "catalog", models: [] }],
      };
      const { lists, unavailable } = useChatModel({ cloud, harness: "codex-app-server" });
      expect(unavailable).toBe("No models available.");
      expect(modelPickerView(lists, undefined).groups).toContainEqual(
        expect.objectContaining({
          source: "subscriptions",
          agentHarness: "codex-app-server",
          options: [],
          empty: { message: unavailable, openSettings: true },
        })
      );
    }
  );

  it("shows the reason from the empty harness even when a chat remembers one of its models", () => {
    const error = "The CLI is not installed yet.";
    state.local = { lists: [{ harness: "gemini", source: "catalog", models: [], error }] };
    const { lists } = useChatModel({ cloud: false });
    expect(lists).toContainEqual(
      expect.objectContaining({ harness: "gemini", source: "catalog", error })
    );
    for (const model of ["claude-code:opus", "gemini:previous"]) {
      expect(modelPickerView(lists, model).groups).toContainEqual(
        expect.objectContaining({ label: "Gemini", empty: { message: error, openSettings: true } })
      );
    }
  });

  it("derives the model on a catalogless harness when its list arrives", () => {
    const harness = "gemini" as const;
    const error = "Sign in to the agent.";
    state.local = { lists: [{ harness, models: [], source: "catalog", error }] };
    const chat = { cloud: false, harness };
    expect(useChatModel(chat)).toMatchObject({
      model: undefined,
      picked: undefined,
      unavailable: error,
    });
    const row = {
      harness,
      id: "gemini-4-neon",
      label: "Gemini 4 Neon",
      isDefault: true,
      thinking: { levels: ["low"] },
    };
    state.local = { lists: [{ harness, models: [row], source: "live" }] };
    expect(useChatModel(chat)).toMatchObject({
      model: "gemini:gemini-4-neon",
      picked: undefined,
      unavailable: undefined,
    });
  });

  it.each([
    [true, "Reading gateways…"],
    [false, "This gateway model is no longer available."],
  ] as const)("keeps Home's unavailable gateway pick (list pending %s)", (pending, unavailable) => {
    const picked = "gateway:codex-app-server:gone:work:one";
    state.readingGateways = pending;
    try {
      const choice = useChatModel({ cloud: false, picked });
      expect(choice).toMatchObject({
        agentHarness: "codex-app-server",
        picked,
        model: picked,
        unavailable,
      });
      expect(useChatModel({ cloud: true, picked }).model).not.toBe(picked);
    } finally {
      state.readingGateways = false;
    }
  });

  it("Home resolves its saved local pick and the cloud default without changing the preference", () => {
    state.cloud = state.local = undefined;
    const storage = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key), setItem });
    const HomeModel = ({ location }: { location: "local" | "cloud" }) =>
      useNewChatSelection(location).model;
    try {
      const picked = "gemini:gemini-4-neon";
      setStoredModel(picked);
      expect(renderToStaticMarkup(createElement(HomeModel, { location: "local" }))).toBe(picked);
      expect(renderToStaticMarkup(createElement(HomeModel, { location: "cloud" }))).toBe(
        "claude-code:opus"
      );
      expect(renderToStaticMarkup(createElement(HomeModel, { location: "local" }))).toBe(picked);
      expect(setItem).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["answer", "catalog"])(
    "keeps a local-only harness off the cloud picker with the %s",
    (source) => {
      const lists = [
        { harness: "claude-code", source: "catalog", models: [] },
        { harness: "codex-app-server", source: "live", models: [] },
        { harness: "gemini", source: "live", models: [] },
      ];
      state.local = state.cloud = source === "answer" ? { lists } : undefined;
      const local = useChatModel({ cloud: false });
      const cloud = useChatModel({ cloud: true });
      const current = "gemini:sample";
      expect(modelPickerView(local.lists, current).selected?.value).toBe(current);
      const view = modelPickerView(cloud.lists, current);
      expect(view.groups.map((group) => group.label)).toEqual(["Claude Code", "Codex"]);
      expect(view.selected).toBeUndefined();
      expect(cloud.live("gemini")).toBe(false);
    }
  );
});

it("offers the same raw id over distinct local routes, and keeps the raw owner separate from its fallback label", () => {
  const generation = crypto.randomUUID();
  const harness = "codex-app-server";
  const id = "test:model";
  const native = state.local;
  state.local = {
    lists: [
      {
        harness,
        source: "live",
        models: [{ harness, id, label: "Native model", thinking: { levels: ["medium", "high"] } }],
      },
    ],
  };
  state.gateway = {
    ref: "fixture-gateway",
    preset: "cliproxyapi",
    formats: ["messages", "responses"],
    address: "http://localhost",
    generation,
    models: [
      {
        id,
        label: id,
        provider: "",
        runner: harness,
        thinking: { levels: ["medium", "high"] },
      },
    ],
  };
  try {
    const local = useChatModel({
      cloud: false,
      harness,
      gatewayGeneration: generation,
      turns: [{ turnId: "one", execution: { harness, model: id } }],
    });
    const view = modelPickerView(local.lists, local.model, "", local.gateways);
    expect(view.selected).toMatchObject({
      label: "test:model",
      gatewayGeneration: generation,
    });
    expect(local.gatewayModel?.provider).toBe("");
    const routes = view.groups.flatMap((group) =>
      group.options
        .filter((option) => option.id === id)
        .map((option) => [group.source, group.agentHarness, option.value])
    );
    expect(routes).toEqual([
      ["subscriptions", harness, `${harness}:${id}`],
      ["fixture-gateway", harness, `gateway:${harness}:${generation}:${id}`],
    ]);
    expect(local.thinkingLevels).toEqual(["medium", "high"]);
    expect(useChatModel({ cloud: true }).gateways).toBeUndefined();
  } finally {
    state.local = native;
    state.gateway = undefined;
  }
});
