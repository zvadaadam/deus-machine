import { Hono } from "hono";
import { withWorkspace } from "../middleware/workspace-loader";
import { getGhIdentity } from "../services/gh-identity.service";
import { fetchAndApplyPrStatus } from "../services/pr-snapshot.service";
import type { WorkspaceWithDetailsRow } from "../db";

type Env = { Variables: { workspace: WorkspaceWithDetailsRow; workspacePath: string } };
const app = new Hono<Env>();

// gh CLI install + auth state + active account identity (login, display name, avatar).
// Cached on frontend with long staleTime; also consumed by the sidebar profile chip.
app.get("/gh-status", async (c) => {
  return c.json(await getGhIdentity());
});

// PR status -- async, fork-aware, explicit errors
// Side-effect: persists the pr_* lifecycle snapshot + triggers auto-derive
app.get("/workspaces/:id/pr-status", withWorkspace, async (c) => {
  const workspace = c.get("workspace");
  const workspacePath = c.get("workspacePath");
  // Epoch-guarded fetch+persist — shared with background refreshes so an
  // overlapping older lookup can never overwrite a newer snapshot.
  const result = await fetchAndApplyPrStatus(workspace.id, workspacePath);

  return c.json(result);
});

export default app;
