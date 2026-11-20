import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  local: undefined as unknown,
  cloud: undefined as unknown,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.local }) }));
vi.mock("@/shared/hooks/useCloudModels", () => ({ useCloudModels: () => ({ data: state.cloud }) }));
vi.mock("@/platform/ws", () => ({ call: vi.fn() }));
vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: () => false }));

const { useModelListsState } = await import("@/shared/hooks/useModelLists");

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
