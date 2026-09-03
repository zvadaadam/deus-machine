import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Array<(event: string, data: unknown) => void> = [];
const sendRequest = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ws", () => ({
  onEvent: (cb: (event: string, data: unknown) => void) => {
    listeners.push(cb);
    return () => {};
  },
  sendRequest,
}));

import {
  cloudPreviewActions,
  ensureCloudPreviewSubscription,
  useCloudPreviewStore,
} from "@/features/browser/cloud/cloudPreviewStore";

const emit = (event: string, data: unknown) => listeners.forEach((l) => l(event, data));
const template = () => useCloudPreviewStore.getState().byWorkspace["ws-1"];

beforeEach(() => {
  useCloudPreviewStore.setState({ byWorkspace: {} });
  ensureCloudPreviewSubscription();
});

describe("cloudPreviewStore", () => {
  it("follows cloud:preview announcements, null included (no sandbox behind the session)", () => {
    emit("cloud:preview", {
      workspaceId: "ws-1",
      sessionId: "s-1",
      template: "https://{{port}}-sb1.e2b.app",
    });
    expect(template()).toBe("https://{{port}}-sb1.e2b.app");
    emit("cloud:preview", { workspaceId: "ws-1", sessionId: "s-1", template: null });
    expect(template()).toBeNull();
  });

  it("is referentially stable for a repeated value and ignores malformed frames", () => {
    cloudPreviewActions.set("ws-1", "u");
    const first = useCloudPreviewStore.getState();
    cloudPreviewActions.set("ws-1", "u");
    expect(useCloudPreviewStore.getState()).toBe(first);
    emit("cloud:preview", { workspaceId: "ws-1" }); // no sessionId / template
    expect(template()).toBe("u");
  });

  it("registers exactly one process-wide listener", () => {
    ensureCloudPreviewSubscription();
    ensureCloudPreviewSubscription();
    expect(listeners).toHaveLength(1);
  });
});

describe("cloudPreviewStore on identity change", () => {
  it("forgets every template on cloud:identity — they were the previous account's sandboxes", () => {
    cloudPreviewActions.set("ws-1", "https://{{port}}-sb1.e2b.app");
    cloudPreviewActions.set("ws-2", null);
    emit("cloud:identity", { generation: 3 });
    expect(useCloudPreviewStore.getState().byWorkspace).toEqual({});
  });
});
