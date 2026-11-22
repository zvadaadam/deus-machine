import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/harnesses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/harnesses")>();
  return {
    ...actual,
    LOCAL_HARNESSES: [...actual.LOCAL_HARNESSES, "scripted"],
    HARNESSES: {
      ...actual.HARNESSES,
      scripted: { ...actual.HARNESSES["claude-code"], label: "Local fixture", cloudProvider: null },
    },
  };
});

const state = vi.hoisted(() => ({
  local: undefined as unknown,
  cloud: undefined as unknown,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.local }) }));
vi.mock("@/shared/hooks/useCloudModels", () => ({ useCloudModels: () => ({ data: state.cloud }) }));
vi.mock("@/platform/ws", () => ({ call: vi.fn() }));
vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: () => false }));
vi.mock("@/features/settings/api", () => ({ useDefaultThinkingLevel: () => "high" }));

const { useChatModel, useModelListsState } = await import("@/shared/hooks/useModelLists");
const { AgentHarnessSchema } = await import("@shared/enums");
const { modelPickerView } = await import("@/shared/agents/picker");
const { useNewChatSelection } =
  await import("@/features/repository/ui/composer/useNewChatSelection");
const { setStoredModel } = await import("@/features/session/lib/modelPreference");

describe("whether a chat's model list is live", () => {
  it("is per harness for a cloud chat: a Claude-only answer leaves Codex provisional", () => {
    state.cloud = { lists: [{ harness: "claude-code", source: "catalog", models: [] }] };
    const { live } = useModelListsState({ cloud: true });
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
    const { live } = useModelListsState({ cloud: false });
    expect(live("claude-code")).toBe(true);
    expect(live("codex-app-server")).toBe(false);
    state.local = {};
    expect(useModelListsState({ cloud: false }).live("claude-code")).toBe(false);
  });
});

describe("the harnesses a picker offers", () => {
  it("shows the reason from the empty harness even when a chat remembers one of its models", () => {
    const error = "The fixture CLI is not installed yet.";
    state.local = { lists: [{ harness: "scripted", source: "catalog", models: [], error }] };
    const { lists } = useModelListsState({ cloud: false });
    expect(lists.find((list) => list.harness === "scripted")).toMatchObject({
      source: "catalog",
      error,
    });
    for (const model of ["claude-code:opus", "scripted:previous"]) {
      const group = modelPickerView(lists, model).groups.find(
        (group) => group.label === "Local fixture"
      );
      expect(group?.emptyReason).toBe(error);
    }
  });

  it("derives the model on a catalogless harness when its list arrives", () => {
    const harness = AgentHarnessSchema.parse("scripted");
    const error = "Sign in to the fixture agent.";
    state.local = { lists: [{ harness, models: [], source: "catalog", error }] };
    const chat = { cloud: false, harness };
    expect(useChatModel(chat)).toMatchObject({
      model: undefined,
      picked: undefined,
      unavailable: error,
    });
    const row = {
      harness,
      id: "account",
      label: "Account",
      isDefault: true,
      thinking: { levels: ["low"] },
    };
    state.local = { lists: [{ harness, models: [row], source: "live" }] };
    expect(useChatModel(chat)).toMatchObject({
      model: "scripted:account",
      picked: undefined,
      unavailable: undefined,
    });
  });

  it("Home shows and sends the cloud default and keeps the saved pick for a local start", () => {
    state.cloud = state.local = undefined;
    const storage = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key), setItem });
    const HomeModel = ({ location }: { location: "local" | "cloud" }) =>
      useNewChatSelection(location).model;
    try {
      const picked = "scripted:my-local-model";
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
        { harness: "scripted", source: "live", models: [] },
      ];
      state.local = state.cloud = source === "answer" ? { lists } : undefined;
      const local = useModelListsState({ cloud: false });
      const cloud = useModelListsState({ cloud: true });
      const current = "scripted:sample";
      expect(modelPickerView(local.lists, current).selected?.value).toBe(current);
      const view = modelPickerView(cloud.lists, current);
      expect(view.groups.map((group) => group.label)).toEqual(["Claude Code", "Codex"]);
      expect(view.selected).toBeUndefined();
      expect(cloud.live("scripted")).toBe(false);
    }
  );
});
