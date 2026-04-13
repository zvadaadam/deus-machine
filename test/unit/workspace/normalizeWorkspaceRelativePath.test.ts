import { describe, expect, it } from "vitest";
import { normalizeWorkspaceRelativePath } from "@/features/workspace/lib/normalizeWorkspaceRelativePath";

describe("normalizeWorkspaceRelativePath", () => {
  it("normalizes safe relative paths", () => {
    expect(normalizeWorkspaceRelativePath("./src/demo.tsx")).toBe("src/demo.tsx");
    expect(normalizeWorkspaceRelativePath("src\\demo.tsx")).toBe("src/demo.tsx");
  });

  it("rejects traversal and malformed segments", () => {
    expect(normalizeWorkspaceRelativePath("../outside.ts")).toBeNull();
    expect(normalizeWorkspaceRelativePath("src/../outside.ts")).toBeNull();
    expect(normalizeWorkspaceRelativePath("src//demo.tsx")).toBeNull();
    expect(normalizeWorkspaceRelativePath("")).toBeNull();
  });
});
