import { describe, it, expect } from "vitest";
import {
  decideRootRequest,
  hasReturningUserMarker,
} from "../../../apps/landing/src/worker-routing";

describe("decideRootRequest (the deusmachine.ai edge split)", () => {
  it("serves the landing at '/' to a fresh browser, the app to a returning user", () => {
    expect(decideRootRequest("/", null)).toBe("landing");
    expect(decideRootRequest("/", "other=1")).toBe("landing");
    expect(decideRootRequest("/", "deus_user=1")).toBe("app");
    expect(decideRootRequest("/", "a=b; deus_user=1; c=d")).toBe("app");
    // A different cookie whose VALUE contains the marker must not match.
    expect(decideRootRequest("/", "not_deus_user=1")).toBe("landing");
  });

  it("keeps landing-owned assets and statics with the landing", () => {
    expect(decideRootRequest("/assets/main-Dvwqr5H-.js", null)).toBe("landing");
    expect(decideRootRequest("/favicon.svg", null)).toBe("landing");
    expect(decideRootRequest("/robots.txt", null)).toBe("landing");
    expect(decideRootRequest("/llms.txt", null)).toBe("landing");
    expect(decideRootRequest("/manifest.json", null)).toBe("landing");
    // Framework internals (server fns, dev/HMR surfaces).
    expect(decideRootRequest("/_server/anything", null)).toBe("landing");
    expect(decideRootRequest("/@vite/client", null)).toBe("landing");
  });

  it("routes the product — pages, app bundles, app statics — to the app", () => {
    expect(decideRootRequest("/w/01a0421e", "deus_user=1")).toBe("app");
    expect(decideRootRequest("/settings", null)).toBe("app");
    expect(decideRootRequest("/connect/some-server", null)).toBe("app");
    expect(decideRootRequest("/s/some-server", null)).toBe("app");
    expect(decideRootRequest("/app-assets/index-abc.js", null)).toBe("app");
    expect(decideRootRequest("/site.webmanifest", null)).toBe("app");
    expect(decideRootRequest("/apple-touch-icon.png", null)).toBe("app");
  });

  it("favicon.png collides on both sides — the landing's wins by rule", () => {
    expect(decideRootRequest("/favicon.png", "deus_user=1")).toBe("landing");
  });
});

describe("hasReturningUserMarker", () => {
  it("matches only an exact deus_user=1 cookie", () => {
    expect(hasReturningUserMarker(null)).toBe(false);
    expect(hasReturningUserMarker("")).toBe(false);
    expect(hasReturningUserMarker("deus_user=1")).toBe(true);
    expect(hasReturningUserMarker("x=1; deus_user=1")).toBe(true);
    expect(hasReturningUserMarker("deus_user=0")).toBe(false);
    expect(hasReturningUserMarker("xdeus_user=1")).toBe(false);
  });
});
