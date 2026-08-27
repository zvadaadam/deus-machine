import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockRequestCloudFs, mockWithWorkspace, cloudWorkspace } = vi.hoisted(() => {
  const cloudWorkspace: Record<string, unknown> = {
    id: "ws-cloud-1",
    kind: "cloud",
    current_session_id: "sess-cloud-1",
  };
  return {
    cloudWorkspace,
    mockRequestCloudFs: vi.fn(),
    mockWithWorkspace: vi.fn((c: any, next: any) => {
      c.set("workspace", cloudWorkspace);
      c.set("workspacePath", "");
      return next();
    }),
  };
});

vi.mock("../../../src/services/agent/cloud/driver", () => ({
  requestCloudFs: mockRequestCloudFs,
}));

vi.mock("../../../src/middleware/workspace-loader", () => ({
  withWorkspace: mockWithWorkspace,
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: vi.fn() }));
vi.mock("../../../src/db", () => ({ getWorkspaceForMiddleware: vi.fn() }));

import filesRoutes from "../../../src/routes/files";
import { errorHandler } from "../../../src/middleware/error-handler";

const app = new Hono();
app.route("/", filesRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
  cloudWorkspace.current_session_id = "sess-cloud-1";
});

describe("cloud files routes", () => {
  it("tree returns an empty listing (not an error panel) while provisioning", async () => {
    cloudWorkspace.current_session_id = null;

    const res = await app.request("/workspaces/ws-cloud-1/files");
    const body = (await res.json()) as { files: unknown[]; provisioning?: boolean };

    expect(res.status).toBe(200);
    expect(body.files).toEqual([]);
    expect(body.provisioning).toBe(true);
    expect(mockRequestCloudFs).not.toHaveBeenCalled();
  });

  it("invalidate-cache clears the cloud tree cache so mentions don't go stale", async () => {
    cloudWorkspace.current_session_id = "sess-invalidate";
    mockRequestCloudFs.mockResolvedValue({ tree: [{ name: "a.ts", path: "a.ts", type: "file" }] });
    // warm the search cache
    await app.request("/workspaces/ws-cloud-1/files/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "a" }),
    });
    await app.request("/workspaces/ws-cloud-1/files/invalidate-cache", { method: "POST" });
    mockRequestCloudFs.mockClear();
    // a fresh search must re-list (cache was cleared), not serve the stale set
    await app.request("/workspaces/ws-cloud-1/files/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "a" }),
    });
    expect(mockRequestCloudFs).toHaveBeenCalledTimes(1);
  });

  it("tree maps FsNode → local shape and carries the truncation flag", async () => {
    mockRequestCloudFs.mockResolvedValue({
      tree: [
        {
          name: "src",
          path: "src",
          type: "dir",
          children: [{ name: "a.ts", path: "src/a.ts", type: "file", size: 5 }],
        },
      ],
      truncated: true,
    });

    const res = await app.request("/workspaces/ws-cloud-1/files");
    const body = (await res.json()) as {
      files: Array<{ type: string; children?: unknown[] }>;
      totalFiles: number;
      truncated: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.files[0].type).toBe("directory");
    expect(body.totalFiles).toBe(1);
    expect(body.truncated).toBe(true);
  });

  it("read refuses traversal before any sandbox round-trip", async () => {
    const res = await app.request(
      "/workspaces/ws-cloud-1/file-content?path=" + encodeURIComponent("../../etc/passwd")
    );

    expect(res.status).toBe(400);
    expect(mockRequestCloudFs).not.toHaveBeenCalled();
  });

  it("a sandbox timeout surfaces as an instruction, not a 500", async () => {
    mockRequestCloudFs.mockRejectedValue(new Error("cloud fs request timed out"));

    const res = await app.request("/workspaces/ws-cloud-1/file-content?path=README.md");

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/waking|shortly/i);
  });

  it("search caches the flattened tree across keystrokes", async () => {
    cloudWorkspace.current_session_id = "sess-search-cache";
    mockRequestCloudFs.mockResolvedValue({
      tree: [{ name: "alpha.ts", path: "alpha.ts", type: "file" }],
    });

    const search = (q: string) =>
      app.request("/workspaces/ws-cloud-1/files/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
    const first = await search("al");
    const second = await search("alp");

    expect(first.status).toBe(200);
    expect(((await second.json()) as Array<{ path: string }>)[0]?.path).toBe("alpha.ts");
    expect(mockRequestCloudFs).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent searches during the first list into one round-trip", async () => {
    cloudWorkspace.current_session_id = "sess-single-flight";
    let resolveList!: (v: unknown) => void;
    const listPromise = new Promise((res) => {
      resolveList = res;
    });
    mockRequestCloudFs.mockReturnValue(listPromise);

    const search = (q: string) =>
      app.request("/workspaces/ws-cloud-1/files/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
    // three keystrokes land while the first (slow) list is still in flight
    const all = Promise.all([search("a"), search("ab"), search("abc")]);
    await new Promise((r) => setTimeout(r, 0)); // let all three reach the shared await
    resolveList({ tree: [{ name: "alpha.ts", path: "alpha.ts", type: "file" }] });
    await all;

    // one shared sandbox list, not one per keystroke
    expect(mockRequestCloudFs).toHaveBeenCalledTimes(1);
    mockRequestCloudFs.mockReset();
  });
});
