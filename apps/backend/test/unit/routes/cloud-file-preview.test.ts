import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockWithWorkspace } = vi.hoisted(() => {
  // Mirror the real withWorkspace middleware for a cloud workspace:
  // kind === "cloud" → computeWorkspacePath returns "" (empty), and the
  // contract is that local-FS routes must gate on kind themselves.
  const cloudWorkspace: Record<string, unknown> = {
    id: "ws-cloud",
    kind: "cloud",
    current_session_id: "sess-cloud",
  };
  return {
    mockWithWorkspace: vi.fn((c: any, next: any) => {
      c.set("workspace", cloudWorkspace);
      c.set("workspacePath", "");
      return next();
    }),
  };
});

vi.mock("../../../src/services/agent/cloud/driver", () => ({
  requestCloudFs: vi.fn(),
  getCloudIdentityGeneration: () => 0,
}));
vi.mock("../../../src/middleware/workspace-loader", () => ({ withWorkspace: mockWithWorkspace }));
vi.mock("../../../src/lib/database", () => ({ getDatabase: vi.fn() }));
vi.mock("../../../src/db", () => ({ getWorkspaceForMiddleware: vi.fn() }));

// fs is intentionally left real: file-preview's vulnerability was that it fed
// the cloud workspace's empty workspacePath into path.resolve/realpathSync,
// silently anchoring containment to process.cwd(). Keeping fs real makes this
// test fail loudly if the route's cloud guard is dropped and the route starts
// resolving files under the backend's working directory.

import filesRoutes from "../../../src/routes/files";
import { errorHandler } from "../../../src/middleware/error-handler";
import * as fs from "fs";
import * as path from "path";

const app = new Hono();
app.route("/", filesRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /workspaces/:id/file-preview (cloud)", () => {
  it("rejects a cloud workspace with 404 before any path resolution (local-only contract)", async () => {
    // A real allowlisted-ext file lives under the backend's cwd, so a buggy
    // route would resolve it via path.resolve("", rel) → cwd/rel and stream it.
    expect(fs.existsSync(path.resolve(process.cwd(), "apps/web/index.html"))).toBe(true);

    const res = await app.request(
      `/workspaces/ws-cloud/file-preview?path=${encodeURIComponent("apps/web/index.html")}`
    );

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toMatch(/<!doctype html>/i);
    expect(body).toMatch(/not available for cloud workspaces/i);
  });

  it("rejects cloud before path validation for every path shape", async () => {
    // Guards the ordering: the kind gate must fire before path validation,
    // otherwise cloud requests get 400 "Invalid file path"/"path parameter is
    // required" instead of the 404 "not available for cloud workspaces" contract.
    for (const qs of [
      `?path=${encodeURIComponent("../../etc/passwd")}`,
      `?path=${encodeURIComponent("/etc/passwd")}`,
      ``,
    ]) {
      const res = await app.request(`/workspaces/ws-cloud/file-preview${qs}`);
      expect(res.status).toBe(404);
    }
  });
});
