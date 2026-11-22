import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/harnesses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/harnesses")>();
  return {
    ...actual,
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

const { useModelListsState } = await import("@/shared/hooks/useModelLists");
const { modelPickerView } = await import("@/shared/agents/picker");

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
