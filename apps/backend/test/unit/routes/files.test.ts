import { vi, describe, it, expect, beforeEach } from "vitest";
import { Readable } from "stream";

// The preview route, the one workspace file read a browser makes by URL. The
// tree, text and search operations are tested in ../api/files.test.ts.

const { mockWithWorkspace } = vi.hoisted(() => ({
  mockWithWorkspace: vi.fn((c: any, next: any) => {
    c.set("workspace", { id: "ws-123", root_path: "/repos/myrepo", slug: "test-ws" });
    c.set("workspacePath", "/repos/myrepo/.deus/test-ws");
    return next();
  }),
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
