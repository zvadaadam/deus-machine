import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  local: undefined as unknown,
  cloud: undefined as unknown,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.local }) }));
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
