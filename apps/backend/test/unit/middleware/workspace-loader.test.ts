import { describe, it, expect } from "vitest";
import { computeWorkspacePath } from "../../../src/middleware/workspace-loader";

describe("computeWorkspacePath", () => {
  it("returns .deus path from root_path and slug", () => {
    expect(
      computeWorkspacePath({
        root_path: "/repo",
        slug: "tokyo",
      })
    ).toBe("/repo/.deus/tokyo");
  });

  it("returns empty string when root_path is missing", () => {
    expect(
      computeWorkspacePath({
        slug: "tokyo",
      })
    ).toBe("");
  });

  it("returns empty string when slug is missing", () => {
    expect(
      computeWorkspacePath({
        root_path: "/repo",
      })
    ).toBe("");
  });
});
