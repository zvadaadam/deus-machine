import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Readable } from "stream";
import { errorHandler } from "../../../src/middleware/error-handler";
import { NotFoundError } from "../../../src/lib/errors";

// The preview route, the one workspace file read a browser makes by URL. The
// tree, text and search operations are tested in ../api/files.test.ts.

const { loadWorkspace } = vi.hoisted(() => ({
  loadWorkspace: vi.fn(() => ({
    workspace: { kind: "local" },
    workspacePath: "/repos/myrepo/.deus/test-ws",
  })),
}));
vi.mock("../../../src/middleware/workspace-loader", () => ({ loadWorkspace }));

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn(),
}));

vi.mock("../../../src/db", () => ({
  getWorkspaceForMiddleware: vi.fn(),
}));

const { mockExistsSync, mockRealpathSync, mockStatSync, mockCreateReadStream } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockRealpathSync: vi.fn((p: string) => p),
  mockStatSync: vi.fn(() => ({ isFile: (): boolean => true, size: 7 })),
  mockCreateReadStream: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync: mockExistsSync,
      realpathSync: mockRealpathSync,
      statSync: mockStatSync,
      createReadStream: mockCreateReadStream,
    },
    existsSync: mockExistsSync,
    realpathSync: mockRealpathSync,
    statSync: mockStatSync,
    createReadStream: mockCreateReadStream,
  };
});

import filesRoutes from "../../../src/routes/files";

const app = new Hono();
app.route("/", filesRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockRealpathSync.mockImplementation((p: string) => p);
  mockStatSync.mockReturnValue({ isFile: () => true, size: 7 });
  mockCreateReadStream.mockReturnValue(Readable.from(Buffer.from("preview")));
});

describe("GET /workspaces/:id/file-preview", () => {
  it("reports a missing workspace before asking for a preview path", async () => {
    loadWorkspace.mockImplementationOnce(() => {
      throw new NotFoundError("Workspace not found");
    });
    const missing = await app.request("/workspaces/absent/file-preview");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Workspace not found" });
    const found = await app.request("/workspaces/ws-123/file-preview");
    expect(found.status).toBe(400);
    expect(await found.json()).toEqual({ error: "path parameter is required" });
  });

  it("checks a preview directory before its extension, and a recording extension before its stat", async () => {
    mockStatSync.mockReturnValue({ isFile: () => false, size: 0 });
    const directory = await app.request("/workspaces/ws-123/file-preview?path=assets");
    expect(directory.status).toBe(400);
    expect(await directory.json()).toEqual({ error: "Not a file" });
    const recording = await app.request("/files/stream?path=/tmp/unknown");
    expect(recording.status).toBe(400);
    expect(await recording.json()).toEqual({ error: "unsupported file type" });
  });

  it("streams browser-previewable workspace files", async () => {
    const res = await app.request("/workspaces/ws-123/file-preview?path=assets/icon.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="icon.png"');
    expect(mockCreateReadStream).toHaveBeenCalledWith(
      "/repos/myrepo/.deus/test-ws/assets/icon.png"
    );
  });

  it("sandboxes a repository's HTML so its scripts get no origin of the backend's", async () => {
    const res = await app.request("/workspaces/ws-123/file-preview?path=site/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts");

    const image = await app.request("/workspaces/ws-123/file-preview?path=assets/icon.png");
    expect(image.headers.get("content-security-policy")).toBeNull();
  });

  it("refuses a cloud workspace in words instead of reading the backend's own folder", async () => {
    loadWorkspace.mockReturnValueOnce({ workspace: { kind: "cloud" }, workspacePath: "" });
    const res = await app.request("/workspaces/ws-cloud/file-preview?path=index.html");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("not on this computer");
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockCreateReadStream).not.toHaveBeenCalled();
  });

  it("rejects markdown files because they should open in Files instead", async () => {
    const res = await app.request("/workspaces/ws-123/file-preview?path=README.md");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockCreateReadStream).not.toHaveBeenCalled();
  });
});

describe("file containment and recording ranges", () => {
  it("refuses a preview symlink whose target leaves the workspace", async () => {
    mockRealpathSync.mockImplementation((p) =>
      p.endsWith("/alias.png") ? "/other/private.png" : p
    );
    const res = await app.request("/workspaces/ws-123/file-preview?path=alias.png");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid file path" });
    expect(mockCreateReadStream).not.toHaveBeenCalled();
  });

  it("refuses a recording outside the temp roots and unsupported files inside them", async () => {
    expect((await app.request("/files/stream?path=/independent-root/movie.mp4")).status).toBe(403);
    expect((await app.request("/files/stream?path=/tmp/page.html")).status).toBe(400);
    expect(mockCreateReadStream).not.toHaveBeenCalled();
  });

  const url = "/files/stream?path=/tmp/movie.mp4";

  it.each([
    { range: "bytes=2-4", start: 2, end: 4 },
    { range: "bytes=4-99", start: 4, end: 6 },
  ])("serves the available bytes for $range", async ({ range, start, end }) => {
    const partial = await app.request(url, { headers: { range } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes ${start}-${end}/7`);
    expect(partial.headers.get("content-length")).toBe("3");
    expect(mockCreateReadStream).toHaveBeenCalledWith("/tmp/movie.mp4", { start, end });
  });

  it.each(["bytes=7-", "bytes=8-99"])(
    "returns 416 for a start outside the file (%s)",
    async (range) => {
      const outside = await app.request(url, { headers: { range } });
      expect(outside.status).toBe(416);
      expect(outside.headers.get("content-range")).toBe("bytes */7");
    }
  );

  it("ignores Range on HEAD and reports the full recording length", async () => {
    const head = await app.request(url, { method: "HEAD", headers: { range: "bytes=2-4" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("7");
    expect(head.headers.get("content-type")).toBe("video/mp4");
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(head.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(head.headers.has("content-range")).toBe(false);
    expect(head.body).toBeNull();
    expect(mockCreateReadStream).not.toHaveBeenCalled();
  });
});
