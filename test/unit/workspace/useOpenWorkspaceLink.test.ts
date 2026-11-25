import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "@shared/api";
import type { WorkspaceLink } from "@shared/workspace-link";
import { useOpenChatStore } from "@/features/session/lib/openChat";
import { useOpenWorkspaceLink } from "@/features/workspace/hooks/useOpenWorkspaceLink";
import { useWorkspaceStore } from "@/features/workspace/store";

const native = vi.hoisted(() => ({
  take: vi.fn<() => Promise<WorkspaceLink | null>>(),
  on: vi.fn<(_event: string, _wake: () => void) => () => void>(),
}));
const read = vi.hoisted(() => vi.fn());
vi.mock("@/platform", () => ({
  native: { window: { takeWorkspaceLink: native.take }, events: { on: native.on } },
}));
vi.mock("@/platform/ws", () => ({ call: read }));
vi.mock("@/features/workspace/api", () => {
  const data = [{ workspaces: [{ id: "A" }, { id: "B" }] }];
  return { useWorkspacesByRepo: () => ({ data }) };
});
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

function Window() {
  useOpenWorkspaceLink(true);
  return null;
}

let root: Root;
beforeEach(() => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(Object.assign(new EventTarget(), { nodeType: 9 }) as Document);
  native.on.mockReturnValue(() => {});
  useOpenChatStore.setState({ requested: {} });
  useWorkspaceStore.setState({ selectedWorkspaceId: null });
});
afterEach(() => {
  act(() => root.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each(["resolves", "rejects"])("opens only link B when A's earlier lookup %s", async (result) => {
  const a = Promise.withResolvers<{ id: string }[]>();
  const b = Promise.withResolvers<{ id: string }[]>();
  read.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  native.take.mockResolvedValueOnce({ workspaceId: "A", sessionId: "first" });
  await act(async () => root.render(createElement(Window)));
  expect(read).toHaveBeenCalledWith(api.sessions, { workspaceId: "A" });

  await act(async () => {
    native.take.mockResolvedValueOnce({ workspaceId: "B", sessionId: "second" });
    native.on.mock.calls[0][1]();
    // B's IPC reply runs before A settles, in the same turn before React cleans up A.
    if (result === "resolves") a.resolve([{ id: "first" }]);
    else a.reject(new Error("A disconnected"));
  });
  expect(read).toHaveBeenCalledWith(api.sessions, { workspaceId: "B" });
  expect(useWorkspaceStore.getState().selectedWorkspaceId).toBeNull();
  expect(toast.error).not.toHaveBeenCalled();

  await act(async () => b.resolve([{ id: "second" }]));
  expect(useWorkspaceStore.getState().selectedWorkspaceId).toBe("B");
  expect(useOpenChatStore.getState().requested).toEqual({
    B: expect.objectContaining({ sessionId: "second" }),
  });
});
