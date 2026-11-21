import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { useFileWatcher } from "@/features/file-browser/hooks/useFileWatcher";
import { RuntimeClient } from "@/platform/ws/runtime-client";
import { queryKeys } from "@/shared/api/queryKeys";
import { Socket } from "../../../packages/runtime-client/test/socket";

const { state, effect } = vi.hoisted(() => ({
  state: { watched: null as string | null },
  effect: vi.fn<(setup: () => () => void) => void>(),
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
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => runtime.queryClient,
}));
vi.mock("@/platform/ws", () => ({ runtimeForQueryClient: () => runtime }));

let runtime: RuntimeClient;
let socket: Socket;
let stop: (() => void) | undefined;
const page = { visibilityState: "visible" };
beforeEach(async () => {
  state.watched = null;
  page.visibilityState = "visible";
  vi.stubGlobal("document", page);
  socket = new Socket();
  runtime = new RuntimeClient(
    { host: "mac", account: "a", grant: "local" },
    {
      open: () => socket,
      heartbeatIntervalMs: 0,
    }
  );
  const connected = runtime.connect();
  await Promise.resolve();
  socket.open();
  socket.message({ type: "connected" });
  await connected;
});
afterEach(() => {
  stop?.();
  stop = undefined;
  runtime.dispose();
  runtime.queryClient.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  expect(useFileWatcher("w")).toBe(false);
  stop = effect.mock.lastCall![0]();
  const [subscription] = socket.frames("q:subscribe");
  expect(subscription).toMatchObject({ resource: "fileChanges", params: { workspaceId: "w" } });
  return subscription.id;
}

const opening = (id: unknown) =>
  socket.message({ type: "q:event", id, event: "fileChanges", data: null });
const refuse = (id: unknown) =>
  socket.message({ type: "q:error", id, code: "SUBSCRIBE_ERROR", message: "no watch" });

it("keeps polling available until the host opens the watch, including after reconnect", () => {
  const invalidated = vi.spyOn(runtime.queryClient, "invalidateQueries");
  const id = mount();
  expect(useFileWatcher("w")).toBe(false);
  expect(invalidated).not.toHaveBeenCalled();
  opening(id);
  expect(useFileWatcher("w")).toBe(true);
  expect(useFileWatcher("other")).toBe(false);
  socket.message({ type: "server_reconnecting" });
  expect(useFileWatcher("w")).toBe(false);
  invalidated.mockClear();
  socket.message({ type: "authenticated" });
  expect(socket.frames("q:subscribe")).toHaveLength(2);
  expect(invalidated).toHaveBeenCalledWith({ queryKey: ["files", "w"] }); // onReset
  expect(useFileWatcher("w")).toBe(false);
  opening(id);
  expect(useFileWatcher("w")).toBe(true);
  stop!();
  stop = undefined;
  expect(useFileWatcher("w")).toBe(false);
  expect(socket.frames("q:unsubscribe")).toHaveLength(1);
});

it("reads Files again after acquisition when the initial read is still in flight", async () => {
  const observer = new QueryObserver(runtime.queryClient, {
    queryKey: ["files", "w"],
    queryFn: () => runtime.sendRequest("workspaceFiles", { workspaceId: "w" }),
    staleTime: 30_000,
  });
  const unobserve = observer.subscribe(() => {});
  try {
    const [first] = socket.frames("q:request");
    const id = mount();
    opening(id);
    socket.message({ type: "q:subscribed", id });
    socket.message({ type: "q:response", id: first.id, data: ["before-watch"] });
    await vi.waitFor(() => expect(socket.frames("q:request")).toHaveLength(2));
    const [, second] = socket.frames("q:request");
    socket.message({ type: "q:response", id: second.id, data: ["after-watch"] });
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(["after-watch"]));
  } finally {
    unobserve();
  }
});

it.each(["initial", "active"])(
  "polls visible Files and Changes only after an %s watch is refused",
  (when) => {
    vi.useFakeTimers();
    const invalidated = vi.spyOn(runtime.queryClient, "invalidateQueries");
    const id = mount();
    if (when === "active") {
      opening(id);
      expect(useFileWatcher("w")).toBe(true);
    }
    invalidated.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(invalidated).not.toHaveBeenCalled();
    refuse(id);
    expect(useFileWatcher("w")).toBe(false);
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ["files", "w"] });
    invalidated.mockClear();
    vi.advanceTimersByTime(4999);
    expect(invalidated).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ["files", "w"] });
    expect(invalidated).toHaveBeenCalledWith({ queryKey: queryKeys.workspaces.diffFiles("w") });
    page.visibilityState = "hidden";
    invalidated.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(invalidated).not.toHaveBeenCalled();
    page.visibilityState = "visible";
    socket.message({ type: "server_reconnecting" });
    vi.advanceTimersByTime(10_000);
    expect(invalidated).not.toHaveBeenCalled();
    socket.message({ type: "authenticated" });
    expect(useFileWatcher("w")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ["files", "w"] });
    stop!();
    stop = undefined;
    invalidated.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(invalidated).not.toHaveBeenCalled();
  }
);
