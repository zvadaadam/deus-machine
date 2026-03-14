import { Hono } from 'hono';
import { withWorkspace } from '../middleware/workspace-loader';
import { runGh, getPrStatus } from '../services/gh.service';
import type { WorkspaceWithDetailsRow } from '../db';

type Env = { Variables: { workspace: WorkspaceWithDetailsRow; workspacePath: string } };
const app = new Hono<Env>();

// gh CLI status check -- cached on frontend with long staleTime
app.get('/gh-status', async (c) => {
  const versionResult = await runGh(['--version'], { cwd: process.cwd(), timeoutMs: 2000 });
  if (!versionResult.success) return c.json({ isInstalled: false, isAuthenticated: false });
  const authResult = await runGh(['auth', 'status'], { cwd: process.cwd(), timeoutMs: 5000 });
  return c.json({ isInstalled: true, isAuthenticated: authResult.success });
});

// PR status -- async, fork-aware, explicit errors
app.get('/workspaces/:id/pr-status', withWorkspace, async (c) => {
  const workspacePath = c.get('workspacePath');
  const result = await getPrStatus(workspacePath);
  return c.json(result);
});

export default app;
