import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler";

const mockStmt = { get: vi.fn() };
const mockDb = { prepare: vi.fn(() => mockStmt) };

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn(() => mockDb),
}));

import { withWorkspace, computeWorkspacePath } from "../../../src/middleware/workspace-loader";

const createTestApp = () => {
  const app = new Hono();
  app.get("/test/:id", withWorkspace, (c) => {
    return c.json({
      workspace: c.get("workspace"),
      workspacePath: c.get("workspacePath"),
    });
  });
  app.onError(errorHandler);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue(mockStmt);
});

describe("withWorkspace middleware", () => {
  it("returns workspace data and computed path when found", async () => {
    mockStmt.get.mockReturnValue({
      id: "ws-1",
      root_path: "/repo",
      slug: "tokyo",
      default_branch: "main",
    });

    const app = createTestApp();
    const res = await app.request("/test/ws-1");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspace).toEqual({
      id: "ws-1",
      root_path: "/repo",
      slug: "tokyo",
      default_branch: "main",
    });
    expect(body.workspacePath).toBe("/repo/.opendevs/tokyo");
  });

  it("returns 404 when workspace is not found", async () => {
    mockStmt.get.mockReturnValue(undefined);

    const app = createTestApp();
    const res = await app.request("/test/missing");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Workspace not found");
  });

  it("returns 404 when root_path is null", async () => {
    mockStmt.get.mockReturnValue({
      id: "ws-1",
      root_path: null,
      slug: "tokyo",
    });

    const app = createTestApp();
    const res = await app.request("/test/ws-1");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Workspace not found");
  });

  it("returns 404 when slug is null", async () => {
    mockStmt.get.mockReturnValue({
      id: "ws-1",
      root_path: "/repo",
      slug: null,
    });

    const app = createTestApp();
    const res = await app.request("/test/ws-1");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Workspace not found");
  });

  it("queries database with the correct id parameter", async () => {
    mockStmt.get.mockReturnValue({
      id: "ws-42",
      root_path: "/projects",
      slug: "paris",
      default_branch: "develop",
    });

    const app = createTestApp();
    await app.request("/test/ws-42");

    expect(mockDb.prepare).toHaveBeenCalled();
    expect(mockStmt.get).toHaveBeenCalledWith("ws-42");
  });
});

describe("computeWorkspacePath", () => {
  it("returns .opendevs path from root_path and slug", () => {
    expect(
      computeWorkspacePath({
        root_path: "/repo",
        slug: "tokyo",
      })
    ).toBe("/repo/.opendevs/tokyo");
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
