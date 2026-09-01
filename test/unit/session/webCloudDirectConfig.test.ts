import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ensureWebCloudSession,
  handleWebCloudSessionExpired,
  readWebCloudSessionBearer,
  redirectToWebCloudLogin,
} from "@/features/session/cloud/webCloudDirectConfig";

// Minimal Map-backed Web Storage stand-ins (the suite runs node-env, no DOM).
function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

const APP_URL = "https://deusmachine.ai/w/sess_1";
const win = () => (globalThis as unknown as { window: { location: { href: string } } }).window;

beforeEach(() => {
  vi.stubGlobal("localStorage", makeStorage());
  vi.stubGlobal("sessionStorage", makeStorage());
  // Just enough window for the login redirect (`location.href` assignment).
  vi.stubGlobal("window", {
    location: {
      href: APP_URL,
      origin: "https://deusmachine.ai",
      pathname: "/w/sess_1",
      search: "",
      hash: "",
    },
    history: { replaceState: () => {} },
  });
  vi.stubEnv("VITE_CLOUD_DIRECT", "1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("login loop guard", () => {
  it("a bearer that came back from login and is rejected by agnt does not bounce to login again", async () => {
    // Boot without a bearer: off to sign in.
    expect(redirectToWebCloudLogin()).toBe(true);
    expect(win().location.href).toContain("/auth/login?client=deus-web");

    // The callback hands a token back and the app boots again with it.
    win().location.href = APP_URL;
    sessionStorage.setItem("deus_cloud_session", "fresh.bearer.jwt");
    ensureWebCloudSession();
    expect(win().location.href).toBe(APP_URL);

    // agnt answers 401 to that fresh bearer: drop it and STAY — a redirect
    // here is the login→token→401→login loop.
    handleWebCloudSessionExpired();
    expect(await readWebCloudSessionBearer()).toBeNull();
    expect(win().location.href).toBe(APP_URL);
  });

  it("an ordinary expiry (no recent login) re-authenticates", async () => {
    sessionStorage.setItem("deus_cloud_session", "old.bearer.jwt");
    handleWebCloudSessionExpired();
    expect(await readWebCloudSessionBearer()).toBeNull();
    expect(win().location.href).toContain("/auth/login?client=deus-web");
  });
});
