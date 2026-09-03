import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isEmbeddableStreamUrl } from "@/features/simulator/cloud/cloudSimulatorStream";

// The rule compares against the renderer's origin; give it one that is itself
// https, so the same-origin case is isolated from the https rule.
beforeAll(() => vi.stubGlobal("window", { location: { origin: "https://app.deusmachine.test" } }));
afterAll(() => vi.unstubAllGlobals());

describe("isEmbeddableStreamUrl", () => {
  it("embeds https streams from another origin only", () => {
    expect(isEmbeddableStreamUrl("https://stream.expo.dev/eas-1?token=abc")).toBe(true);
    expect(isEmbeddableStreamUrl("http://stream.expo.dev/eas-1")).toBe(false);
    expect(isEmbeddableStreamUrl("javascript:alert(1)")).toBe(false);
    expect(isEmbeddableStreamUrl("not a url")).toBe(false);
  });

  it("refuses our own origin — a same-origin document could lift the frame's sandbox", () => {
    expect(isEmbeddableStreamUrl("https://app.deusmachine.test/stream")).toBe(false);
    expect(isEmbeddableStreamUrl("https://app.deusmachine.test:444/stream")).toBe(true);
  });
});
