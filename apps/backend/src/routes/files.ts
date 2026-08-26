import { Hono } from "hono";
import path from "path";
import fs from "fs";
import { tmpdir } from "os";
import { Readable } from "stream";
import { withWorkspace } from "../middleware/workspace-loader";
import { requestCloudFs } from "../services/agent/cloud/driver";

/** Cloud fs failures are USER states (asleep sandbox, provisioning, timeouts)
 *  — mapped here so they surface as instructions, never "Internal server
 *  error" + a spurious error report. */
/** Null until the sandbox is up. The tree route returns an empty listing (not
 *  an error) so Files shows "empty", not a dead error panel that never
 *  refetches when provisioning completes. */
function cloudSessionOrNull(workspace: { current_session_id: string | null }): string | null {
  return workspace.current_session_id;
}

async function cloudFsOrThrow(
  sessionId: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    return await requestCloudFs(sessionId, request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      /timed out/.test(message)
        ? "Sandbox did not answer — it may be waking; try again shortly."
        : message
    );
  }
}

/** @-mention search re-lists the sandbox on every keystroke without this. The
 *  cache is keyed by session and shared by the tree route (which warms it) and
 *  search (which reads it); the refresh button clears it. */
const cloudTreeCache = new Map<string, { paths: string[]; expiresAt: number }>();
const CLOUD_TREE_TTL_MS = 15_000;
/** Search/@-mentions must see the WHOLE repo, not a 5k-truncated prefix — a
 *  higher list bound for the cloud lane (still bounded so a giant monorepo
 *  can't DoS the channel). */
const CLOUD_LIST_CAP = 50_000;

function flattenCloudTree(tree: CloudFsNode[]): string[] {
  const paths: string[] = [];
  const walk = (nodes: CloudFsNode[]) => {
    for (const node of nodes) {
      if (node.type === "file") paths.push(node.path);
      else if (node.children) walk(node.children);
    }
  };
  walk(tree);
  return paths;
}

function cacheCloudTree(sessionId: string, tree: CloudFsNode[]): void {
  cloudTreeCache.set(sessionId, {
    paths: flattenCloudTree(tree),
    expiresAt: Date.now() + CLOUD_TREE_TTL_MS,
  });
  if (cloudTreeCache.size > 16) {
    const oldest = cloudTreeCache.keys().next().value;
    if (oldest) cloudTreeCache.delete(oldest);
  }
}
import { ValidationError } from "../lib/errors";
import * as filesService from "../services/files.service";
import * as gitService from "../services/git.service";
import type { WorkspaceWithDetailsRow } from "../db";

type Env = { Variables: { workspace: WorkspaceWithDetailsRow; workspacePath: string } };
const app = new Hono<Env>();

/**
 * GET /workspaces/:id/files — Scan workspace files.
 * Returns a hierarchical tree of all files (.gitignore-aware).
 */
app.get("/workspaces/:id/files", withWorkspace, async (c) => {
  const workspace = c.get("workspace");
  if (workspace.kind === "cloud") {
    const sessionId = cloudSessionOrNull(workspace);
    if (!sessionId) return c.json({ files: [], totalFiles: 0, totalSize: 0, provisioning: true });
    const data = (await cloudFsOrThrow(sessionId, { op: "list", maxEntries: CLOUD_LIST_CAP })) as {
      tree?: CloudFsNode[];
      truncated?: boolean;
      error?: string;
    };
    if (data.error) throw new ValidationError(data.error);
    cacheCloudTree(sessionId, data.tree ?? []); // feed @-mention search
    return c.json({ ...cloudTreeToResponse(data.tree ?? []), truncated: data.truncated === true });
  }
  const workspacePath = c.get("workspacePath");
  const result = filesService.scanWorkspaceFiles(workspacePath);
  return c.json(result);
});

// ── Cloud mapping: the sandbox fs channel's FsNode → the local tree shape ──

interface CloudFsNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: CloudFsNode[];
}

function cloudTreeToResponse(tree: CloudFsNode[]) {
  let totalFiles = 0;
  let totalSize = 0;
  const map = (node: CloudFsNode): Record<string, unknown> => {
    if (node.type === "file") {
      totalFiles += 1;
      totalSize += node.size ?? 0;
      return { name: node.name, path: node.path, type: "file", size: node.size };
    }
    return {
      name: node.name,
      path: node.path,
      type: "directory",
      children: (node.children ?? []).map(map),
    };
  };
  const files = tree.map(map);
  return { files, totalFiles, totalSize };
}

/**
 * POST /workspaces/:id/files/invalidate-cache — Clear file scan cache for this workspace.
 */
app.post("/workspaces/:id/files/invalidate-cache", withWorkspace, (c) => {
  const workspace = c.get("workspace");
  if (workspace.kind === "cloud") {
    if (workspace.current_session_id) cloudTreeCache.delete(workspace.current_session_id);
    return c.json({ ok: true });
  }
  filesService.invalidateCache(c.get("workspacePath"));
  return c.json({ ok: true });
});

/**
 * GET /workspaces/:id/file-content — Read a file's text content.
 * Query param: ?path=relative/file/path
 */
app.get("/workspaces/:id/file-content", withWorkspace, async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) throw new ValidationError("path parameter is required");

  const workspace = c.get("workspace");
  if (workspace.kind === "cloud") {
    // The sidecar enforces canonical containment; this mirrors the local
    // branch's early rejection so both lanes refuse the same inputs.
    if (filePath.split("/").includes("..")) throw new ValidationError("Invalid file path");
    const sessionId = cloudSessionOrNull(workspace);
    if (!sessionId) throw new ValidationError("File not found");
    const data = (await cloudFsOrThrow(sessionId, { op: "read", path: filePath })) as {
      content?: string;
      error?: string;
    };
    if (data.error) throw new ValidationError(data.error);
    if (typeof data.content !== "string") {
      return c.json({ error: "binary_file", message: "File appears to be binary" }, 422);
    }
    return c.json({ content: data.content });
  }

  const workspacePath = c.get("workspacePath");

  const safeRelativePath = gitService.resolveWorkspaceRelativePath(workspacePath, filePath);
  if (!safeRelativePath) throw new ValidationError("Invalid file path");

  const absolutePath = path.resolve(workspacePath, safeRelativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new ValidationError("File not found");
  }

  let realWorkspacePath: string;
  let realPath: string;
  try {
    realWorkspacePath = fs.realpathSync(workspacePath);
    realPath = fs.realpathSync(absolutePath);
  } catch {
    throw new ValidationError("File not found");
  }

  const relativeRealPath = path.relative(realWorkspacePath, realPath);
  if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
    throw new ValidationError("Invalid file path");
  }

  const content = filesService.readTextFile(realPath);
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

  const workspace = c.get("workspace");
  if (workspace.kind === "cloud") {
    // Same scoring, sandbox truth: flatten the fs-channel tree and reuse the
    // local scorers — @-mentions and the Files filter work identically.
    const sessionId = workspace.current_session_id;
    if (!sessionId) return c.json([]);
    const cached = cloudTreeCache.get(sessionId);
    let paths: string[];
    if (cached && cached.expiresAt > Date.now()) {
      paths = cached.paths;
    } else {
      const data = (await requestCloudFs(sessionId, {
        op: "list",
        maxEntries: CLOUD_LIST_CAP,
      }).catch(() => null)) as { tree?: CloudFsNode[]; error?: string } | null;
      if (!data || data.error) return c.json([]);
      cacheCloudTree(sessionId, data.tree ?? []);
      paths = cloudTreeCache.get(sessionId)!.paths;
    }
    const results =
      !query || typeof query !== "string"
        ? filesService.scoreTopFiles(paths, limit)
        : filesService.fuzzySearchPaths(paths, query, limit);
    return c.json(results);
  }

  const workspacePath = c.get("workspacePath");

  // Empty query → return top-level files (short paths first)
  if (!query || typeof query !== "string") {
    const results = filesService.listTopFiles(workspacePath, limit);
    return c.json(results);
  }

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

const toResponseBody = (stream: fs.ReadStream): BodyInit =>
  Readable.toWeb(stream) as unknown as BodyInit;

const ALLOWED_WORKSPACE_PREVIEW_EXT: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * GET /workspaces/:id/file-preview — Stream a browser-previewable workspace file.
 * Query param: ?path=relative/file/path
 */
app.get("/workspaces/:id/file-preview", withWorkspace, (c) => {
  const filePath = c.req.query("path");
  if (!filePath) throw new ValidationError("path parameter is required");

  const workspacePath = c.get("workspacePath");
  const safeRelativePath = gitService.resolveWorkspaceRelativePath(workspacePath, filePath);
  if (!safeRelativePath) throw new ValidationError("Invalid file path");

  const absolutePath = path.resolve(workspacePath, safeRelativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new ValidationError("File not found");
  }

  let realWorkspacePath: string;
  let realPath: string;
  try {
    realWorkspacePath = fs.realpathSync(workspacePath);
    realPath = fs.realpathSync(absolutePath);
  } catch {
    throw new ValidationError("File not found");
  }

  const relativeRealPath = path.relative(realWorkspacePath, realPath);
  if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
    throw new ValidationError("Invalid file path");
  }

  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw new ValidationError("Not a file");

  const ext = path.extname(realPath).toLowerCase();
  const mimeType = ALLOWED_WORKSPACE_PREVIEW_EXT[ext];
  if (!mimeType) throw new ValidationError("Unsupported preview file type");

  const stream = fs.createReadStream(realPath);
  return new Response(toResponseBody(stream), {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(stat.size),
      "Content-Disposition": `inline; filename="${path.basename(realPath).replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=60",
    },
  });
});

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

  // Path containment: only serve files from allowed directories.
  // Recordings may be in tmpdir() OR /tmp (macOS /tmp → /private/tmp).
  let realPath: string;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    return c.json({ error: "file not found" }, 404);
  }
  const allowedRoots = [tmpdir()];
  // macOS: /tmp symlinks to /private/tmp, but tmpdir() returns /var/folders/...
  try {
    allowedRoots.push(fs.realpathSync("/tmp"));
  } catch {
    // /tmp doesn't exist on this platform
  }
  const isAllowed = allowedRoots.some((root) => {
    try {
      const realRoot = fs.realpathSync(root);
      return realPath.startsWith(realRoot + path.sep);
    } catch {
      return false;
    }
  });
  if (!isAllowed) {
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
      return new Response(toResponseBody(stream), {
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
  return new Response(toResponseBody(stream), {
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
