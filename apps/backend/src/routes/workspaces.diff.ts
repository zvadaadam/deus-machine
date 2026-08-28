import { Hono } from "hono";
import { withWorkspace } from "../middleware/workspace-loader";
import { ValidationError } from "../lib/errors";
import { resolveNode } from "../services/node/driver";
import type { WorkspaceWithDetailsRow } from "../db";

type Env = { Variables: { workspace: WorkspaceWithDetailsRow; workspacePath: string } };
const app = new Hono<Env>();

/**
 * Diff routes delegate to the owning node's driver (local git or the cloud
 * session socket) — see services/node/driver.ts. The route only knows the HTTP
 * shape; which node answers is the driver's concern.
 */

// Diff stats - uses withWorkspace middleware
app.get("/workspaces/:id/diff-stats", withWorkspace, async (c) => {
  const stats = await resolveNode(c.get("workspace"), c.get("workspacePath")).diffStats();
  return c.json(stats);
});

// Diff files
app.get("/workspaces/:id/diff-files", withWorkspace, async (c) => {
  const result = await resolveNode(c.get("workspace"), c.get("workspacePath")).diffFiles();
  return c.json(result);
});

// Diff file content
app.get("/workspaces/:id/diff-file", withWorkspace, async (c) => {
  const file = c.req.query("file");
  if (!file) throw new ValidationError("file parameter is required");

  const outcome = await resolveNode(c.get("workspace"), c.get("workspacePath")).diffFile(file);
  if (!outcome.ok) return c.json(outcome.body, outcome.status);
  return c.json({
    file: outcome.file,
    diff: outcome.diff,
    old_content: outcome.old_content,
    new_content: outcome.new_content,
  });
});

export default app;
