import { Hono } from "hono";
import path from "path";
import fs from "fs";
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

export default app;
