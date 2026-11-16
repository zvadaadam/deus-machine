import { beforeEach, describe, expect, it, vi } from "vitest";

// The store persists to `window.localStorage`, which Node lacks: a plain one, before it loads.
vi.hoisted(() => {
  const items = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  Object.assign(globalThis, { localStorage, window: { localStorage } });
});
import {
  finishCloudSignIn,
  retryCloudSetup,
  startCloudSignIn,
  useSidebarStore,
} from "@/features/sidebar/store/sidebarStore";
import type { Organizations } from "@/features/sidebar/lib/location";

const pending = () => useSidebarStore.getState().cloudPending;
const retrying = () => useSidebarStore.getState().cloudSetupRetrying;

/** An answer the test gives by hand, as the browser round trip or main would. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

const signedOut: Organizations = { available: false, defaultOrganizationId: null, items: [] };
const listed = (ready: Record<string, boolean>, available = true): Organizations => ({
  available,
  defaultOrganizationId: "acme",
  items: Object.entries(ready).map(([id, isReady]) => ({
    id,
    name: id,
    role: "owner",
    ready: isReady,
  })),
});

beforeEach(() =>
  useSidebarStore.setState({
    cloudPending: null,
    cloudSetupRetrying: false,
    location: "local",
    cloudOrganizationId: null,
  })
);

describe("the window's place in the store", () => {
  it("keeps the organization last chosen, also while on this computer", () => {
    const { setPlace } = useSidebarStore.getState();
    setPlace({ location: "cloud", organizationId: "beta" });
    expect(useSidebarStore.getState()).toMatchObject({
      location: "cloud",
      cloudOrganizationId: "beta",
    });
    setPlace({ location: "local", organizationId: null });
    // The one cloud (no list) keeps it too.
    setPlace({ location: "cloud", organizationId: null });
    expect(useSidebarStore.getState()).toMatchObject({
      location: "cloud",
      cloudOrganizationId: "beta",
    });
  });

  it("persists the location and the organization, and reads older saves", () => {
    useSidebarStore.getState().setPlace({ location: "cloud", organizationId: "beta" });
    expect(JSON.parse(localStorage.getItem("sidebar-storage")!).state).toMatchObject({
      location: "cloud",
      cloudOrganizationId: "beta",
    });
    const options = useSidebarStore.persist.getOptions();
    const saved = options.partialize!(useSidebarStore.getState()) as Record<string, unknown>;
    expect(saved).toMatchObject({ location: "cloud", cloudOrganizationId: "beta" });
    const current = useSidebarStore.getState();
    expect(options.merge!(saved, current)).toMatchObject({
      location: "cloud",
      cloudOrganizationId: "beta",
    });
    // A save from before organizations: none chosen.
    expect(options.merge!({ location: "cloud" }, current)).toMatchObject({
      location: "cloud",
      cloudOrganizationId: null,
    });
  });

  it("remembers the selection per place", () => {
    const { rememberSelection } = useSidebarStore.getState();
    rememberSelection("cloud:acme", "w1");
    rememberSelection("cloud:beta", "w2");
    expect(useSidebarStore.getState().lastSelectedByPlace).toMatchObject({
      "cloud:acme": "w1",
      "cloud:beta": "w2",
    });
  });
});

describe("a Deus Cloud sign-in started from the location menu", () => {
  it("is pending from the moment it starts, and still once signed in", async () => {
    const signIn = deferred<{ success: boolean }>();
    const started = startCloudSignIn(() => signIn.promise);
    expect(pending()).toEqual({ organizationId: null });
    signIn.resolve({ success: true });
    await started;
    // Signed in, it still waits for this computer's cloud key.
    expect(pending()).toEqual({ organizationId: null });
  });

  it("is dropped when the sign-in does not complete, or fails", async () => {
    await startCloudSignIn(async () => ({ success: false }));
    expect(pending()).toBeNull();
    await startCloudSignIn(() => Promise.reject(new Error("Deus Cloud sign-in was cancelled")));
    expect(pending()).toBeNull();
  });

  it("moves the window to the cloud once the pushed value says it is reachable, once", async () => {
    await startCloudSignIn(async () => ({ success: true }));
    const switchTo = vi.fn();
    finishCloudSignIn({ organizations: signedOut, cloudRow: "setting-up" }, switchTo);
    finishCloudSignIn(
      { organizations: listed({ acme: false }, false), cloudRow: "setting-up" },
      switchTo
    );
    finishCloudSignIn({ organizations: undefined, cloudRow: "ready" }, switchTo);
    expect(switchTo).not.toHaveBeenCalled();
    expect(pending()).not.toBeNull();

    finishCloudSignIn({ organizations: listed({ acme: true }), cloudRow: "ready" }, switchTo);
    finishCloudSignIn({ organizations: listed({ acme: true }), cloudRow: "ready" }, switchTo);
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith({ location: "cloud", organizationId: null });
    expect(pending()).toBeNull();
  });

  it("ends when the setup failed: nothing running will reach the cloud", async () => {
    await startCloudSignIn(async () => ({ success: true }));
    const switchTo = vi.fn();
    finishCloudSignIn({ organizations: signedOut, cloudRow: "retry" }, switchTo);
    expect(pending()).toBeNull();
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("does not move a window no sign-in was started from", () => {
    const switchTo = vi.fn();
    finishCloudSignIn({ organizations: listed({ acme: true }), cloudRow: "ready" }, switchTo);
    expect(switchTo).not.toHaveBeenCalled();
  });
});

describe("Set up (or Retry) from the location menu", () => {
  it("records the same intent, together with the running setup", async () => {
    const retry = deferred<{ ok: boolean }>();
    const started = retryCloudSetup(() => retry.promise, "beta");
    expect([pending(), retrying()]).toEqual([{ organizationId: "beta" }, true]);
    retry.resolve({ ok: true });
    await started;
    // Made, it waits for the organization to be ready to move the window.
    expect([pending(), retrying()]).toEqual([{ organizationId: "beta" }, false]);
  });

  it("moves the window to that organization once it is ready", async () => {
    await retryCloudSetup(async () => ({ ok: true }), "beta");
    const switchTo = vi.fn();
    finishCloudSignIn(
      { organizations: listed({ acme: true, beta: false }), cloudRow: "ready" },
      switchTo
    );
    expect(switchTo).not.toHaveBeenCalled();
    finishCloudSignIn(
      { organizations: listed({ acme: true, beta: true }), cloudRow: "ready" },
      switchTo
    );
    expect(switchTo).toHaveBeenCalledWith({ location: "cloud", organizationId: "beta" });
  });

  it("from the composer runs the same setup but never moves the window", async () => {
    const retry = deferred<{ ok: boolean }>();
    const started = retryCloudSetup(() => retry.promise, "beta", { moveWindow: false });
    expect([pending(), retrying()]).toEqual([null, true]);
    retry.resolve({ ok: true });
    await started;
    expect([pending(), retrying()]).toEqual([null, false]);
    // A sign-in pending elsewhere is left alone, even by a setup that fails.
    useSidebarStore.setState({ cloudPending: { organizationId: null } });
    await retryCloudSetup(async () => ({ ok: false }), "beta", { moveWindow: false });
    expect(pending()).toEqual({ organizationId: null });
  });

  it("ends the intent when the setup fails", async () => {
    const result = await retryCloudSetup(async () => ({ ok: false, error: "Mint failed" }));
    expect(result).toEqual({ ok: false, error: "Mint failed" });
    expect([pending(), retrying()]).toEqual([null, false]);
    expect((await retryCloudSetup(() => Promise.reject(new Error("IPC closed")))).ok).toBe(false);
    expect([pending(), retrying()]).toEqual([null, false]);
  });
});
