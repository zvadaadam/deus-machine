import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercises useAutoUpdate's actual state/listener/check logic; only React's
// mounting layer, the platform capability, the Electron bridge and
// localStorage are replaced. The hook is invoked directly (no DOM renderer is
// available in this repo's node-only vitest config), mirroring the
// useSessionActions / cloudDirectSession test pattern.
const { effects, setState, isDownloadingRef, caps } = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  setState: vi.fn(),
  isDownloadingRef: { current: false },
  caps: { autoUpdate: true },
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // Capture effects so tests can replay them in order; return the callback
  // directly from useCallback so check() is directly callable.
  useEffect: (effect: () => void | (() => void)) => {
    effects.push(effect);
  },
  useState: <T>(initial: T) => [initial, setState] as [T, typeof setState],
  useRef: <T>(_initial: T) => isDownloadingRef as unknown as { current: T },
  useCallback: <T>(callback: T) => callback,
}));

vi.mock("@/platform/capabilities", () => ({ capabilities: caps }));

import { useAutoUpdate } from "@/features/updates/hooks/useAutoUpdate";

const PENDING_VERSION_KEY = "pendingUpdateVersion";

let store: Map<string, string>;
let localStorage: {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
};
let electronAPI: {
  onUpdateState: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
};
let hook: ReturnType<typeof useAutoUpdate>;

beforeEach(() => {
  effects.length = 0;
  vi.clearAllMocks();
  isDownloadingRef.current = false;
  caps.autoUpdate = true;

  store = new Map();
  localStorage = {
    getItem: vi.fn((k: string) => store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => {
      store.set(k, String(v));
    }),
    removeItem: vi.fn((k: string) => {
      store.delete(k);
    }),
    clear: vi.fn(() => store.clear()),
  };
  electronAPI = {
    onUpdateState: vi.fn((cb: (state: unknown) => void) => () => {
      void cb;
    }),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
  };

  vi.stubGlobal("window", { electronAPI });
  vi.stubGlobal("localStorage", localStorage);
  vi.spyOn(console, "error").mockImplementation(() => {});

  // Invoke the hook once so effects are captured (in order) and check is
  // directly callable. Effects are replayed selectively per test.
  hook = useAutoUpdate();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function registerListener(): (state: unknown) => void {
  // effects[1] is the onUpdateState registration effect.
  effects[1]();
  return electronAPI.onUpdateState.mock.calls[0][0] as (state: unknown) => void;
}

describe("useAutoUpdate onUpdateState listener", () => {
  it("does NOT persist the pending version when an update is reported ready", () => {
    const listener = registerListener();

    listener({ stage: "ready", version: "1.2.3", releaseNotes: "Bug fixes" });

    // The bug previously wrote localStorage.pendingUpdateVersion here, which
    // suppressed downloads for a not-yet-downloaded update.
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(store.get(PENDING_VERSION_KEY)).toBeUndefined();
  });

  it("still surfaces the ready state to the UI and resets the download race-guard", () => {
    const listener = registerListener();
    isDownloadingRef.current = true;

    listener({ stage: "ready", version: "1.2.3", releaseNotes: "Bug fixes" });

    // Removing the setItem must not also drop the setState or the race-guard
    // reset — the genuine-download flow still depends on both.
    expect(setState).toHaveBeenCalledWith({
      stage: "ready",
      version: "1.2.3",
      releaseNotes: "Bug fixes",
    });
    expect(isDownloadingRef.current).toBe(false);
  });
});

describe("useAutoUpdate check()", () => {
  it("persists the pending version only after the download resolves", async () => {
    const { check } = hook;
    electronAPI.checkForUpdates.mockResolvedValueOnce({
      available: true,
      version: "1.2.3",
      releaseNotes: "Bug fixes",
    });
    electronAPI.downloadUpdate.mockResolvedValueOnce(undefined);

    await check();

    expect(electronAPI.downloadUpdate).toHaveBeenCalledOnce();
    expect(localStorage.setItem).toHaveBeenCalledOnce();
    expect(localStorage.setItem).toHaveBeenCalledWith(PENDING_VERSION_KEY, "1.2.3");
    expect(store.get(PENDING_VERSION_KEY)).toBe("1.2.3");

    // The pending version must be recorded AFTER downloadUpdate resolves, not
    // before, so a failure mid-download can't suppress a retry.
    const downloadOrder = electronAPI.downloadUpdate.mock.invocationCallOrder[0];
    const setItemOrder = localStorage.setItem.mock.invocationCallOrder[0];
    expect(setItemOrder).toBeGreaterThan(downloadOrder);
  });

  it("does not persist the pending version when the download fails", async () => {
    const { check } = hook;
    electronAPI.checkForUpdates.mockResolvedValueOnce({
      available: true,
      version: "1.2.3",
      releaseNotes: "Bug fixes",
    });
    electronAPI.downloadUpdate.mockRejectedValueOnce(new Error("network down"));

    await check();

    expect(electronAPI.downloadUpdate).toHaveBeenCalledOnce();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(store.has(PENDING_VERSION_KEY)).toBe(false);
    expect(setState).toHaveBeenCalledWith({
      stage: "error",
      error: "network down",
    });
  });

  it("skips re-download when the version is already staged (pending version matches)", async () => {
    const { check } = hook;
    store.set(PENDING_VERSION_KEY, "1.2.3");
    electronAPI.checkForUpdates.mockResolvedValueOnce({
      available: true,
      version: "1.2.3",
      releaseNotes: "Bug fixes",
    });

    await check();

    // The dedup branch is intentional: an already-staged version should not be
    // re-downloaded. Don't over-correct the fix by removing it.
    expect(electronAPI.downloadUpdate).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(setState).toHaveBeenCalledWith({
      stage: "ready",
      version: "1.2.3",
      releaseNotes: "Bug fixes",
    });
    expect(store.get(PENDING_VERSION_KEY)).toBe("1.2.3");
  });

  it("still downloads after a spurious 'ready' push (defense-in-depth)", async () => {
    // Even if a future main-process regression pushes stage:"ready" on
    // detection, the listener must not have suppressed the download.
    const { check } = hook;
    const listener = registerListener();
    listener({ stage: "ready", version: "1.2.3", releaseNotes: "Bug fixes" });
    expect(store.has(PENDING_VERSION_KEY)).toBe(false);

    electronAPI.checkForUpdates.mockResolvedValueOnce({
      available: true,
      version: "1.2.3",
      releaseNotes: "Bug fixes",
    });
    electronAPI.downloadUpdate.mockResolvedValueOnce(undefined);

    await check();

    expect(electronAPI.downloadUpdate).toHaveBeenCalledOnce();
    expect(store.get(PENDING_VERSION_KEY)).toBe("1.2.3");
  });
});
