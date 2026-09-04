import { beforeEach, describe, expect, it, vi } from "vitest";

// The store owns ONE process-wide `onEvent` listener; capture it so tests can
// push `cloud:simulator` frames through the same validation path production
// uses (the shared zod schema), not a private setter.
const { listeners, connectionListeners, connectedNow } = vi.hoisted(() => ({
  listeners: [] as Array<(event: string, data: unknown) => void>,
  connectionListeners: [] as Array<(connected: boolean) => void>,
  /** What `isConnected()` answers when a subscription registers. */
  connectedNow: { value: true },
}));
vi.mock("@/platform/ws", () => ({
  onEvent: vi.fn((cb: (event: string, data: unknown) => void) => {
    listeners.push(cb);
    return () => {};
  }),
  isConnected: vi.fn(() => connectedNow.value),
  onConnectionChange: vi.fn((cb: (connected: boolean) => void) => {
    connectionListeners.push(cb);
    return () => {};
  }),
}));

import {
  EMPTY_CLOUD_SIM_DEVICE,
  cloudSimulatorActions,
  ensureCloudSimulatorSubscription,
  useCloudSimulatorStore,
  type CloudSimDevice,
} from "@/features/simulator/cloud/cloudSimulatorStore";
import { describeCloudSimulatorError } from "@/features/simulator/cloud/cloudSimulatorError";
import { cloudDeviceLabel, cloudSimPhase } from "@/features/simulator/cloud/cloudSimulatorPhase";

const WS = "ws-cloud-1";

function emit(event: string, data: unknown): void {
  for (const listener of listeners) listener(event, data);
}

function statusEvent(data: Record<string, unknown>, workspaceId = WS) {
  return {
    workspaceId,
    sessionId: "sess-1",
    kind: "status",
    data: { sessionId: "sess-1", timestamp: "2026-09-03T00:00:00Z", ...data },
  };
}

function actionEvent(verb: string, success: boolean, error?: string) {
  return {
    workspaceId: WS,
    sessionId: "sess-1",
    kind: "action_result",
    data: {
      sessionId: "sess-1",
      platform: "ios",
      verb,
      args: ["a"],
      success,
      ...(error ? { error } : {}),
      timestamp: "2026-09-03T00:00:00Z",
    },
  };
}

/** The backend's one-shot `cloudSimulator` answer. */
const seed = (over: Partial<Record<string, unknown>> = {}) => ({
  status: "ready",
  platform: "ios" as const,
  streamUrl: "https://stream.example/one",
  error: null,
  ...over,
});

const device = () => useCloudSimulatorStore.getState().byWorkspace[WS];

beforeEach(() => {
  useCloudSimulatorStore.setState({ byWorkspace: {} });
  ensureCloudSimulatorSubscription();
});

describe("cloudSimulatorStore — seeding from the one-shot status read", () => {
  it("copies the four status fields and leaves the ephemeral fields untouched", () => {
    cloudSimulatorActions.seedIfUnknown(WS, seed());
    expect(device()).toMatchObject({
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.example/one",
      error: null,
      busy: null,
      lastScreenshot: null,
      actions: [],
    });
  });

  it("keeps an unknown status (the platform deploys continuously); the panel reads it as in-flight", () => {
    cloudSimulatorActions.seedIfUnknown(WS, seed({ status: "hibernating" }));
    expect(device().status).toBe("hibernating");
    // The URL is a capability URL: only starting/ready may carry it.
    expect(device().streamUrl).toBeNull();
    expect(cloudSimPhase(device())).toBe("booting");
  });

  it("is a fallback: a second read never overwrites what is already known (same reference)", () => {
    cloudSimulatorActions.seedIfUnknown(WS, seed());
    const first = device();
    cloudSimulatorActions.seedIfUnknown(WS, seed({ status: "stopped" }));
    expect(device()).toBe(first);
  });

  it("the live event wins: a read that lands after an event changes nothing", () => {
    emit("cloud:simulator", statusEvent({ status: "starting", platform: "android" }));
    cloudSimulatorActions.seedIfUnknown(WS, seed());
    expect(device()).toMatchObject({ status: "starting", platform: "android" });
  });

  it("a null read (the platform knows of no device) leaves the entry unknown", () => {
    cloudSimulatorActions.seedIfUnknown(WS, null);
    expect(device()).toBeUndefined();
  });

  it("registers exactly one process-wide listener no matter how often it is ensured", () => {
    ensureCloudSimulatorSubscription();
    ensureCloudSimulatorSubscription();
    expect(listeners).toHaveLength(1);
  });
});

describe("cloudSimulatorStore — live status events", () => {
  it("overwrites the seeded status and clears the URL on 'stopped'", () => {
    cloudSimulatorActions.seedIfUnknown(WS, seed());
    emit("cloud:simulator", statusEvent({ status: "stopped", platform: "ios" }));
    expect(device()).toMatchObject({ status: "stopped", streamUrl: null, error: null });
  });

  it("carries the platform's error text and drops it again on the next non-error status", () => {
    emit("cloud:simulator", statusEvent({ status: "error", error: "boom" }));
    expect(device()).toMatchObject({ status: "error", error: "boom", platform: null });
    emit(
      "cloud:simulator",
      statusEvent({ status: "starting", platform: "ios", streamUrl: "https://s/2" })
    );
    expect(device()).toMatchObject({ status: "starting", error: null, streamUrl: "https://s/2" });
  });

  it("dedupes an identical re-announcement (reconnect snapshot) — same state reference", () => {
    emit("cloud:simulator", statusEvent({ status: "ready", platform: "ios", streamUrl: "u" }));
    const first = device();
    emit("cloud:simulator", statusEvent({ status: "ready", platform: "ios", streamUrl: "u" }));
    expect(device()).toBe(first);
  });

  it("ignores frames that fail the shared schema and frames for other events", () => {
    emit("cloud:simulator", { kind: "status", data: {} }); // no workspaceId / sessionId
    emit("cloud:env", statusEvent({ status: "ready" }));
    expect(device()).toBeUndefined();
  });

  it("keeps entries per workspace", () => {
    emit("cloud:simulator", statusEvent({ status: "ready", platform: "ios" }, "ws-a"));
    emit("cloud:simulator", statusEvent({ status: "stopped", platform: "ios" }, "ws-b"));
    const { byWorkspace } = useCloudSimulatorStore.getState();
    expect(byWorkspace["ws-a"].status).toBe("ready");
    expect(byWorkspace["ws-b"].status).toBe("stopped");
  });
});

describe("cloudSimulatorStore — the panel's optimistic busy marker", () => {
  it("is cleared by any status event (the platform answered), never by the one-shot read", () => {
    cloudSimulatorActions.setBusy(WS, "starting");
    cloudSimulatorActions.seedIfUnknown(WS, seed({ status: "stopped", streamUrl: null }));
    expect(device()).toMatchObject({ status: "stopped", busy: "starting" });

    emit("cloud:simulator", statusEvent({ status: "stopped", platform: "ios" }));
    expect(device().busy).toBeNull();
  });

  it("is cleared by the status event that moved the device", () => {
    cloudSimulatorActions.seedIfUnknown(WS, seed({ status: "stopped", streamUrl: null }));
    cloudSimulatorActions.setBusy(WS, "starting");
    emit(
      "cloud:simulator",
      statusEvent({ status: "starting", platform: "ios", streamUrl: "https://s/1" })
    );
    expect(device()).toMatchObject({ status: "starting", busy: null });
  });
});

describe("cloudSimulatorStore — screenshots and action results", () => {
  it("keeps only the latest screenshot, stamped with its arrival time", () => {
    const before = Date.now();
    emit("cloud:simulator", {
      workspaceId: WS,
      sessionId: "sess-1",
      kind: "screenshot",
      data: { sessionId: "sess-1", platform: "ios", imageBase64: "AAAA", format: "png" },
    });
    emit("cloud:simulator", {
      workspaceId: WS,
      sessionId: "sess-1",
      kind: "screenshot",
      data: { sessionId: "sess-1", platform: "ios", imageBase64: "BBBB", format: "png" },
    });
    expect(device().lastScreenshot?.base64).toBe("BBBB");
    expect(device().lastScreenshot?.at).toBeGreaterThanOrEqual(before);
  });

  it("drops a screenshot frame without image bytes", () => {
    emit("cloud:simulator", {
      workspaceId: WS,
      sessionId: "sess-1",
      kind: "screenshot",
      data: { sessionId: "sess-1", platform: "ios", format: "png" },
    });
    expect(device()).toBeUndefined();
  });

  it("appends action results oldest-first with the failure text, capped at a ring of 20", () => {
    emit("cloud:simulator", actionEvent("press", true));
    emit("cloud:simulator", actionEvent("fill", false, "no such ref"));
    expect(device().actions.map((a) => [a.verb, a.success, a.error])).toEqual([
      ["press", true, null],
      ["fill", false, "no such ref"],
    ]);
    expect(device().actions[0].args).toEqual(["a"]);

    for (let i = 0; i < 25; i++) emit("cloud:simulator", actionEvent(`verb-${i}`, true));
    const verbs = device().actions.map((a) => a.verb);
    expect(verbs).toHaveLength(20);
    expect(verbs[0]).toBe("verb-5");
    expect(verbs[19]).toBe("verb-24");
    // Ids stay monotonic so React keys never collide across the ring's slide.
    const ids = device().actions.map((a) => a.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it("survives a status change — recent agent activity is still worth showing", () => {
    emit("cloud:simulator", actionEvent("press", true));
    emit("cloud:simulator", statusEvent({ status: "stopped", platform: "ios" }));
    expect(device().actions).toHaveLength(1);
  });
});

describe("cloudSimPhase — what the panel shows", () => {
  const dev = (over: Partial<CloudSimDevice>): CloudSimDevice => ({
    ...EMPTY_CLOUD_SIM_DEVICE,
    ...over,
  });

  it("folds the optimistic busy marker over the platform status", () => {
    expect(cloudSimPhase(dev({ status: "stopped", busy: "starting" }))).toBe("booting");
    expect(cloudSimPhase(dev({ status: "ready", streamUrl: "u", busy: "stopping" }))).toBe(
      "stopping"
    );
  });

  it("is live only with a stream URL; ready without one is still booting to the viewer", () => {
    expect(cloudSimPhase(dev({ status: "ready", streamUrl: "u" }))).toBe("live");
    expect(cloudSimPhase(dev({ status: "starting", streamUrl: "u" }))).toBe("live");
    expect(cloudSimPhase(dev({ status: "ready" }))).toBe("booting");
    expect(cloudSimPhase(dev({ status: "starting" }))).toBe("booting");
  });

  it("maps the rest: never known / stopped → idle, stopping, error", () => {
    expect(cloudSimPhase(dev({}))).toBe("idle");
    expect(cloudSimPhase(dev({ status: "stopped" }))).toBe("idle");
    expect(cloudSimPhase(dev({ status: "stopping" }))).toBe("stopping");
    expect(cloudSimPhase(dev({ status: "error", error: "x" }))).toBe("error");
  });

  it("labels the device by platform", () => {
    expect(cloudDeviceLabel("ios")).toBe("iPhone (cloud)");
    expect(cloudDeviceLabel("android")).toBe("Android (cloud)");
    expect(cloudDeviceLabel(null)).toBe("Cloud device");
  });
});

describe("describeCloudSimulatorError", () => {
  it("turns the two known platform texts into product words and passes anything else through", () => {
    expect(
      describeCloudSimulatorError(
        "This sandbox's sidecar predates simulator control — restart the workspace to upgrade it."
      )
    ).toMatch(/restart the workspace/i);
    expect(describeCloudSimulatorError("The simulator is not enabled for this workspace.")).toBe(
      "This workspace's environment has no simulator; new cloud workspaces get one."
    );
    expect(describeCloudSimulatorError("EAS quota exceeded")).toBe("EAS quota exceeded");
    expect(describeCloudSimulatorError(null)).toMatch(/failed to start/i);
  });
});

describe("cloudSimulatorStore on identity change", () => {
  it("forgets every device on cloud:identity — the entries were the previous account's", () => {
    emit(
      "cloud:simulator",
      statusEvent({ status: "ready", platform: "ios", streamUrl: "https://stream.example/a" })
    );
    emit("cloud:simulator", actionEvent("fill", true));
    expect(device().status).toBe("ready");
    expect(device().actions).toHaveLength(1);
    emit("cloud:identity", { generation: 2 });
    expect(useCloudSimulatorStore.getState().byWorkspace).toEqual({});
    // And a device seen afterwards is the new account's, from scratch.
    emit("cloud:simulator", statusEvent({ status: "starting", platform: "android" }));
    expect(device().platform).toBe("android");
    expect(device().actions).toEqual([]);
  });
});

describe("cloudSimulatorStore generation and gone", () => {
  it("bumps the generation on cloud:identity so in-flight seeds can be disowned", () => {
    const before = useCloudSimulatorStore.getState().generation;
    emit("cloud:identity", { generation: 1 });
    expect(useCloudSimulatorStore.getState().generation).toBe(before + 1);
  });

  it("drops the entry on a gone event — the platform knows of no device any more", () => {
    emit(
      "cloud:simulator",
      statusEvent({ status: "ready", platform: "ios", streamUrl: "https://s/1" })
    );
    emit("cloud:simulator", actionEvent("tap", true));
    emit("cloud:simulator", { workspaceId: WS, sessionId: "sess-1", kind: "gone", data: {} });
    expect(useCloudSimulatorStore.getState().byWorkspace[WS]).toBeUndefined();
    expect(device()).toBeUndefined();
  });
});

describe("cloudSimulatorStore across a reconnect", () => {
  const connection = (connected: boolean) => connectionListeners.forEach((l) => l(connected));

  it("keeps its entries on the initial connect, forgets them after a drop and reconnect", () => {
    emit(
      "cloud:simulator",
      statusEvent({ status: "ready", platform: "ios", streamUrl: "https://s/1" })
    );
    const before = useCloudSimulatorStore.getState().generation;
    connection(true); // the first connect of the session: nothing was missed
    expect(device().status).toBe("ready");
    expect(useCloudSimulatorStore.getState().generation).toBe(before);
    connection(false);
    expect(device().status).toBe("ready"); // offline: keep showing what we knew
    connection(true); // broadcasts may have been missed: start over, re-seed
    expect(useCloudSimulatorStore.getState().byWorkspace).toEqual({});
    expect(useCloudSimulatorStore.getState().generation).toBe(before + 1);
  });
});

describe("cloudSimulatorStore — screenshots remember their platform", () => {
  it("keeps the platform a capture came from, so a request for the other device can ignore it", () => {
    emit("cloud:simulator", {
      workspaceId: WS,
      sessionId: "sess-1",
      kind: "screenshot",
      data: { sessionId: "sess-1", platform: "android", imageBase64: "CCCC", format: "png" },
    });
    expect(device().lastScreenshot).toMatchObject({
      base64: "CCCC",
      platform: "android",
      capturedAt: null,
    });
    emit("cloud:simulator", {
      workspaceId: WS,
      sessionId: "sess-1",
      kind: "screenshot",
      data: {
        sessionId: "sess-1",
        platform: "ios",
        imageBase64: "EEEE",
        format: "png",
        timestamp: "2026-09-04T10:00:00.000Z",
      },
    });
    // The platform's own stamp survives: the panel correlates on it.
    expect(device().lastScreenshot).toMatchObject({
      base64: "EEEE",
      capturedAt: Date.parse("2026-09-04T10:00:00.000Z"),
    });
    emit("cloud:simulator", {
      workspaceId: WS,
      sessionId: "sess-1",
      kind: "screenshot",
      data: { sessionId: "sess-1", imageBase64: "DDDD", format: "png" },
    });
    expect(device().lastScreenshot).toMatchObject({ base64: "DDDD", platform: null });
  });
});

describe("cloudSimulatorStore registered while the socket is down", () => {
  // Last in the file: it re-evaluates the store module, which registers a
  // second process-wide listener — earlier tests count exactly one.
  it("treats the connect that follows as a reconnect and starts over", async () => {
    connectedNow.value = false;
    vi.resetModules();
    try {
      const fresh = await import("@/features/simulator/cloud/cloudSimulatorStore");
      fresh.ensureCloudSimulatorSubscription();
      const before = fresh.useCloudSimulatorStore.getState().generation;
      // The seed that ran meanwhile failed (no socket); this connect is the
      // first chance to learn the truth — not "the initial connect".
      connectionListeners.forEach((l) => l(true));
      expect(fresh.useCloudSimulatorStore.getState().generation).toBe(before + 1);
    } finally {
      connectedNow.value = true;
      vi.resetModules();
    }
  });
});
