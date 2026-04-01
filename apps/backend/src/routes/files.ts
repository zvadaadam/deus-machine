import { Hono } from "hono";
import path from "path";
import fs from "fs";
import { tmpdir } from "os";
import { Readable } from "stream";
import { withWorkspace } from "../middleware/workspace-loader";
import { ValidationError } from "../lib/errors";
import * as filesService from "../services/files.service";
import type { WorkspaceWithDetailsRow } from "../db";

type Env = { Variables: { workspace: WorkspaceWithDetailsRow; workspacePath: string } };
const app = new Hono<Env>();

/**
 * GET /workspaces/:id/files — Scan workspace files.
 * Returns a hierarchical tree of all files (.gitignore-aware).
 */
app.get("/workspaces/:id/files", withWorkspace, (c) => {
  const workspacePath = c.get("workspacePath");
  const result = filesService.scanWorkspaceFiles(workspacePath);
  return c.json(result);
});

/**
 * POST /workspaces/:id/files/invalidate-cache — Clear file scan cache for this workspace.
 */
app.post("/workspaces/:id/files/invalidate-cache", withWorkspace, (c) => {
  const workspacePath = c.get("workspacePath");
  filesService.invalidateCache(workspacePath);
  return c.json({ ok: true });
});

/**
 * GET /workspaces/:id/file-content — Read a file's text content.
 * Query param: ?path=relative/file/path
 */
app.get("/workspaces/:id/file-content", withWorkspace, (c) => {
  const filePath = c.req.query("path");
  if (!filePath) throw new ValidationError("path parameter is required");

  const workspacePath = c.get("workspacePath");

  // Validate the path is within the workspace (prevent directory traversal)
  const normalized = path.normalize(filePath);
  if (path.isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new ValidationError("Invalid file path");
  }

  const absolutePath = path.resolve(workspacePath, normalized);
  const relative = path.relative(workspacePath, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ValidationError("File path escapes workspace");
  }

  if (!fs.existsSync(absolutePath)) {
    throw new ValidationError("File not found");
  }

  const content = filesService.readTextFile(absolutePath);
  if (content === null) {
    return c.json({ error: "binary_file", message: "File appears to be binary" }, 422);
  }

  return c.json({ content });
});

/**
 * POST /workspaces/:id/files/search — Fuzzy search workspace files by name.
 * Body: { query: string, limit?: number }
 * Returns: Array<{ path, name, score }>
 */
app.post("/workspaces/:id/files/search", withWorkspace, async (c) => {
  const { query, limit = 15 } = await c.req.json<{ query: string; limit?: number }>();
  if (!query || typeof query !== "string") {
    return c.json([]);
  }

  const workspacePath = c.get("workspacePath");
  const results = filesService.fuzzySearchFiles(workspacePath, query, limit);
  return c.json(results);
});

// ---------------------------------------------------------------------------
// Media streaming — serves local video/image files for recording previews.
// Supports HTTP Range for video seeking.
// ---------------------------------------------------------------------------

const ALLOWED_MEDIA_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/**
 * GET /files/stream — Stream a local media file.
 * Query param: ?path=/tmp/recording-rec_a1b2c3.mp4
 *
 * Used by recording tool renderers to display video previews and thumbnails.
 * Only serves files with allowed media extensions.
 */
app.get("/files/stream", (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path parameter is required" }, 400);

  if (!path.isAbsolute(filePath)) {
    return c.json({ error: "path must be absolute" }, 400);
  }

  // Path containment: only serve files from tmpdir to prevent arbitrary file reads
  let realPath: string;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    return c.json({ error: "file not found" }, 404);
  }
  const realRoot = fs.realpathSync(tmpdir());
  if (!realPath.startsWith(realRoot + path.sep)) {
    return c.json({ error: "access denied" }, 403);
  }

  // Use validated realPath for all subsequent operations (TOCTOU safety)
  const ext = path.extname(realPath).toLowerCase();
  const mimeType = ALLOWED_MEDIA_EXT[ext];
  if (!mimeType) return c.json({ error: "unsupported file type" }, 400);

  if (!fs.existsSync(realPath)) return c.json({ error: "file not found" }, 404);

  const stat = fs.statSync(realPath);
  if (!stat.isFile()) return c.json({ error: "not a file" }, 400);

  const fileSize = stat.size;
  const rangeHeader = c.req.header("range");

  // Range request — required for <video> seeking
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${fileSize}` },
        });
      }

      const stream = fs.createReadStream(realPath, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          "Content-Type": mimeType,
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
  }

  // Full file
  const stream = fs.createReadStream(realPath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(fileSize),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

export default app;
