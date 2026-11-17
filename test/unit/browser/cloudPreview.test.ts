import { describe, it, expect } from "vitest";
import {
  cloudPreviewAddress,
  normalizePreviewPort,
  resolveCloudPreviewUrl,
  DEFAULT_CLOUD_PREVIEW_PORT,
} from "@/features/browser/lib/cloudPreview";

describe("cloud preview URL", () => {
  const template = "https://{{port}}-i9a1b2c3d4e5.e2b.app";

  it("substitutes the port into agnt's host template", () => {
    expect(resolveCloudPreviewUrl(template, 3000)).toBe("https://3000-i9a1b2c3d4e5.e2b.app");
    expect(resolveCloudPreviewUrl(template, 5173)).toBe("https://5173-i9a1b2c3d4e5.e2b.app");
  });

  it("refuses a template without the placeholder (a bare host would preview the wrong port)", () => {
    expect(resolveCloudPreviewUrl("https://sidecar-i9a1.e2b.app", 3000)).toBeNull();
    expect(resolveCloudPreviewUrl(null, 3000)).toBeNull();
    expect(resolveCloudPreviewUrl(undefined, 3000)).toBeNull();
  });

  it("puts an address's path, query and fragment on the template's host", () => {
    expect(resolveCloudPreviewUrl(template, 5173, "/dash?a=1#top")).toBe(
      "https://5173-i9a1b2c3d4e5.e2b.app/dash?a=1#top"
    );
    expect(resolveCloudPreviewUrl(template, 3000, "/")).toBe("https://3000-i9a1b2c3d4e5.e2b.app/");
    // The same rest on a replaced computer's template is the new computer's page.
    expect(resolveCloudPreviewUrl("https://{{port}}-new.e2b.app", 5173, "/dash?a=1")).toBe(
      "https://5173-new.e2b.app/dash?a=1"
    );
  });

  it("never lets the rest name a host", () => {
    expect(resolveCloudPreviewUrl(template, 3000, "//elsewhere.test/x")).toBe(
      "https://3000-i9a1b2c3d4e5.e2b.app//elsewhere.test/x"
    );
    expect(resolveCloudPreviewUrl(null, 3000, "/a")).toBeNull();
  });

  it("refuses an invalid port", () => {
    expect(resolveCloudPreviewUrl(template, 0)).toBeNull();
    expect(resolveCloudPreviewUrl(template, 70000)).toBeNull();
  });
});

describe("the preview's address after a link from the chat", () => {
  const fromChat = { port: 5173, rest: "/dash?a=1" };

  it("keeps the chat's path on the current computer's host", () => {
    expect(cloudPreviewAddress("https://{{port}}-old.e2b.app", 5173, fromChat)).toBe(
      "https://5173-old.e2b.app/dash?a=1"
    );
    // The computer was replaced: the same request is the new sandbox's page.
    expect(cloudPreviewAddress("https://{{port}}-new.e2b.app", 5173, fromChat)).toBe(
      "https://5173-new.e2b.app/dash?a=1"
    );
  });

  it("drops the path once a port is chosen by hand", () => {
    // Another port: the chat's path was for its own port only.
    expect(cloudPreviewAddress("https://{{port}}-new.e2b.app", 3000, fromChat)).toBe(
      "https://3000-new.e2b.app"
    );
    // Choosing a port clears what the chat asked for, even the same port.
    expect(cloudPreviewAddress("https://{{port}}-new.e2b.app", 5173, null)).toBe(
      "https://5173-new.e2b.app"
    );
  });
});

describe("normalizePreviewPort", () => {
  it("parses strings and numbers within the TCP range", () => {
    expect(normalizePreviewPort(" 5173 ")).toBe(5173);
    expect(normalizePreviewPort(8080)).toBe(8080);
    expect(normalizePreviewPort("abc")).toBeNull();
    // Partial numbers must not navigate to a different port than typed.
    expect(normalizePreviewPort("3000abc")).toBeNull();
    expect(normalizePreviewPort("5173.5")).toBeNull();
    expect(normalizePreviewPort("1e3")).toBeNull();
    expect(normalizePreviewPort("65536")).toBeNull();
    expect(normalizePreviewPort("-1")).toBeNull();
    expect(DEFAULT_CLOUD_PREVIEW_PORT).toBe(3000);
  });
});
