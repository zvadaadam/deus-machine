import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { SessionErrorEventSchema, SessionSnapshotEventSchema } from "@deus-hq/api";
import { useCloudDirectSession } from "@/features/session/hooks/useCloudDirectSession";
import { emitLocalEvent } from "@/platform/ws";

// Exercise the hook's actual frame routing; only React mounting and the socket
// are replaced. The transcript fold and query cache remain real.
const { effects, setState } = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  setState: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
  useState: (initial: unknown) => [initial, setState],
}));

let queryClient: QueryClient;
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => queryClient,
}));
vi.mock("@/platform/ws", () => ({
  emitLocalEvent: vi.fn(),
  setToolResponseInterceptor: vi.fn(),
}));

let onFrame: (frame: Record<string, unknown>) => void;
vi.mock("@/features/session/cloud/cloudSessionSocket", () => ({
  connectCloudSessionSocket: (options: { onFrame: typeof onFrame }) => {
    onFrame = options.onFrame;
    return { send: vi.fn(), close: vi.fn() };
  },
}));

let cleanup: void | (() => void);
beforeEach(() => {
  vi.clearAllMocks();
  effects.length = 0;
  queryClient = new QueryClient();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  useCloudDirectSession({
    sessionId: "deus-direct-1",
    providerSessionId: "agnt-direct-1",
    baseUrl: "https://agnt.test",
    token: "test-session-token",
  });
  cleanup = effects[0]();
});
afterEach(() => {
  cleanup?.();
  queryClient.clear();
  vi.unstubAllGlobals();
});

function snapshot(status: "ready" | "stopped") {
  return SessionSnapshotEventSchema.parse({
    type: "session.snapshot",
    state: {
      sessionId: "agnt-direct-1",
      organizationId: "org-1",
      workspaceId: "agnt-ws-1",
      status: "ready",
      sandboxUrlTemplate: "https://port-{{port}}.sandbox.test",
      currentTurnId: "turn-current",
    },
    messages: [],
    latestSimulatorStatus: {
      type: "simulator.status",
      sessionId: "agnt-direct-1",
      status,
      platform: "ios",
      ...(status === "ready" ? { streamUrl: "https://stream.expo.dev/device" } : {}),
      timestamp: "2026-09-06T18:00:00.000Z",
    },
  });
}

describe("direct cloud session published frames", () => {
  it("restores the device and refreshes it when reconnect reports it stopped", () => {
    onFrame(snapshot("ready"));
    expect(emitLocalEvent).toHaveBeenCalledWith("cloud:simulator", {
      workspaceId: "deus-direct-1",
      sessionId: "deus-direct-1",
      kind: "status",
      data: expect.objectContaining({
        status: "ready",
        streamUrl: "https://stream.expo.dev/device",
      }),
    });
    expect(emitLocalEvent).toHaveBeenCalledWith("cloud:preview", {
      workspaceId: "deus-direct-1",
      sessionId: "deus-direct-1",
      template: "https://port-{{port}}.sandbox.test",
    });

    vi.mocked(emitLocalEvent).mockClear();
    onFrame(snapshot("stopped"));
    expect(emitLocalEvent).toHaveBeenCalledWith("cloud:simulator", {
      workspaceId: "deus-direct-1",
      sessionId: "deus-direct-1",
      kind: "status",
      data: expect.objectContaining({ status: "stopped", platform: "ios" }),
    });
  });

  it.each([undefined, "turn-current"])("shows the real failure message for turn %s", (turnId) => {
    onFrame(snapshot("ready"));
    setState.mockClear();
    onFrame(
      SessionErrorEventSchema.parse({
        type: "session.error",
        error: { code: "AUTH_FAILED", message: "Reconnect your provider account" },
        recoverable: false,
        ...(turnId !== undefined ? { turnId } : {}),
      })
    );
    expect(setState).toHaveBeenCalledWith("error");
    expect(setState).toHaveBeenCalledWith("Reconnect your provider account");
  });

  it.each([
    { recoverable: true, turnId: "turn-current" },
    { recoverable: false, turnId: "turn-previous" },
  ])("keeps the current turn working for $turnId, recoverable=$recoverable", (details) => {
    onFrame(snapshot("ready"));
    setState.mockClear();
    onFrame(
      SessionErrorEventSchema.parse({
        type: "session.error",
        error: { code: "EXECUTION_FAILED", message: "An execution failed" },
        ...details,
      })
    );
    expect(setState).not.toHaveBeenCalled();
  });
});
