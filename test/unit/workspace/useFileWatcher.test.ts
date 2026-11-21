import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileChanges } from "@shared/api/files";
import { useFileWatcher } from "@/features/file-browser/hooks/useFileWatcher";

const { state, effect, runtime, cache } = vi.hoisted(() => ({
  state: { watched: null as string | null },
  effect: vi.fn<(setup: () => () => void) => void>(),
  runtime: { follow: vi.fn(), isConnected: vi.fn(), onConnectionChange: vi.fn() },
  cache: { invalidateQueries: vi.fn() },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: effect,
  useState: () => [
    state.watched,
    (next: string | null) => {
      state.watched = next;
    },
  ],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => cache }));
vi.mock("@/platform/ws", () => ({ runtimeForQueryClient: () => runtime }));

beforeEach(() => {
  vi.resetAllMocks();
  state.watched = null;
  runtime.isConnected.mockReturnValue(true);
  runtime.follow.mockReturnValue(vi.fn());
  runtime.onConnectionChange.mockReturnValue(vi.fn());
});

function mount() {
  expect(useFileWatcher("w")).toBe(false);
  return effect.mock.calls[0][0]();
}

describe("file watcher polling fallback", () => {
  it("keeps polling when the host refuses the initial watch", () => {
    runtime.follow.mockImplementation((_stream, _scope, _event, options) => {
      options.onRefused(new Error("no local watch"));
      return () => {};
    });
    const stop = mount();
    expect(useFileWatcher("w")).toBe(false);
    stop();
  });

  it("resumes polling if an active watch fails, including after a later connection change", () => {
    const stop = mount();
    expect(useFileWatcher("w")).toBe(true);
    const [stream, scope, , options] = runtime.follow.mock.calls[0];
    expect([stream, scope]).toEqual([fileChanges, { workspaceId: "w" }]);
    options.onRefused(new Error("watch ended"));
    expect(useFileWatcher("w")).toBe(false);
    runtime.onConnectionChange.mock.calls[0][0](true);
    expect(useFileWatcher("w")).toBe(false);
    expect(cache.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["files", "w"] });
    stop();
  });

  it("restores a healthy follower on reconnect and clears its flag when the workspace changes", () => {
    const stop = mount();
    const connected = runtime.onConnectionChange.mock.calls[0][0];
    connected(false);
    expect(useFileWatcher("w")).toBe(false);
    connected(true);
    expect(useFileWatcher("w")).toBe(true);
    expect(useFileWatcher("other")).toBe(false);
    stop();
    expect(useFileWatcher("w")).toBe(false);
    expect(runtime.follow.mock.results[0].value).toHaveBeenCalledOnce();
  });
});
