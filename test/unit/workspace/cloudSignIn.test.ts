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
import {
  organizationRowState,
  type CloudRowState,
  type Organizations,
} from "@/features/sidebar/lib/location";

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

/** Where the window was when the intent started: this computer, a local workspace open. */
const from = { place: "local", selectedId: "w1" };

/** What `finishCloudSignIn` reads: the pushed value, the rows, and where the window is. */
const now = (
  organizations: Organizations,
  cloudRow: CloudRowState,
  here: { place: string; selectedId: string | null } = from
) => ({
  organizations,
  cloudRow,
  here,
  organizationRow: (org: { ready: boolean }) =>
    organizationRowState({
      ready: org.ready,
      session: { signedIn: true, hasPlatformKey: true },
      retrying: useSidebarStore.getState().cloudSetupRetrying,
      canSetUp: true,
    }),
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
    const started = startCloudSignIn(() => signIn.promise, from);
    expect(pending()).toEqual({ organizationId: null, from });
    signIn.resolve({ success: true });
    await started;
    // Signed in, it still waits for this computer's cloud key.
    expect(pending()).toEqual({ organizationId: null, from });
  });

  it("is dropped when the sign-in does not complete, or fails", async () => {
    await startCloudSignIn(async () => ({ success: false }), from);
    expect(pending()).toBeNull();
    await startCloudSignIn(
      () => Promise.reject(new Error("Deus Cloud sign-in was cancelled")),
      from
    );
    expect(pending()).toBeNull();
  });

  it("moves the window to the cloud once the pushed value says it is reachable, once", async () => {
    await startCloudSignIn(async () => ({ success: true }), from);
    const switchTo = vi.fn();
    finishCloudSignIn(now(signedOut, "setting-up"), switchTo);
    finishCloudSignIn(now(listed({ acme: false }, false), "setting-up"), switchTo);
    finishCloudSignIn(now(undefined, "ready"), switchTo);
    expect(switchTo).not.toHaveBeenCalled();
    expect(pending()).not.toBeNull();

    finishCloudSignIn(now(listed({ acme: true }), "ready"), switchTo);
    finishCloudSignIn(now(listed({ acme: true }), "ready"), switchTo);
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith({ location: "cloud", organizationId: null });
    expect(pending()).toBeNull();
  });

  it("ends when the setup failed: nothing running will reach the cloud", async () => {
    await startCloudSignIn(async () => ({ success: true }), from);
    const switchTo = vi.fn();
    finishCloudSignIn(now(signedOut, "retry"), switchTo);
    expect(pending()).toBeNull();
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("does not move a window no sign-in was started from", () => {
    const switchTo = vi.fn();
    finishCloudSignIn(now(listed({ acme: true }), "ready"), switchTo);
    expect(switchTo).not.toHaveBeenCalled();
  });
});

describe("Set up (or Retry) from the location menu", () => {
  it("records the same intent, together with the running setup", async () => {
    const retry = deferred<{ ok: boolean }>();
    const started = retryCloudSetup(() => retry.promise, "beta", { from });
    expect([pending(), retrying()]).toEqual([{ organizationId: "beta", from }, true]);
    retry.resolve({ ok: true });
    await started;
    // Made, it waits for the organization to be ready to move the window.
    expect([pending(), retrying()]).toEqual([{ organizationId: "beta", from }, false]);
  });

  it("moves the window to that organization once it is ready, while the person stayed put", async () => {
    const retry = deferred<{ ok: boolean }>();
    const started = retryCloudSetup(() => retry.promise, "beta", { from });
    const switchTo = vi.fn();
    // Running: Beta is not ready yet.
    finishCloudSignIn(now(listed({ acme: true, beta: false }), "ready"), switchTo);
    expect(switchTo).not.toHaveBeenCalled();
    expect(pending()).not.toBeNull();
    // Its keys are pushed (and Beta is ready) before the setup's own answer.
    finishCloudSignIn(now(listed({ acme: true, beta: true }), "ready"), switchTo);
    retry.resolve({ ok: true });
    await started;
    expect(switchTo).toHaveBeenCalledWith({ location: "cloud", organizationId: "beta" });
    expect(pending()).toBeNull();
  });

  describe("does not move the window later once it no longer applies", () => {
    /** A setup of Beta that returned ok while Beta is not ready yet. */
    const setUpBeta = async () => {
      await retryCloudSetup(async () => ({ ok: true }), "beta", { from });
      expect(pending()).toEqual({ organizationId: "beta", from });
    };
    const betaLater = listed({ acme: true, beta: true });

    it("after a manual switch", async () => {
      await setUpBeta();
      const switchTo = vi.fn();
      finishCloudSignIn(
        now(listed({ acme: true, beta: false }), "ready", {
          place: "cloud:acme",
          selectedId: null,
        }),
        switchTo
      );
      finishCloudSignIn(now(betaLater, "ready"), switchTo);
      expect(switchTo).not.toHaveBeenCalled();
      expect(pending()).toBeNull();
    });

    it("after another workspace is selected", async () => {
      await setUpBeta();
      const switchTo = vi.fn();
      const elsewhere = { place: "local", selectedId: "w2" };
      finishCloudSignIn(now(undefined, "ready", elsewhere), switchTo);
      finishCloudSignIn(now(betaLater, "ready", elsewhere), switchTo);
      expect(switchTo).not.toHaveBeenCalled();
      expect(pending()).toBeNull();
    });

    it("after a sign-out", async () => {
      await setUpBeta();
      const switchTo = vi.fn();
      finishCloudSignIn(now(signedOut, "sign-in"), switchTo);
      finishCloudSignIn(now(betaLater, "ready"), switchTo);
      expect(switchTo).not.toHaveBeenCalled();
      expect(pending()).toBeNull();
    });

    it("after the organization leaves the list", async () => {
      await setUpBeta();
      const switchTo = vi.fn();
      finishCloudSignIn(now(listed({ acme: true }), "ready"), switchTo);
      finishCloudSignIn(now(betaLater, "ready"), switchTo);
      expect(switchTo).not.toHaveBeenCalled();
      expect(pending()).toBeNull();
    });

    it("after the setup is over and the organization is back to Set up", async () => {
      await setUpBeta();
      const switchTo = vi.fn();
      finishCloudSignIn(now(listed({ acme: true, beta: false }), "ready"), switchTo);
      finishCloudSignIn(now(betaLater, "ready"), switchTo);
      expect(switchTo).not.toHaveBeenCalled();
      expect(pending()).toBeNull();
    });
  });

  it("from the composer runs the same setup but never moves the window", async () => {
    const retry = deferred<{ ok: boolean }>();
    const started = retryCloudSetup(() => retry.promise, "beta");
    expect([pending(), retrying()]).toEqual([null, true]);
    retry.resolve({ ok: true });
    await started;
    expect([pending(), retrying()]).toEqual([null, false]);
    // A sign-in pending elsewhere is left alone, even by a setup that fails.
    useSidebarStore.setState({ cloudPending: { organizationId: null, from } });
    await retryCloudSetup(async () => ({ ok: false }), "beta");
    expect(pending()).toEqual({ organizationId: null, from });
  });

  it("ends the intent when the setup fails", async () => {
    const result = await retryCloudSetup(async () => ({ ok: false, error: "Mint failed" }), null, {
      from,
    });
    expect(result).toEqual({ ok: false, error: "Mint failed" });
    expect([pending(), retrying()]).toEqual([null, false]);
    expect(
      (await retryCloudSetup(() => Promise.reject(new Error("IPC closed")), null, { from })).ok
    ).toBe(false);
    expect([pending(), retrying()]).toEqual([null, false]);
  });
});
