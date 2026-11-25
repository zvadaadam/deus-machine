import { describe, it, expect, vi } from "vitest";
import { computeWorkspacePath, loadWorkspace } from "../../../src/middleware/workspace-loader";

const get = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => ({ prepare: () => ({ get }) }),
}));

describe("loadWorkspace", () => {
  const row = {
    id: "ws-42",
    kind: "worktree",
    root_path: "/repo",
    slug: "tokyo",
    start_recoverable: 1,
  };

  it("queries the requested id and returns the workspace and its checkout path", () => {
    get.mockReturnValueOnce(row);
    expect(loadWorkspace("ws-42")).toEqual({
      workspace: { ...row, start_recoverable: true },
      workspacePath: "/repo/.deus/tokyo",
    });
    expect(get).toHaveBeenLastCalledWith("ws-42");
  });

  it.each([
    { missing: "row", result: undefined },
    { missing: "checkout root", result: { ...row, root_path: null } },
    { missing: "slug", result: { ...row, slug: null } },
  ])("throws the same 404 for a missing $missing", ({ result }) => {
    get.mockReturnValueOnce(result);
    expect(() => loadWorkspace("ws-42")).toThrow(
      expect.objectContaining({ statusCode: 404, message: "Workspace not found" })
    );
  });
});

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
