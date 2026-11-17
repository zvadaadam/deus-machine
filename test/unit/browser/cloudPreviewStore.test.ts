import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { emit, following } from "../../helpers";

// The store follows its streams once for the whole app; `follow` is never
// cleared here, so every test publishes to that one subscription.
const follow = vi.hoisted(() => vi.fn(() => vi.fn()));
const call = vi.hoisted(() => vi.fn());
/** What `isConnected()` answers when a subscription registers. */
const connectedNow = vi.hoisted(() => ({ value: true }));
const connectionListeners: Array<(connected: boolean) => void> = [];
vi.mock("@/platform/ws", () => ({
  follow,
  isConnected: () => connectedNow.value,
  onConnectionChange: (cb: (connected: boolean) => void) => {
    connectionListeners.push(cb);
    return () => {};
  },
  call,
}));

import {
  cloudPreviewActions,
  ensureCloudPreviewSubscription,
  useCloudPreviewStore,
} from "@/features/browser/cloud/cloudPreviewStore";
import { cloudPreviewAddress } from "@/features/browser/lib/cloudPreview";

/** The backend announces a workspace's preview address, under that workspace. */
const announce = (workspaceId: string, value: string | null) =>
  emit(
    follow,
    api.cloudPreviewChanges,
    { workspaceId },
    { workspaceId, sessionId: "s-1", template: value }
  );
/** This computer signed in to another account, or out. */
const identityChanged = (generation: number) => emit(follow, api.cloudIdentity, {}, { generation });
const template = () => useCloudPreviewStore.getState().byWorkspace["ws-1"];

beforeEach(() => {
  useCloudPreviewStore.setState({ byWorkspace: {}, pending: null, fromChat: {} });
  ensureCloudPreviewSubscription();
});

describe("cloudPreviewStore", () => {
  it("follows preview address changes, null included (no sandbox behind the session)", () => {
    announce("ws-1", "https://{{port}}-sb1.e2b.app");
    expect(template()).toBe("https://{{port}}-sb1.e2b.app");
    announce("ws-1", null);
    expect(template()).toBeNull();
  });

  it("is referentially stable for a repeated value, set or announced", () => {
    cloudPreviewActions.set("ws-1", "u");
    const first = useCloudPreviewStore.getState();
    cloudPreviewActions.set("ws-1", "u");
    expect(useCloudPreviewStore.getState()).toBe(first);
    announce("ws-1", "u");
    expect(useCloudPreviewStore.getState()).toBe(first);
  });

  it("follows each of its two streams once for the whole app, for every workspace", () => {
    ensureCloudPreviewSubscription();
    ensureCloudPreviewSubscription();
    expect(following(follow)).toEqual([
      { stream: "cloudIdentity", filter: {} },
      { stream: "cloudPreviewChanges", filter: {} },
    ]);
  });
});

describe("cloudPreviewStore on identity change", () => {
  it("forgets every template when the account changes — they were the previous account's sandboxes", () => {
    cloudPreviewActions.set("ws-1", "https://{{port}}-sb1.e2b.app");
    cloudPreviewActions.set("ws-2", null);
    identityChanged(3);
    expect(useCloudPreviewStore.getState().byWorkspace).toEqual({});
  });
});

describe("cloudPreviewStore reads across an identity change", () => {
  it("drops a one-shot answer that started before the account changed — it was the previous account's", async () => {
    const { seedCloudPreviewTemplate } = await import("@/features/browser/cloud/cloudPreviewStore");
    let answer!: (value: unknown) => void;
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const cancel = seedCloudPreviewTemplate("ws-1");
    identityChanged(9);
    answer("https://{{port}}-accountA.e2b.app");
    await Promise.resolve();
    await Promise.resolve();
    expect(useCloudPreviewStore.getState().byWorkspace["ws-1"]).toBeUndefined();
    cancel();
  });

  it("applies a one-shot answer under an unchanged identity, unless the store learned meanwhile", async () => {
    const { seedCloudPreviewTemplate } = await import("@/features/browser/cloud/cloudPreviewStore");
    call.mockResolvedValueOnce("https://{{port}}-sb1.e2b.app");
    seedCloudPreviewTemplate("ws-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(useCloudPreviewStore.getState().byWorkspace["ws-1"]).toBe(
      "https://{{port}}-sb1.e2b.app"
    );
    let answer!: (value: unknown) => void;
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    seedCloudPreviewTemplate("ws-2");
    cloudPreviewActions.set("ws-2", "https://{{port}}-live.e2b.app");
    answer("https://{{port}}-stale.e2b.app");
    await Promise.resolve();
    await Promise.resolve();
    expect(useCloudPreviewStore.getState().byWorkspace["ws-2"]).toBe(
      "https://{{port}}-live.e2b.app"
    );
  });
});

describe("cloudPreviewStore across a reconnect", () => {
  const connection = (connected: boolean) => connectionListeners.forEach((l) => l(connected));

  it("forgets every template after a drop and reconnect, not on the initial connect", () => {
    cloudPreviewActions.set("ws-1", "https://{{port}}-sb1.e2b.app");
    const before = useCloudPreviewStore.getState().generation;
    connection(true);
    expect(template()).toBe("https://{{port}}-sb1.e2b.app");
    connection(false);
    connection(true);
    expect(useCloudPreviewStore.getState().byWorkspace).toEqual({});
    expect(useCloudPreviewStore.getState().generation).toBe(before + 1);
  });
});

describe("cloudPreviewStore registered while the socket is down", () => {
  // Last in the file: it re-evaluates the store module, which follows both
  // streams a second time — earlier tests count each exactly once.
  it("treats the connect that follows as a reconnect and starts over", async () => {
    connectedNow.value = false;
    vi.resetModules();
    try {
      const fresh = await import("@/features/browser/cloud/cloudPreviewStore");
      fresh.ensureCloudPreviewSubscription();
      const before = fresh.useCloudPreviewStore.getState().generation;
      connectionListeners.forEach((l) => l(true));
      expect(fresh.useCloudPreviewStore.getState().generation).toBe(before + 1);
    } finally {
      connectedNow.value = true;
      vi.resetModules();
    }
  });
});

describe("the chat's path for a workspace's preview", () => {
  const fromChat = (workspaceId: string) =>
    useCloudPreviewStore.getState().fromChat[workspaceId] ?? null;

  it("outlives the request and the panel, and rebases on a replaced computer", () => {
    announce("ws-1", "https://{{port}}-old.e2b.app");
    cloudPreviewActions.show("ws-1", 5173, "/dash?a=1#top");
    const request = useCloudPreviewStore.getState().pending;
    // The panel takes the request, then unmounts while the computer is replaced.
    cloudPreviewActions.taken(request?.requestId ?? "");
    announce("ws-1", "https://{{port}}-new.e2b.app");

    // A panel mounted later reads it back on the new computer's host.
    expect(useCloudPreviewStore.getState().pending).toBeNull();
    expect(cloudPreviewAddress(template(), 5173, fromChat("ws-1"))).toBe(
      "https://5173-new.e2b.app/dash?a=1#top"
    );
  });

  it("is cleared by a port chosen by hand, and only for that workspace", () => {
    cloudPreviewActions.show("ws-1", 5173, "/a");
    cloudPreviewActions.show("ws-2", 3000, "/b");

    cloudPreviewActions.portChosen("ws-1");

    expect(fromChat("ws-1")).toBeNull();
    expect(fromChat("ws-2")).toEqual({ port: 3000, rest: "/b" });
  });

  it("survives an account change, which forgets the templates (as a reconnect does)", () => {
    cloudPreviewActions.show("ws-1", 5173, "/a");
    identityChanged(99);
    expect(fromChat("ws-1")).toEqual({ port: 5173, rest: "/a" });
  });
});
