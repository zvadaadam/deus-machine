import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { Repository } from "@shared/types/repository";
import { useRepos } from "@/features/repository/api/repository.queries";
import { RuntimeClient } from "@/platform/ws/runtime-client";
import { Socket } from "../../../packages/runtime-client/test/socket";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ws", () => ({ call }));
vi.mock("@/platform/analytics", () => ({ track: vi.fn() }));

it("follows project adds, folder attachments and removals on the repos subscription", async () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(Object.assign(new EventTarget(), { nodeType: 9 }) as Document);
  const socket = new Socket();
  const runtime = new RuntimeClient(
    { host: "mac", account: "a", grant: "local" },
    { open: () => socket, heartbeatIntervalMs: 0 }
  );
  let shown: Repository[] | undefined;
  function Reader() {
    shown = useRepos().data;
    return null;
  }

  try {
    const connected = runtime.connect();
    await Promise.resolve();
    socket.open();
    socket.message({ type: "connected" });
    await connected;
    call.mockResolvedValueOnce([]);
    await act(async () =>
      root.render(
        createElement(QueryClientProvider, { client: runtime.queryClient }, createElement(Reader))
      )
    );
    const subscriptions = socket.frames("q:subscribe");
    expect(subscriptions.map(({ resource }) => resource)).toEqual([api.repos.name]);
    const project = { id: "r", name: "Garden", git_default_branch: "main", root_path: null };
    for (const data of [[project], [{ ...project, root_path: "/repos/Garden" }], []]) {
      await act(async () => {
        socket.message({ type: "q:snapshot", id: subscriptions[0].id, data });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(shown).toEqual(data);
    }
    expect(call).toHaveBeenCalledExactlyOnceWith(api.repos);
  } finally {
    act(() => root.unmount());
    runtime.dispose();
    vi.unstubAllGlobals();
  }
});
