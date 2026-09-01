import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pickCloudDirectTokenSource } from "@/features/session/cloud/cloudDirectToken";
import {
  captureCloudSessionFromFragment,
  readWebCloudSessionBearer,
  isCloudDirectWebMode,
  clearWebCloudSession,
  redirectToWebCloudLogin,
  ensureWebCloudSession,
} from "@/features/session/cloud/webCloudDirectConfig";
import { isCloudDirectEnabled } from "@/features/session/cloud/cloudDirectFlag";

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

beforeEach(() => {
  vi.stubGlobal("localStorage", makeStorage());
  vi.stubGlobal("sessionStorage", makeStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("pickCloudDirectTokenSource", () => {
  it("defaults to the backend seam (a backed build)", () => {
    expect(pickCloudDirectTokenSource()).toBe("backend");
  });

  it("uses the WorkOS web source in a fully Mac-closed web build", () => {
    vi.stubEnv("VITE_CLOUD_DIRECT", "1");
    expect(pickCloudDirectTokenSource()).toBe("workos-web");
  });

  it("honors the localStorage override over the deployment default", () => {
    localStorage.setItem("deus.cloudDirectTokenSource", "workos-desktop");
    expect(pickCloudDirectTokenSource()).toBe("workos-desktop");
    // The override wins even when the build would otherwise pick web.
    vi.stubEnv("VITE_CLOUD_DIRECT", "1");
    expect(pickCloudDirectTokenSource()).toBe("workos-desktop");
  });

  it("ignores a garbage override value", () => {
    localStorage.setItem("deus.cloudDirectTokenSource", "nonsense");
    expect(pickCloudDirectTokenSource()).toBe("backend");
  });
});

describe("isCloudDirectEnabled", () => {
  it("is off by default, on for the dev flag, and IMPLIED by web-direct mode", () => {
    expect(isCloudDirectEnabled()).toBe(false);
    localStorage.setItem("deus.cloudDirect", "1");
    expect(isCloudDirectEnabled()).toBe(true);

    // Web-direct is direct by definition, without needing the render flag set —
    // the bug that left the fully Mac-closed build inert.
    localStorage.removeItem("deus.cloudDirect");
    expect(isCloudDirectEnabled()).toBe(false);
    vi.stubEnv("VITE_CLOUD_DIRECT", "1");
    expect(isCloudDirectEnabled()).toBe(true);
  });
});

describe("isCloudDirectWebMode", () => {
  it("is off by default and on for VITE_CLOUD_DIRECT=1/true", () => {
    expect(isCloudDirectWebMode()).toBe(false);
    vi.stubEnv("VITE_CLOUD_DIRECT", "true");
    expect(isCloudDirectWebMode()).toBe(true);
  });

  it("localStorage override forces the mode on/off over the build flag", () => {
    localStorage.setItem("deus.cloudDirectWeb", "1");
    expect(isCloudDirectWebMode()).toBe(true);
    // Override to OFF beats a build flag that says on.
    localStorage.setItem("deus.cloudDirectWeb", "0");
    vi.stubEnv("VITE_CLOUD_DIRECT", "1");
    expect(isCloudDirectWebMode()).toBe(false);
  });

  it("a relay entry path vetoes web-direct on a production web build", () => {
    vi.stubEnv("VITE_CLOUD_DIRECT", "1");
    vi.stubGlobal("window", {
      location: { pathname: "/s/some-server" },
    } as unknown as Window & typeof globalThis);
    expect(isCloudDirectWebMode()).toBe(false);

    (window as unknown as { location: { pathname: string } }).location.pathname =
      "/connect/some-server";
    expect(isCloudDirectWebMode()).toBe(false);

    // Product paths keep the mode on.
    (window as unknown as { location: { pathname: string } }).location.pathname = "/w/abc";
    expect(isCloudDirectWebMode()).toBe(true);
  });

  it("web-dev (VITE_BACKEND_PORT) exempts the synthetic /s/local path from the veto", () => {
    vi.stubEnv("VITE_BACKEND_PORT", "49770");
    localStorage.setItem("deus.cloudDirectWeb", "1");
    vi.stubGlobal("window", {
      location: { pathname: "/s/local" },
    } as unknown as Window & typeof globalThis);
    // The localhost test rig lives under /s/local — the override must still work.
    expect(isCloudDirectWebMode()).toBe(true);
  });
});

describe("captureCloudSessionFromFragment", () => {
  it("captures a #token= bearer, stores it, and scrubs the fragment", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { hash: "#token=abc.def.ghi", pathname: "/callback", search: "" },
      history: { replaceState },
    } as unknown as Window & typeof globalThis);

    expect(captureCloudSessionFromFragment()).toBe(true);
    expect(sessionStorage.getItem("deus_cloud_session")).toBe("abc.def.ghi");
    // The credential is scrubbed from the address bar / history entry.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/callback");
  });

  it("is a no-op when there is no token fragment", () => {
    vi.stubGlobal("window", {
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState: vi.fn() },
    } as unknown as Window & typeof globalThis);
    expect(captureCloudSessionFromFragment()).toBe(false);
    expect(sessionStorage.getItem("deus_cloud_session")).toBeNull();
  });
});

describe("readWebCloudSessionBearer / clearWebCloudSession", () => {
  it("round-trips the stored bearer and clears it", async () => {
    expect(await readWebCloudSessionBearer()).toBeNull();
    sessionStorage.setItem("deus_cloud_session", "the.jwt.here");
    expect(await readWebCloudSessionBearer()).toBe("the.jwt.here");
    clearWebCloudSession();
    expect(await readWebCloudSessionBearer()).toBeNull();
  });
});

describe("redirectToWebCloudLogin (loop guard)", () => {
  function stubLocation() {
    const loc = { href: "", origin: "https://app.deusmachine.ai", pathname: "/", search: "" };
    vi.stubGlobal("window", { location: loc } as unknown as Window & typeof globalThis);
    return loc;
  }

  it("redirects to the deus-web login once, then holds off within the cooldown", () => {
    const loc = stubLocation();
    expect(redirectToWebCloudLogin("/w/x")).toBe(true);
    expect(loc.href).toContain("cloud.deusmachine.ai/auth/login?client=deus-web");
    expect(loc.href).toContain(encodeURIComponent("https://app.deusmachine.ai/w/x"));

    // A second call right away is the loop-guard case: no redirect.
    loc.href = "";
    expect(redirectToWebCloudLogin("/w/x")).toBe(false);
    expect(loc.href).toBe("");
  });
});

describe("ensureWebCloudSession (boot gate)", () => {
  it("is a no-op on a backed build (not web-direct)", () => {
    vi.stubGlobal("window", {
      location: { href: "", origin: "https://x", pathname: "/", search: "" },
    } as unknown as Window & typeof globalThis);
    ensureWebCloudSession();
    expect((window as unknown as { location: { href: string } }).location.href).toBe("");
  });

  it("redirects to login when web-direct with no bearer, and holds when signed in", () => {
    vi.stubEnv("VITE_CLOUD_DIRECT", "1");
    const loc = { href: "", origin: "https://app.deusmachine.ai", pathname: "/", search: "" };
    vi.stubGlobal("window", { location: loc } as unknown as Window & typeof globalThis);

    ensureWebCloudSession(); // no bearer → redirect
    expect(loc.href).toContain("/auth/login");

    // With a bearer, no redirect (and the guard is reset).
    loc.href = "";
    sessionStorage.setItem("deus_cloud_session", "b");
    ensureWebCloudSession();
    expect(loc.href).toBe("");
  });
});
