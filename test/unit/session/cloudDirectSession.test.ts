import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { SessionErrorEventSchema, SessionSnapshotEventSchema } from "@deus-hq/api";
import { useCloudDirectSession } from "@/features/session/hooks/useCloudDirectSession";
import { emitLocalEvent } from "@/platform/ws";
import { getDirectSession } from "@/features/session/cloud/directSessionRegistry";
import { CloudSimulatorEventSchema } from "@shared/events";
import {
  cloudSimulatorActions,
  useCloudSimulatorStore,
} from "@/features/simulator/cloud/cloudSimulatorStore";

// Exercise the hook's actual frame routing; only React mounting and the socket
// are replaced. The transcript fold, query cache and simulator store remain real.
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
  useCloudSimulatorStore.setState({ byWorkspace: {}, epochs: {} });
  vi.mocked(emitLocalEvent).mockImplementation((event, raw) => {
    if (event !== "cloud:simulator") return;
    const frame = CloudSimulatorEventSchema.parse(raw);
    if (frame.kind === "status")
      cloudSimulatorActions.applyStatusEvent(frame.workspaceId, frame.data);
    else if (frame.kind === "gone") cloudSimulatorActions.forget(frame.workspaceId);
  });
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

  it.each([false, true])(
    "selects the running device regardless of mirror order (reverse=%s)",
    (reverse) => {
      const ios = snapshot("ready").latestSimulatorStatus!;
      const android = {
        ...snapshot("stopped").latestSimulatorStatus!,
        platform: "android",
        timestamp: "2026-09-06T18:05:00.000Z",
      };
      onFrame({
        ...snapshot("stopped"),
        latestSimulatorStatus: android,
        latestSimulatorStatuses: reverse ? [android, ios] : [ios, android],
      });
      expect(emitLocalEvent).toHaveBeenLastCalledWith("cloud:simulator", {
        workspaceId: "deus-direct-1",
        sessionId: "deus-direct-1",
        kind: "status",
        data: expect.objectContaining({ platform: "ios", status: "ready" }),
      });
    }
  );

  it("reads a list-only mirror and lets an empty list clear even a stale singular mirror", () => {
    const frame = snapshot("ready");
    onFrame({
      ...frame,
      latestSimulatorStatus: undefined,
      latestSimulatorStatuses: [frame.latestSimulatorStatus],
    });
    expect(emitLocalEvent).toHaveBeenLastCalledWith(
      "cloud:simulator",
      expect.objectContaining({
        kind: "status",
        data: expect.objectContaining({ status: "ready" }),
      })
    );
    onFrame({ ...frame, latestSimulatorStatuses: [] });
    expect(emitLocalEvent).toHaveBeenLastCalledWith("cloud:simulator", {
      workspaceId: "deus-direct-1",
      sessionId: "deus-direct-1",
      kind: "gone",
      data: {},
    });
  });

  it("keeps the primary command busy across unrelated transitions and replays until a fresh answer", () => {
    onFrame(snapshot("ready"));
    cloudSimulatorActions.setBusy("deus-direct-1", "stopping");
    vi.mocked(emitLocalEvent).mockClear();
    onFrame({ ...snapshot("stopped").latestSimulatorStatus, platform: "android" });
    onFrame(snapshot("ready").latestSimulatorStatus!);
    expect(emitLocalEvent).not.toHaveBeenCalled();
    expect(useCloudSimulatorStore.getState().byWorkspace["deus-direct-1"]).toMatchObject({
      platform: "ios",
      status: "ready",
      busy: "stopping",
    });
    onFrame({ ...snapshot("ready").latestSimulatorStatus, timestamp: "2026-09-06T18:05:00.000Z" });
    expect(useCloudSimulatorStore.getState().byWorkspace["deus-direct-1"].busy).toBeNull();
  });

  it("preserves other devices when a legacy reconnect reports only the newest platform status", () => {
    onFrame(snapshot("ready"));
    onFrame({
      ...snapshot("stopped"),
      latestSimulatorStatus: { ...snapshot("stopped").latestSimulatorStatus, platform: "android" },
    });
    expect(emitLocalEvent).toHaveBeenLastCalledWith(
      "cloud:simulator",
      expect.objectContaining({
        kind: "status",
        data: expect.objectContaining({ platform: "ios", status: "ready" }),
      })
    );
  });

  it("keeps devices behind a platformless legacy command error", () => {
    onFrame(snapshot("ready"));
    onFrame({
      ...snapshot("ready"),
      latestSimulatorStatus: {
        type: "simulator.status",
        status: "error",
        error: "SIDECAR_NOT_CONNECTED",
      },
    });
    expect(useCloudSimulatorStore.getState().byWorkspace["deus-direct-1"].error).toBe(
      "SIDECAR_NOT_CONNECTED"
    );
    const android = {
      ...snapshot("ready").latestSimulatorStatus,
      platform: "android",
      timestamp: "2026-09-06T18:05:00.000Z",
    };
    onFrame(android);
    expect(useCloudSimulatorStore.getState().byWorkspace["deus-direct-1"].platform).toBe("android");
    onFrame({ ...android, status: "stopped", timestamp: "2026-09-06T18:06:00.000Z" });
    expect(useCloudSimulatorStore.getState().byWorkspace["deus-direct-1"]).toMatchObject({
      platform: "ios",
      status: "ready",
      streamUrl: "https://stream.expo.dev/device",
    });
  });

  it("ignores a malformed complete mirror without clearing or changing the device", () => {
    const frame = snapshot("ready");
    onFrame(frame);
    vi.mocked(emitLocalEvent).mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      onFrame({
        ...frame,
        latestSimulatorStatuses: [{ ...frame.latestSimulatorStatus, status: "stopped" }, null],
      });
      expect(
        vi.mocked(emitLocalEvent).mock.calls.filter(([kind]) => kind === "cloud:simulator")
      ).toEqual([]);
      onFrame({ ...snapshot("stopped").latestSimulatorStatus, platform: "android" });
      expect(useCloudSimulatorStore.getState().byWorkspace["deus-direct-1"]).toMatchObject({
        platform: "ios",
        status: "ready",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("simulator"));
    } finally {
      warn.mockRestore();
    }
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

  it("shows the fatal message after AGNT has already ended the turn", () => {
    onFrame({ type: "turn.started", turnId: "turn-current", timestamp: 1 });
    onFrame({
      type: "turn.ended",
      turnId: "turn-current",
      stopReason: "error",
      timestamp: 2,
      error: { category: "auth", message: "Reconnect your provider account" },
    });
    setState.mockClear();
    onFrame({
      type: "session.error",
      turnId: "turn-current",
      recoverable: false,
      error: { code: "provider_auth", message: "Reconnect your provider account" },
    });
    expect(setState).toHaveBeenCalledWith("Reconnect your provider account");
    setState.mockClear();
    onFrame({ type: "turn.started", turnId: "turn-next", timestamp: 3 });
    expect(setState).toHaveBeenCalledWith(null);
    expect(setState).toHaveBeenCalledWith("open");
  });

  it("does not let a previous turn's error interrupt a new send awaiting admission", () => {
    onFrame({ type: "turn.started", turnId: "turn-previous", timestamp: 1 });
    onFrame({ type: "turn.ended", turnId: "turn-previous", stopReason: "end_turn", timestamp: 2 });
    getDirectSession("deus-direct-1")!.sendMessage("Next request", "turn-next", {});
    setState.mockClear();
    onFrame({
      type: "session.error",
      turnId: "turn-previous",
      recoverable: false,
      error: { code: "EXECUTION_FAILED", message: "Previous failure" },
    });
    expect(setState).not.toHaveBeenCalled();
  });
});
