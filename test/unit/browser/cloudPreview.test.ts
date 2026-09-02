import { describe, it, expect } from "vitest";
import {
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

  it("refuses an invalid port", () => {
    expect(resolveCloudPreviewUrl(template, 0)).toBeNull();
    expect(resolveCloudPreviewUrl(template, 70000)).toBeNull();
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
