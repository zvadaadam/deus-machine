import { Hono } from 'hono';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { uuidv7 } from '@shared/lib/uuid';
import { getErrorMessage, isExecError } from '@shared/lib/errors';
import { getDatabase } from '../lib/database';
import { withWorkspace, computeWorkspacePath } from '../middleware/workspace-loader';
import { NotFoundError, ValidationError } from '../lib/errors';
import { parseBody } from '../lib/validate';
import { PatchWorkspaceBody, CreateWorkspaceBody, OpenPenFileBody } from '../lib/schemas';
import * as gitService from '../services/git.service';
import { generateUniqueName } from '../services/workspace.service';
import { readManifest, readManifestWithFallback, getSetupCommand, getArchiveCommand, getOpenDevsEnv, getNormalizedTasks, writeManifest, runSetupScript } from '../services/manifest.service';
import { initializeWorkspace } from '../services/workspace-init.service';
import {
  getAllWorkspaces,
  getWorkspacesByRepo,
  getWorkspaceById,
  getWorkspaceRaw,
  getWorkspaceWithRepo,
  getRepositoryById,
  getAllRepositorySummaries,
  getSessionRaw,
  getSessionsByWorkspaceId,
} from '../db';
import type { WorkspaceWithDetailsRow } from '../db';
import { invalidate } from '../services/query-engine';
import type { QueryResource } from '../../../shared/types/query-protocol';

const execFileAsync = promisify(execFile);

type Env = { Variables: { workspace: WorkspaceWithDetailsRow; workspacePath: string } };
const app = new Hono<Env>();

app.get('/workspaces', (c) => {
  const db = getDatabase();
  const workspaces = getAllWorkspaces(db);
  return c.json(workspaces.map(ws => ({ ...ws, workspace_path: computeWorkspacePath(ws) })));
});

app.get('/workspaces/by-repo', (c) => {
  const db = getDatabase();
  const stateParam = c.req.query('state');
  const workspaces = getWorkspacesByRepo(db, stateParam);

  const grouped: Record<string, any> = {};
  workspaces.forEach(workspace => {
    const repoId = workspace.repository_id || 'unknown';
    if (!grouped[repoId]) {
      grouped[repoId] = {
        repo_id: repoId,
        repo_name: workspace.repo_name || 'Unknown',
        sort_order: workspace.repo_sort_order || 999,
        workspaces: []
      };
    }
    grouped[repoId].workspaces.push({ ...workspace, workspace_path: computeWorkspacePath(workspace) });
  });

  // Backfill repos that have no matching workspaces (e.g. all archived)
  // so they still appear in the sidebar.
  const allRepos = getAllRepositorySummaries(db);
  for (const repo of allRepos) {
    if (!grouped[repo.id]) {
      grouped[repo.id] = {
        repo_id: repo.id,
        repo_name: repo.name,
        sort_order: repo.sort_order ?? 999,
        workspaces: [],
      };
    }
  }

  const result = Object.values(grouped).sort((a: any, b: any) => a.sort_order - b.sort_order);
  return c.json(result);
});

app.get('/workspaces/:id', (c) => {
  const db = getDatabase();
  const workspace = getWorkspaceById(db, c.req.param('id'));
  if (!workspace) throw new NotFoundError('Workspace not found');
  return c.json({ ...workspace, workspace_path: computeWorkspacePath(workspace) });
});

app.patch('/workspaces/:id', async (c) => {
  const db = getDatabase();
  const { state } = parseBody(PatchWorkspaceBody, await c.req.json());
  if (state) {
    db.prepare('UPDATE workspaces SET state = ? WHERE id = ?').run(state, c.req.param('id'));

    // Run archive lifecycle hook (best-effort)
    if (state === 'archived') {
      try {
        const ws = getWorkspaceById(db, c.req.param('id'));
        if (ws && ws.root_path) {
          const wsPath = computeWorkspacePath(ws);
          const manifest = readManifestWithFallback(wsPath, ws.root_path);
          const archiveCmd = manifest ? getArchiveCommand(manifest) : null;
          if (archiveCmd) {
            const archiveEnv = getOpenDevsEnv(manifest!, {
              id: ws.id,
              rootPath: ws.root_path,
              workspacePath: wsPath,
            });
            const archiveProc = spawn('sh', ['-c', archiveCmd], {
              cwd: wsPath,
              env: { ...process.env, ...archiveEnv },
              stdio: 'ignore',
              detached: false,
            });
            archiveProc.on('error', (err) => {
              console.error(`Archive hook error for workspace ${c.req.param('id')}:`, err.message);
            });
            archiveProc.unref();
          }
        }
      } catch (err) {
        console.warn('[WORKSPACE] Archive lifecycle hook failed (continuing):', err);
      }
    }
  }
  const updated = getWorkspaceRaw(db, c.req.param('id'));
  invalidate(['workspaces', 'sessions', 'stats']);
  return c.json(updated);
});

// Diff stats - uses withWorkspace middleware
app.get('/workspaces/:id/diff-stats', withWorkspace, (c) => {
  const workspace = c.get('workspace');
  const workspacePath = c.get('workspacePath');
  const parentBranch = gitService.resolveParentBranch(workspacePath, workspace.git_target_branch, workspace.git_default_branch);
  const stats = gitService.getDiffStats(workspacePath, parentBranch);
  return c.json(stats);
});

// Diff files
app.get('/workspaces/:id/diff-files', withWorkspace, (c) => {
  const workspace = c.get('workspace');
  const workspacePath = c.get('workspacePath');
  const parentBranch = gitService.resolveParentBranch(workspacePath, workspace.git_target_branch, workspace.git_default_branch);
  const files = gitService.getDiffFiles(workspacePath, parentBranch);
  return c.json({ files });
});

// Diff file content
app.get('/workspaces/:id/diff-file', withWorkspace, (c) => {
  const file = c.req.query('file');
  if (!file) throw new ValidationError('file parameter is required');

  const workspace = c.get('workspace');
  const workspacePath = c.get('workspacePath');
  const parentBranch = gitService.resolveParentBranch(workspacePath, workspace.git_target_branch, workspace.git_default_branch);
  const safeFilePath = gitService.resolveWorkspaceRelativePath(workspacePath, file);
  if (!safeFilePath) throw new ValidationError('Invalid file path');

  try {
    const output = gitService.getFileDiff(workspacePath, parentBranch, safeFilePath);
    const diffInfo = gitService.extractDiffInfo(output);
    const mergeBase = gitService.getMergeBase(workspacePath, parentBranch);
    const safeOldPath = gitService.resolveWorkspaceRelativePath(workspacePath, diffInfo.oldPath || safeFilePath) || safeFilePath;
    const safeNewPath = gitService.resolveWorkspaceRelativePath(workspacePath, diffInfo.newPath || safeFilePath) || safeFilePath;

    let oldContent: string | null = null;
    let newContent: string | null = null;

    if (diffInfo.isNew) { oldContent = ''; }
    else { oldContent = gitService.getGitFileContent(workspacePath, mergeBase, safeOldPath); }

    if (diffInfo.isDeleted) { newContent = ''; }
    else {
      // Read from working directory (not HEAD) since we diff merge-base against workdir
      try {
        const buf = fs.readFileSync(path.resolve(workspacePath, safeNewPath));
        // Detect binary files (null bytes in first 8KB)
        const sample = buf.subarray(0, 8192);
        newContent = sample.includes(0) ? null : buf.toString('utf-8');
      } catch {
        newContent = gitService.getGitFileContent(workspacePath, 'HEAD', safeNewPath);
      }
    }

    return c.json({ file, diff: output, old_content: oldContent, new_content: newContent });
  } catch (gitError: unknown) {
    const msg = getErrorMessage(gitError);
    const killed = isExecError(gitError) && gitError.killed;
    const errorResponse: any = {
      error: 'diff_failed', message: 'Failed to get diff', retryable: true,
      details: { file, parentBranch, reason: null as string | null }
    };
    if (killed) { errorResponse.message = 'Diff operation timed out'; errorResponse.details.reason = 'timeout'; }
    else if (msg.includes('unknown revision')) { errorResponse.message = 'Parent branch not found'; errorResponse.details.reason = 'branch_not_found'; errorResponse.retryable = false; }
    else if (msg.includes('not a git repository')) { errorResponse.message = 'Not a git repository'; errorResponse.details.reason = 'not_git_repo'; errorResponse.retryable = false; }
    else { errorResponse.details.reason = 'git_error'; errorResponse.details.errorMessage = msg; }
    return c.json(errorResponse, 500);
  }
});

// Helper: run gh CLI command with timeout, explicit error classification
async function runGh(args: string[], options: { cwd: string; timeoutMs?: number }): Promise<
  { success: true; stdout: string } | { success: false; error: 'gh_not_installed' | 'gh_not_authenticated' | 'timeout' | 'unknown'; message: string }
> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      cwd: options.cwd,
      encoding: 'utf-8',
      timeout: options.timeoutMs ?? 5000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    });
    return { success: true, stdout: stdout.trim() };
  } catch (err: unknown) {
    if (isExecError(err)) {
      if (err.code === 'ENOENT') return { success: false, error: 'gh_not_installed', message: 'GitHub CLI (gh) is not installed' };
      if (err.killed) return { success: false, error: 'timeout', message: 'GitHub CLI command timed out' };
      const output = `${err.stderr ?? ''} ${err.stdout ?? ''}`.toLowerCase();
      if (output.includes('gh auth login') || output.includes('not logged into any github hosts'))
        return { success: false, error: 'gh_not_authenticated', message: 'GitHub CLI is not authenticated' };
      return { success: false, error: 'unknown', message: err.stderr || err.message || 'Failed to run gh CLI' };
    }
    return { success: false, error: 'unknown', message: getErrorMessage(err) };
  }
}

// gh CLI status check — cached on frontend with long staleTime
app.get('/gh-status', async (c) => {
  const versionResult = await runGh(['--version'], { cwd: process.cwd(), timeoutMs: 2000 });
  if (!versionResult.success) return c.json({ isInstalled: false, isAuthenticated: false });
  const authResult = await runGh(['auth', 'status'], { cwd: process.cwd(), timeoutMs: 5000 });
  return c.json({ isInstalled: true, isAuthenticated: authResult.success });
});

// GitHub Check Suite conclusions that indicate a non-passing terminal state.
// Full GraphQL enum: ACTION_REQUIRED, CANCELLED, FAILURE, NEUTRAL, SKIPPED,
// STALE, STARTUP_FAILURE, SUCCESS, TIMED_OUT.
// NEUTRAL/SKIPPED are intentionally non-blocking (count as passing).
// STALE means re-run is needed (count as pending below).
const FAILING_CONCLUSIONS = new Set([
  'FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED',
]);
// CheckRun `status` values that indicate the check hasn't completed yet.
// Note: CheckRun uses `status` field, StatusContext uses `state` field.
const PENDING_STATUSES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

/**
 * Classify a single GitHub check (CheckRun or StatusContext) into a uniform status.
 * GitHub's statusCheckRollup contains two object types:
 *   - CheckRun (__typename: "CheckRun"): uses `conclusion` + `status`
 *   - StatusContext (__typename: "StatusContext"): uses `state`
 */
function classifyCheck(check: any): 'passing' | 'failing' | 'pending' {
  if (check.__typename === 'StatusContext') {
    if (check.state === 'FAILURE' || check.state === 'ERROR') return 'failing';
    if (check.state === 'PENDING' || check.state === 'EXPECTED') return 'pending';
    return 'passing';
  }
  // CheckRun
  if (FAILING_CONCLUSIONS.has(check.conclusion)) return 'failing';
  if (check.conclusion === 'STALE' || check.conclusion == null || PENDING_STATUSES.has(check.status)) return 'pending';
  return 'passing';
}

// PR status — async, fork-aware, explicit errors
app.get('/workspaces/:id/pr-status', withWorkspace, async (c) => {
  const workspacePath = c.get('workspacePath');

  // Resolve current branch name
  let headBranch: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspacePath, encoding: 'utf-8', timeout: 3000,
    });
    headBranch = stdout.trim();
  } catch {
    return c.json({ has_pr: false, error: null });
  }

  if (!headBranch || headBranch === 'HEAD') return c.json({ has_pr: false, error: null });

  // Resolve origin and upstream remotes for fork support
  let originUrl: string | null = null;
  let upstreamUrl: string | null = null;
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: workspacePath, encoding: 'utf-8', timeout: 2000 });
    originUrl = stdout.trim() || null;
  } catch {}
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'upstream'], { cwd: workspacePath, encoding: 'utf-8', timeout: 2000 });
    upstreamUrl = stdout.trim() || null;
  } catch {}

  const isFork = upstreamUrl != null && originUrl != null && upstreamUrl !== originUrl;

  // Build list of attempts: try upstream first (for forks), then origin.
  // Use plain branch name — gh pr list --head does NOT support "owner:branch" syntax.
  // The --author @me flag already narrows results to the current user's PRs.
  const attempts: { repoArg: string | null; headArg: string }[] = [];
  if (isFork) attempts.push({ repoArg: upstreamUrl, headArg: headBranch });
  attempts.push({ repoArg: originUrl, headArg: headBranch });

  let lastError: string | null = null;
  let hadSuccessfulResponse = false;

  for (const { repoArg, headArg } of attempts) {
    const args = ['pr', 'list', '--head', headArg, '--author', '@me', '--state', 'all',
      '--json', 'number,title,url,state,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft'];
    if (repoArg) args.push('--repo', repoArg);

    const result = await runGh(args, { cwd: workspacePath });
    if (!result.success) {
      // Surface specific errors (installed/auth) to the frontend immediately
      if (result.error === 'gh_not_installed' || result.error === 'gh_not_authenticated' || result.error === 'timeout') {
        return c.json({ has_pr: false, error: result.error });
      }
      lastError = result.error; // Track for surfacing if all attempts fail
      continue;
    }

    let prs: any[];
    try { prs = JSON.parse(result.stdout || '[]'); } catch { continue; }
    if (!Array.isArray(prs)) continue;
    hadSuccessfulResponse = true;

    // Priority: OPEN > MERGED > CLOSED. Open PRs are actionable,
    // merged PRs show archive, closed PRs show a non-actionable status.
    const openPr = prs.find((pr: any) => pr.state?.toUpperCase() === 'OPEN');
    const mergedPr = prs.find((pr: any) => pr.state?.toUpperCase() === 'MERGED');
    const closedPr = prs.find((pr: any) => pr.state?.toUpperCase() === 'CLOSED');
    const pr = openPr ?? mergedPr ?? closedPr;

    if (pr) {
      const upperState = pr.state?.toUpperCase();
      const state: 'open' | 'merged' | 'closed' =
        upperState === 'MERGED' ? 'merged' :
        upperState === 'CLOSED' ? 'closed' : 'open';

      // Closed PRs are terminal — no CI or merge status is relevant
      if (state === 'closed') {
        return c.json({
          has_pr: true,
          pr_number: pr.number,
          pr_title: pr.title,
          pr_url: pr.url,
          pr_state: 'closed',
          merge_status: 'blocked',
          is_draft: pr.isDraft === true,
          has_conflicts: false,
          ci_status: 'unknown',
          review_status: 'none',
          error: null,
        });
      }

      let mergeStatus: 'ready' | 'blocked' | 'merged' = 'blocked';
      if (state === 'merged') mergeStatus = 'merged';
      else if (pr.mergeable === 'MERGEABLE') mergeStatus = 'ready';

      const checks: any[] = pr.statusCheckRollup ?? [];
      let ciStatus: 'passing' | 'failing' | 'pending' | 'unknown' = 'unknown';
      if (checks.length > 0) {
        const statuses = checks.map(classifyCheck);
        if (statuses.includes('failing')) ciStatus = 'failing';
        else if (statuses.includes('pending')) ciStatus = 'pending';
        else ciStatus = 'passing';
      }

      // Map reviewDecision from GitHub GraphQL enum
      const reviewMap: Record<string, 'approved' | 'changes_requested' | 'review_required' | 'none'> = {
        'APPROVED': 'approved', 'CHANGES_REQUESTED': 'changes_requested', 'REVIEW_REQUIRED': 'review_required',
      };
      const reviewStatus = reviewMap[pr.reviewDecision ?? ''] ?? 'none';

      return c.json({
        has_pr: true,
        pr_number: pr.number,
        pr_title: pr.title,
        pr_url: pr.url,
        pr_state: state,
        merge_status: mergeStatus,
        is_draft: pr.isDraft === true,
        has_conflicts: pr.mergeStateStatus === 'DIRTY',
        ci_status: ciStatus,
        review_status: reviewStatus,
        error: null,
      });
    }
  }

  // If all attempts failed with errors, surface it instead of silently showing "no PR".
  // lastError is only set for 'unknown' errors (timeout/auth/install return immediately).
  return c.json({ has_pr: false, error: (!hadSuccessfulResponse && lastError) ? 'network' : null });
});

// Pen files
app.get('/workspaces/:id/pen-files', withWorkspace, (c) => {
  const workspacePath = c.get('workspacePath');
  const MAX_DEPTH = 10;
  const MAX_FILES = 500;

  function findPenFiles(dirPath: string, relativeTo: string, depth = 0, results: any[] = []): any[] {
    if (depth > MAX_DEPTH || results.length >= MAX_FILES) return results;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) { findPenFiles(fullPath, relativeTo, depth + 1, results); }
        else if (entry.isFile() && entry.name.endsWith('.pen')) {
          results.push({ name: entry.name, path: path.relative(relativeTo, fullPath) });
          if (results.length >= MAX_FILES) return results;
        }
      }
    } catch {}
    return results;
  }

  const files = findPenFiles(workspacePath, workspacePath);
  return c.json({ files, count: files.length });
});

// Open pen file
app.post('/workspaces/:id/open-pen-file', withWorkspace, async (c) => {
  const { filePath } = parseBody(OpenPenFileBody, await c.req.json());

  const workspacePath = c.get('workspacePath');
  const safeRelativePath = gitService.resolveWorkspaceRelativePath(workspacePath, filePath);
  if (!safeRelativePath) throw new ValidationError('Invalid file path');

  const absolutePath = path.resolve(workspacePath, safeRelativePath);
  if (!fs.existsSync(absolutePath)) throw new NotFoundError('File not found');

  const envPencilApp = process.env.PENCIL_APP_NAME || process.env.PENCIL_APP;
  const pencilCandidates = [envPencilApp, '/Applications/Pencil.app', path.join(os.homedir(), 'Applications', 'Pencil.app'), 'Pencil'].filter(Boolean) as string[];

  let pencilApp: string | null = null;
  for (const candidate of pencilCandidates) {
    if (candidate.endsWith('.app') || candidate.startsWith('/')) {
      if (fs.existsSync(candidate)) { pencilApp = candidate; break; }
    } else { pencilApp = candidate; break; }
  }

  if (process.platform === 'darwin' && pencilApp) {
    const child = spawn('open', ['-a', pencilApp, absolutePath], { stdio: 'ignore' });
    let didFallback = false;
    const fallbackToWeb = () => {
      if (didFallback) return;
      didFallback = true;
      const { cmd, args } = gitService.getOpenCommand('https://pencil.dev');
      const webChild = spawn(cmd, args, { stdio: 'ignore' });
      webChild.unref();
    };
    child.on('error', fallbackToWeb);
    child.on('exit', (code) => { if (code !== 0) fallbackToWeb(); });
    child.unref();
  } else {
    const { cmd, args } = gitService.getOpenCommand('https://pencil.dev');
    const webChild = spawn(cmd, args, { stdio: 'ignore' });
    webChild.unref();
  }

  return c.json({ success: true });
});

// Dev servers (stub)
app.get('/workspaces/:id/dev-servers', (c) => {
  return c.json({ servers: [] });
});

// Create workspace
app.post('/workspaces', async (c) => {
  const db = getDatabase();
  const { repository_id } = parseBody(CreateWorkspaceBody, await c.req.json());

  const repo = getRepositoryById(db, repository_id);
  if (!repo) throw new NotFoundError('Repository not found');

  const workspace_name = generateUniqueName(db);
  const parent_branch = repo.git_default_branch || 'main';
  const workspaceId = uuidv7();

  let branchPrefix = 'workspace';
  try {
    const gitUser = execSync('git config user.name', { cwd: repo.root_path!, encoding: 'utf8' })
      .trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (gitUser) branchPrefix = gitUser;
  } catch {}
  const placeholderBranchName = `${branchPrefix}/${workspace_name}`;

  // ─── IMPORTANT: Remote-first branch strategy ───────────────────────
  // We ALWAYS want worktrees branched from origin/<parent_branch>, not
  // local <parent_branch>. Diffs are computed against origin/<branch>
  // (see resolve_parent_branch in git.rs and git.service.ts). If origin
  // is stale, the merge-base drifts and every file since the divergence
  // shows as "changed" — producing hundreds of phantom file changes.
  //
  // Fetch the remote branch before creating the worktree so that:
  // 1. The worktree starts from the latest upstream commit
  // 2. Diff merge-base matches what we branched from (zero phantom changes)
  // 3. PRs will be clean against the upstream target
  //
  // This is a non-blocking fetch (~1-3s on a warm connection). Workspace
  // creation is already async (worktree add runs in a child process) and
  // correctness matters more here.
  // ───────────────────────────────────────────────────────────────────
  try {
    await execFileAsync('git', ['fetch', 'origin', parent_branch], {
      cwd: repo.root_path!,
      timeout: 15000,
    });
  } catch (fetchErr) {
    // Non-fatal: if fetch fails (offline, no remote, etc.), fall back to
    // whatever local state we have. The worktree will still be created
    // from the local branch — diffs might be off but it's better than
    // blocking workspace creation entirely.
    console.warn(`[WORKSPACE] git fetch origin ${parent_branch} failed (continuing with local):`, fetchErr);
  }

  db.prepare(`
    INSERT INTO workspaces (
      id, repository_id, slug, git_branch,
      git_target_branch, state, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(workspaceId, repository_id, workspace_name, placeholderBranchName,
    parent_branch, 'initializing');

  // Branch from origin/<parent_branch> when available (fetched above).
  // Falls back to local <parent_branch> if remote doesn't exist.
  const worktreeBase = await (async () => {
    try {
      await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${parent_branch}`], {
        cwd: repo.root_path!, timeout: 2000,
      });
      return `origin/${parent_branch}`;
    } catch {
      return parent_branch;
    }
  })();

  const workspacePath = path.join(repo.root_path!, '.opendevs', workspace_name);

  // Fire-and-forget: run the init pipeline async (don't await).
  // Pipeline handles: worktree creation → deps install → .env copy → session creation.
  // Progress events flow: stdout → Rust backend.rs → Tauri events → Frontend.
  // On fatal failure: reverse cleanup (rm dir, prune worktree, delete branch).
  initializeWorkspace({
    workspaceId,
    repositoryId: repository_id,
    repoRootPath: repo.root_path!,
    workspacePath,
    branchName: placeholderBranchName,
    worktreeBase,
    parentBranch: parent_branch,
  }).then(() => {
    // Workspace is ready — check for manifest setup script
    const manifest = readManifestWithFallback(workspacePath, repo.root_path!);
    const setupCmd = manifest ? getSetupCommand(manifest) : null;
    if (setupCmd && manifest) {
      db.prepare("UPDATE workspaces SET setup_status = 'running' WHERE id = ?").run(workspaceId);
      const setupEnv = getOpenDevsEnv(manifest, { id: workspaceId, rootPath: repo.root_path!, workspacePath });
      runSetupScript(db, workspaceId, setupCmd, setupEnv, workspacePath);
    }
  }).catch((err) => {
    // Belt-and-suspenders: initializeWorkspace handles its own errors,
    // but if something truly unexpected escapes, don't leave workspace stuck.
    console.error('[WORKSPACE] Unhandled init pipeline error:', err);
    try {
      db.prepare("UPDATE workspaces SET state = 'error', init_stage = 'unhandled', error_message = 'Unhandled init pipeline error' WHERE id = ? AND state = 'initializing'")
        .run(workspaceId);
      invalidate(["workspaces", "stats"]);
    } catch {}
  });

  const workspace = getWorkspaceWithRepo(db, workspaceId);
  if (!workspace) throw new NotFoundError('Workspace not found after creation');

  // Push immediately so clients see the workspace in 'initializing' state.
  // Query-protocol subscribers get snapshots + q:invalidate for unmounted caches.
  // The init pipeline will invalidate again when it transitions to 'ready'.
  invalidate(['workspaces', 'stats']);

  return c.json({ ...workspace, workspace_path: computeWorkspacePath(workspace) });
});

// List all sessions for a workspace (used by chat tab reconstruction)
app.get('/workspaces/:id/sessions', (c) => {
  const db = getDatabase();
  const workspaceId = c.req.param('id');
  const workspace = getWorkspaceRaw(db, workspaceId);
  if (!workspace) throw new NotFoundError('Workspace not found');
  const sessions = getSessionsByWorkspaceId(db, workspaceId);
  return c.json(sessions);
});

// Create a new session for an existing workspace
app.post('/workspaces/:id/sessions', (c) => {
  const db = getDatabase();
  const workspaceId = c.req.param('id');

  const workspace = getWorkspaceRaw(db, workspaceId);
  if (!workspace) throw new NotFoundError('Workspace not found');

  const sessionId = uuidv7();

  const createSession = db.transaction(() => {
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, status, updated_at) VALUES (?, ?, 'idle', datetime('now'))"
    ).run(sessionId, workspaceId);

    db.prepare(
      "UPDATE workspaces SET current_session_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId, workspaceId);
  });

  createSession();
  invalidate(['workspaces', 'sessions', 'stats']);

  const session = getSessionRaw(db, sessionId);
  return c.json(session);
});

// ─── Manifest & Task Endpoints ──────────────────────────────

// Get parsed manifest + normalized tasks for a workspace
app.get('/workspaces/:id/manifest', withWorkspace, (c) => {
  const workspace = c.get('workspace');
  const workspacePath = c.get('workspacePath');
  if (!workspace.root_path) {
    return c.json({ manifest: null, tasks: [] });
  }
  const manifest = readManifestWithFallback(workspacePath, workspace.root_path);
  if (!manifest) return c.json({ manifest: null, tasks: [] });
  const tasks = getNormalizedTasks(manifest);
  return c.json({ manifest, tasks });
});

// Retry failed setup
app.post('/workspaces/:id/retry-setup', withWorkspace, (c) => {
  const db = getDatabase();
  const workspace = c.get('workspace');
  const workspacePath = c.get('workspacePath');

  if (workspace.setup_status !== 'failed') {
    throw new ValidationError('Can only retry when setup_status is failed');
  }

  if (!workspace.root_path) {
    throw new ValidationError('Repository path not found');
  }

  // Re-read manifest (AI agent may have fixed it, or it was added to repo root via settings)
  const manifest = readManifestWithFallback(workspacePath, workspace.root_path);
  const setupCmd = manifest ? getSetupCommand(manifest) : null;
  if (!setupCmd || !manifest) {
    db.prepare("UPDATE workspaces SET setup_status = 'none', error_message = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(workspace.id);
    return c.json({ setup_status: 'none' });
  }

  db.prepare("UPDATE workspaces SET setup_status = 'running', error_message = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(workspace.id);

  const setupEnv = getOpenDevsEnv(manifest, {
    id: workspace.id,
    rootPath: workspace.root_path,
    workspacePath,
  });
  runSetupScript(db, workspace.id, setupCmd, setupEnv, workspacePath);

  return c.json({ setup_status: 'running' });
});

// Get setup logs
app.get('/workspaces/:id/setup-logs', withWorkspace, (c) => {
  const workspace = c.get('workspace');
  const setupLogPath = path.join(os.tmpdir(), `opendevs-${workspace.id}-setup.log`);
  try {
    if (!fs.existsSync(setupLogPath)) return c.json({ logs: null });
    const logs = fs.readFileSync(setupLogPath, 'utf8');
    return c.json({ logs });
  } catch {
    return c.json({ logs: null });
  }
});

// Run a task — validates task exists, returns info for frontend PTY spawn
app.post('/workspaces/:id/tasks/:name/run', withWorkspace, (c) => {
  const workspace = c.get('workspace');
  const workspacePath = c.get('workspacePath');
  const taskName = c.req.param('name');

  if (!workspace.root_path) {
    throw new ValidationError('Repository path not found');
  }

  const manifest = readManifestWithFallback(workspacePath, workspace.root_path);
  if (!manifest) throw new NotFoundError('No opendevs.json manifest found');

  const tasks = getNormalizedTasks(manifest);
  const task = tasks.find(t => t.name === taskName);
  if (!task) throw new NotFoundError(`Task "${taskName}" not found in manifest`);

  const ptyId = `task-${workspace.id}-${taskName}-${Date.now()}`;
  const env = {
    ...(manifest.env ?? {}),
    ...task.env,
    OPENDEVS_ROOT_PATH: workspace.root_path,
    OPENDEVS_WORKSPACE_PATH: workspacePath,
    OPENDEVS_WORKSPACE_ID: workspace.id,
  };

  return c.json({
    ptyId,
    command: task.command,
    cwd: workspacePath,
    env,
    persistent: task.persistent,
    mode: task.mode,
  });
});

export default app;
