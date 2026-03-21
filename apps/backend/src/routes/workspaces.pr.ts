import { Hono } from "hono";
import { withWorkspace } from "../middleware/workspace-loader";
import { runGh, getPrStatus } from "../services/gh.service";
import { getDatabase } from "../lib/database";
import { invalidate } from "../services/query-engine";
import { autoProgressStatus } from "../services/workspace-status.service";
import type { WorkspaceWithDetailsRow } from "../db";

type Env = { Variables: { workspace: WorkspaceWithDetailsRow; workspacePath: string } };
const app = new Hono<Env>();

// gh CLI status check -- cached on frontend with long staleTime
app.get("/gh-status", async (c) => {
  const versionResult = await runGh(["--version"], { cwd: process.cwd(), timeoutMs: 2000 });
  if (!versionResult.success) return c.json({ isInstalled: false, isAuthenticated: false });
  const authResult = await runGh(["auth", "status"], { cwd: process.cwd(), timeoutMs: 5000 });
  return c.json({ isInstalled: true, isAuthenticated: authResult.success });
});

// PR status -- async, fork-aware, explicit errors
// Side-effect: persists pr_url on first discovery + triggers auto-derive
app.get("/workspaces/:id/pr-status", withWorkspace, async (c) => {
  const workspace = c.get("workspace");
  const workspacePath = c.get("workspacePath");
  const result = await getPrStatus(workspacePath);

  let needsInvalidation = false;

  // Persist PR metadata when URL changes
  if (result.has_pr && result.pr_url && result.pr_url !== workspace.pr_url) {
    const db = getDatabase();
    db.prepare("UPDATE workspaces SET pr_url = ?, pr_number = ? WHERE id = ?").run(
      result.pr_url,
      result.pr_number ?? null,
      workspace.id
    );
    needsInvalidation = true;
  }

  // Auto-progress to in-review whenever a PR exists (not just on URL change)
  if (result.has_pr) {
    if (autoProgressStatus(workspace.id, "in-review")) {
      needsInvalidation = true;
    }
  }

  // Auto-derive done on merge
  if (result.merge_status === "merged") {
    if (autoProgressStatus(workspace.id, "done")) {
      needsInvalidation = true;
    }
  }

  if (needsInvalidation) {
    invalidate(["workspaces", "stats"]);
  }

  return c.json(result);
});

export default app;
