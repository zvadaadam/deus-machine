import { vi, describe, it, expect, beforeEach } from "vitest";
import { Readable } from "stream";

const { mockScanWorkspaceFiles, mockInvalidateCache, mockReadTextFile, mockWithWorkspace } =
  vi.hoisted(() => ({
    mockScanWorkspaceFiles: vi.fn(),
    mockInvalidateCache: vi.fn(),
    mockReadTextFile: vi.fn(),
    mockWithWorkspace: vi.fn((c: any, next: any) => {
      c.set("workspace", { id: "ws-123", root_path: "/repos/myrepo", slug: "test-ws" });
      c.set("workspacePath", "/repos/myrepo/.deus/test-ws");
      return next();
    }),
  }));

vi.mock("../../../src/services/files.service", () => ({
  scanWorkspaceFiles: mockScanWorkspaceFiles,
  invalidateCache: mockInvalidateCache,
  readTextFile: mockReadTextFile,
}));

vi.mock("../../../src/middleware/workspace-loader", () => ({
  withWorkspace: mockWithWorkspace,
}));

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn(),
}));

vi.mock("../../../src/db", () => ({
  getWorkspaceForMiddleware: vi.fn(),
}));

// Mock fs.existsSync for file-content validation
const { mockExistsSync, mockRealpathSync, mockStatSync, mockCreateReadStream } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockRealpathSync: vi.fn((p: string) => p),
  mockStatSync: vi.fn(() => ({ isFile: () => true, size: 7 })),
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

import app from "../../../src/routes/files";

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockRealpathSync.mockImplementation((p: string) => p);
  mockStatSync.mockReturnValue({ isFile: () => true, size: 7 });
  mockCreateReadStream.mockReturnValue(Readable.from(Buffer.from("preview")));
});

describe("GET /workspaces/:id/files", () => {
  it("returns 200 with scanned files", async () => {
    mockScanWorkspaceFiles.mockReturnValue({
      files: [
        {
          name: "src",
          path: "src",
          type: "directory",
          children: [{ name: "app.ts", path: "src/app.ts", type: "file", size: 1024 }],
        },
        { name: "README.md", path: "README.md", type: "file", size: 512 },
      ],
      totalFiles: 2,
      totalSize: 1536,
    });

    const res = await app.request("/workspaces/ws-123/files");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.totalFiles).toBe(2);
    expect(body.totalSize).toBe(1536);
    expect(body.files).toHaveLength(2);
    expect(mockScanWorkspaceFiles).toHaveBeenCalledWith("/repos/myrepo/.deus/test-ws");
  });
});

describe("POST /workspaces/:id/files/invalidate-cache", () => {
  it("returns 200 and calls invalidateCache", async () => {
    const res = await app.request("/workspaces/ws-123/files/invalidate-cache", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockInvalidateCache).toHaveBeenCalledWith("/repos/myrepo/.deus/test-ws");
  });
});

describe("GET /workspaces/:id/file-content", () => {
  it("returns file content for valid path", async () => {
    mockReadTextFile.mockReturnValue("const x = 1;\n");

    const res = await app.request("/workspaces/ws-123/file-content?path=src/app.ts");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.content).toBe("const x = 1;\n");
  });

  it("returns 400 when path param is missing", async () => {
    const res = await app.request("/workspaces/ws-123/file-content");
    // ValidationError thrown by our route
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects directory traversal attempts", async () => {
    const res = await app.request("/workspaces/ws-123/file-content?path=../../etc/passwd");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects absolute paths", async () => {
    const res = await app.request("/workspaces/ws-123/file-content?path=/etc/passwd");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects symlink escapes outside the workspace", async () => {
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === "/repos/myrepo/.deus/test-ws") return p;
      if (p === "/repos/myrepo/.deus/test-ws/src/link.txt") return "/etc/passwd";
      return p;
    });

    const res = await app.request("/workspaces/ws-123/file-content?path=src/link.txt");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 422 for binary files", async () => {
    mockReadTextFile.mockReturnValue(null);

    const res = await app.request("/workspaces/ws-123/file-content?path=image.png");
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.error).toBe("binary_file");
  });
});

describe("GET /workspaces/:id/file-preview", () => {
  it("streams browser-previewable workspace files", async () => {
    const res = await app.request("/workspaces/ws-123/file-preview?path=assets/icon.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="icon.png"');
    expect(mockCreateReadStream).toHaveBeenCalledWith(
      "/repos/myrepo/.deus/test-ws/assets/icon.png"
    );
  });

  it("rejects markdown files because they should open in Files instead", async () => {
    const res = await app.request("/workspaces/ws-123/file-preview?path=README.md");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockCreateReadStream).not.toHaveBeenCalled();
  });
});
