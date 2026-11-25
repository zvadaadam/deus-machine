import { createElement, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { RuntimeClient, RuntimeError } from "@/platform/ws/runtime-client";
import { Socket } from "../../../packages/runtime-client/test/socket";
import * as endpoints from "@/shared/config/backend.config";
import * as fileUrls from "@/features/file-browser/api/useFileUrl";
import { SessionProvider } from "@/features/session/context";
import { RecordingStopToolRenderer } from "@/features/session/ui/tools/renderers/RecordingToolRenderers";
const { useFileUrl } = fileUrls;

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});
vi.mock("@/platform/ws", async (original) => ({
  ...(await original<typeof import("@/platform/ws")>()),
  call: vi.fn(),
}));
vi.mock("react-dom", async (original) => ({
  ...(await original<typeof import("react-dom")>()),
  createPortal: (children: ReactNode) => children,
}));

const path = "/tmp/recording.mp4";
const first = "https://relay.example/files/first";
const renewed = "https://relay.example/files/renewed";
const cache = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });

const thumb = "/tmp/thumb.png";
let runtime: RuntimeClient;
let socket: Socket;
beforeEach(async () => {
  socket = new Socket();
  runtime = new RuntimeClient(
    { host: "mac", account: "a", grant: "device" },
    {
      queryClient: cache,
      open: () => socket,
      heartbeatIntervalMs: 0,
    }
  );
  const online = runtime.connect();
  await Promise.resolve();
  socket.open();
  socket.message({ type: "authenticated" });
  await online;
  vi.spyOn(runtime, "call").mockImplementation(call);
});
function recording(file = path) {
  let media!: ReturnType<typeof useFileUrl>;
  function Player() {
    media = fileUrls.useFileUrl("recording", file);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: cache }, createElement(Player))
  );
  return media;
}

afterEach(() => {
  runtime.dispose();
  cache.clear();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "recovers a recording at the failed position (paused=%s)",
  async (paused) => {
    vi.mocked(call).mockResolvedValue({ url: renewed });
    const media = recording();
    const player = {
      src: first,
      currentTime: 17,
      paused,
      readyState: 2,
      isConnected: true,
      play: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
    };
    const video = player as unknown as HTMLVideoElement;
    await media.onError(video);
    expect(call).toHaveBeenCalledExactlyOnceWith(api.fileUrl, { kind: "recording", path });
    expect(cache.getQueryData(["fileUrl", "recording", path])).toBe(renewed);
    player.src = renewed;
    player.currentTime = 0;
    media.onLoadedMetadata(video);
    expect(player.currentTime).toBe(17);
    expect(player.play).toHaveBeenCalledTimes(paused ? 0 : 1);

    const notify = vi.spyOn(toast, "error");
    // Metadata and a time update at the failed position do not mean the reload worked.
    media.onProgress(video);
    await media.onError(video);
    expect(call).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  }
);

it("reloads a thumbnail even when its address is unchanged, once until it loads", async () => {
  vi.mocked(call).mockResolvedValue({ url: first });
  const media = recording();
  const writes = vi.fn();
  const image = {
    get src() {
      return first;
    },
    set src(url: string) {
      writes(url);
    },
    isConnected: true,
  } as HTMLImageElement;
  await Promise.all([media.onError(image), media.onError(image)]);
  expect(writes).toHaveBeenCalledExactlyOnceWith(first);
  expect(call).toHaveBeenCalledTimes(1);

  media.onProgress(image);
  await media.onError(image);
  expect(call).toHaveBeenCalledTimes(2);
});

it("reloads the same video address and ignores a failed renewal after the Mac refuses it", async () => {
  vi.mocked(call)
    .mockResolvedValueOnce({ url: first })
    .mockRejectedValue(new Error("Device was revoked"));
  const media = recording();
  const player = {
    src: first,
    currentTime: 17,
    paused: false,
    isConnected: true,
    readyState: 2,
    load: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
  };
  const video = player as unknown as HTMLVideoElement;
  await media.onError(video);
  expect(player.load).toHaveBeenCalledOnce();
  media.onLoadedMetadata(video);
  player.currentTime = 21;
  media.onProgress(video);
  await media.onError(video);
  await media.onError(video);
  expect(call).toHaveBeenCalledTimes(2);
  expect(player.load).toHaveBeenCalledTimes(1);
  expect(recording().failed).toBe(true);
});

it("can renew again when the person starts a recovered, paused video at the same position", async () => {
  vi.mocked(call).mockResolvedValue({ url: first });
  const media = recording();
  const player = {
    src: first,
    currentTime: 17,
    paused: true,
    isConnected: true,
    readyState: 2,
    load: vi.fn(),
    play: vi.fn(),
  };
  const video = player as unknown as HTMLVideoElement;
  await media.onError(video);
  media.onLoadedMetadata(video);
  player.paused = false;
  media.onProgress(video);
  await media.onError(video);
  expect(call).toHaveBeenCalledTimes(2);
});

function renderRecording(open: boolean) {
  // Server rendering has no click or portal target. Start the modal in its clicked state.
  vi.stubGlobal("document", { body: {} });
  vi.mocked(useState).mockImplementationOnce(() => [open, vi.fn()]);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: cache },
      createElement(SessionProvider, {
        sessionId: "s1",
        sessionStatus: "idle",
        subagentMessages: new Map(),
        children: createElement(RecordingStopToolRenderer, {
          toolUse: { type: "tool_use", id: "record", name: "recording_stop", input: {} },
          toolResult: {
            type: "tool_result",
            tool_use_id: "record",
            content: JSON.stringify({ outputPath: path, thumbnailPath: "/tmp/thumb.png" }),
          },
        }),
      })
    )
  );
}

it.each(["refused read", "failed element retry"])(
  "leaves a quiet card and one player message for a %s",
  async (cause) => {
    const refusal = "Unknown operation: fileUrl";
    if (cause === "refused read") {
      for (const file of [path, "/tmp/thumb.png"]) {
        await cache
          .fetchQuery({
            queryKey: ["fileUrl", "recording", file],
            queryFn: () => Promise.reject(new Error(refusal)),
            retry: false,
          })
          .catch(() => {});
      }
    } else {
      // Both elements received a URL, renewed it, then failed again.
      keepMediaState();
      vi.mocked(call).mockResolvedValue({ url: renewed });
      for (const file of [path, thumb]) {
        cache.setQueryData(["fileUrl", "recording", file], renewed);
        const element = { src: renewed, isConnected: true } as HTMLImageElement;
        const media = recording(file);
        await media.onError(element);
        await media.onError(element);
      }
    }
    const card = renderRecording(false);
    expect.soft(card).toContain("bg-muted absolute inset-0");
    expect.soft(card).not.toContain("<img");
    expect.soft(card).not.toContain('role="status"');
    expect.soft(card).not.toContain(refusal);
    const player = renderRecording(true);
    expect(player).toContain('aria-label="Close player"');
    expect
      .soft(player.match(/role="alert"[^>]*>([^<]*)</g))
      .toEqual(['role="alert">This recording can&#x27;t be played right now.<']);
    expect.soft(player).not.toContain(refusal);
  }
);

// Keep the hook's local state across two server-rendered snapshots, as a mounted card does.
function keepMediaState() {
  const states = new Map<string | undefined, unknown>();
  vi.spyOn(fileUrls, "useFileUrl").mockImplementation((...file) => {
    vi.mocked(useState).mockImplementationOnce(() => [
      states.get(file[1]),
      (value: unknown) => states.set(file[1], value),
    ]);
    try {
      return useFileUrl(...file);
    } finally {
      vi.mocked(useState).mockReset();
    }
  });
}

it("keeps a missing local thumbnail as a silent placeholder after its only retry", async () => {
  const local = "http://localhost:42000/api/files/stream?path=missing.png";
  vi.spyOn(endpoints, "resolveBackendEndpoints").mockResolvedValue({
    apiBase: "http://localhost:42000/api",
    wsUrl: "ws://localhost:42000/ws",
  });
  vi.mocked(call).mockResolvedValue({ url: new URL(local).pathname + new URL(local).search });
  const notify = vi.spyOn(toast, "error");
  keepMediaState();
  recording(thumb);
  const initial = await cache
    .getQueryCache()
    .find({ queryKey: ["fileUrl", "recording", thumb] })!
    .fetch();
  expect(initial).toBe(local);
  const media = recording(thumb);
  const image = { src: local, isConnected: true } as HTMLImageElement;
  await media.onError(image);
  await media.onError(image);
  await media.onError(image);
  expect.soft(call).toHaveBeenCalledTimes(2); // Initial lookup and one renewal of the same local path.
  expect.soft(notify).not.toHaveBeenCalled();
  const card = renderRecording(false);
  expect.soft(card).toContain("bg-muted absolute inset-0");
  expect.soft(card).not.toContain("<img");
  expect.soft(card).not.toMatch(/role="(?:status|alert)"/);
});

function readAfterMacReturns() {
  const read = vi.fn(async () => {
    if (!runtime.isConnected()) throw new RuntimeError("unavailable", "Runtime is offline");
    return { url: renewed };
  });
  vi.mocked(runtime.call).mockImplementation(read);
  vi.mocked(call).mockImplementation(read);
  return read;
}

it("finishes an initial offline file lookup once its own Mac authenticates", async () => {
  socket.message({ type: "server_reconnecting" });
  const read = readAfterMacReturns();
  recording();
  const initial = cache
    .getQueryCache()
    .find({ queryKey: ["fileUrl", "recording", path] })!
    .fetch()
    .catch((e) => e);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(read).toHaveBeenCalledTimes(1);
  vi.mocked(call).mockRejectedValue(new Error("A different Mac is selected"));
  socket.message({ type: "authenticated" });
  expect(await initial).toBe(renewed);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
  "renews interrupted media on authentication and restores its position (paused=%s)",
  async (paused) => {
    cache.setQueryData(["fileUrl", "recording", path], first);
    const media = recording();
    const read = readAfterMacReturns();
    socket.message({ type: "server_reconnecting" });
    const player = {
      src: first,
      currentTime: 21,
      paused,
      readyState: 2,
      isConnected: true,
      load: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
    };
    const video = player as unknown as HTMLVideoElement;
    const renewal = media.onError(video);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(read).toHaveBeenCalledTimes(1);
    vi.mocked(call).mockRejectedValue(new Error("A different Mac is selected"));
    socket.message({ type: "authenticated" });
    await renewal;
    expect(cache.getQueryData(["fileUrl", "recording", path])).toBe(renewed);
    player.src = renewed;
    player.currentTime = 0;
    media.onLoadedMetadata(video);
    expect(player.currentTime).toBe(21);
    expect(player.play).toHaveBeenCalledTimes(paused ? 0 : 1);
    await media.onError(video);
    expect(read).toHaveBeenCalledTimes(2);
  }
);
