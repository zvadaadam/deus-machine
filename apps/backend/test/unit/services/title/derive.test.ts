import { describe, expect, it } from "vitest";

import { deriveSessionTitle, isUsableSessionTitle } from "../../../../src/services/title/derive";

describe("deriveSessionTitle", () => {
  it("uses plain text content", () => {
    expect(deriveSessionTitle("Fix the login page spacing")).toBe("Fix the login page spacing");
  });

  it("extracts text from structured content blocks and ignores images", () => {
    const content = JSON.stringify([
      { type: "text", text: "Please fix this card layout" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ]);

    expect(deriveSessionTitle(content)).toBe("Please fix this card layout");
  });

  it("returns null for image-only content", () => {
    const content = JSON.stringify([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ]);

    expect(deriveSessionTitle(content)).toBeNull();
  });

  it("strips staged mention noise", () => {
    expect(deriveSessionTitle("/frontend-developer @src/app.tsx polish the mobile nav")).toBe(
      "polish the mobile nav"
    );
  });

  it("rejects the old SDK fallback", () => {
    expect(deriveSessionTitle("(session)")).toBeNull();
    expect(isUsableSessionTitle("(session)")).toBe(false);
  });
});
