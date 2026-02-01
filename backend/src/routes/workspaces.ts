import { Hono } from 'hono';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, execFileSync, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { getDatabase } from '../lib/database';
import { withWorkspace } from '../middleware/workspace-loader';
import { NotFoundError, ValidationError } from '../lib/errors';
import * as gitService from '../services/git.service';
import { generateUniqueCityName } from '../services/workspace.service';

type Env = { Variables: { workspace: any; workspacePath: string } };
const app = new Hono<Env>();

app.get('/workspaces', (c) => {
  const db = getDatabase();
  const workspaces = db.prepare(`
    SELECT
      w.id, w.directory_name, w.branch, w.state, w.active_session_id,
      w.unread, w.created_at, w.updated_at,
      r.name as repo_name, r.root_path,
      s.status as session_status, s.is_compacting, s.context_token_count,
      s.unread_count as session_unread,
      (SELECT sent_at FROM session_messages
       WHERE session_id = s.id AND role = 'user'
       ORDER BY created_at DESC LIMIT 1) as latest_message_sent_at
    FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    LEFT JOIN sessions s ON w.active_session_id = s.id
    ORDER BY w.updated_at DESC
    LIMIT 100
  `).all();
  return c.json(workspaces);
});

app.get('/workspaces/by-repo', (c) => {
  const db = getDatabase();
  const state = c.req.query('state');
  const stateFilter = state ? "AND w.state = ?" : "";

  const workspaces = db.prepare(`
    SELECT
      w.id, w.repository_id, w.directory_name, w.branch, w.state,
      w.active_session_id, w.unread, w.created_at, w.updated_at,
      w.parent_branch,
      r.name as repo_name, r.display_order as repo_display_order, r.root_path,
      r.default_branch,
      s.status as session_status, s.is_compacting, s.context_token_count,
      s.unread_count as session_unread,
      (SELECT sent_at FROM session_messages
       WHERE session_id = s.id AND role = 'user'
       ORDER BY created_at DESC LIMIT 1) as latest_message_sent_at
    FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    LEFT JOIN sessions s ON w.active_session_id = s.id
    ${stateFilter}
    ORDER BY r.display_order, r.name, w.updated_at DESC
  `).all(...(state ? [state] : []));

  const grouped: Record<string, any> = {};
  (workspaces as any[]).forEach(workspace => {
    const repoId = workspace.repository_id || 'unknown';
    if (!grouped[repoId]) {
      grouped[repoId] = {
        repo_id: repoId,
        repo_name: workspace.repo_name || 'Unknown',
        display_order: workspace.repo_display_order || 999,
        workspaces: []
      };
    }
    grouped[repoId].workspaces.push(workspace);
  });

  const result = Object.values(grouped).sort((a: any, b: any) => a.display_order - b.display_order);
  return c.json(result);
});

app.get('/workspaces/:id', (c) => {
  const db = getDatabase();
  const workspace = db.prepare(`
    SELECT w.*, r.name as repo_name, r.root_path,
           s.status as session_status, s.is_compacting, s.context_token_count,
           (SELECT sent_at FROM session_messages
            WHERE session_id = s.id AND role = 'user'
            ORDER BY created_at DESC LIMIT 1) as latest_message_sent_at
    FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    LEFT JOIN sessions s ON w.active_session_id = s.id
    WHERE w.id = ?
  `).get(c.req.param('id'));

  if (!workspace) throw new NotFoundError('Workspace not found');
  return c.json(workspace);
});

app.patch('/workspaces/:id', async (c) => {
  const db = getDatabase();
  const { state } = await c.req.json();
  if (state) {
    db.prepare('UPDATE workspaces SET state = ? WHERE id = ?').run(state, c.req.param('id'));
  }
  const updated = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(c.req.param('id'));
  return c.json(updated);
});

// Diff stats - uses withWorkspace middleware
app.get('/workspaces/:id/diff-stats', withWorkspace, (c) => {
  const workspace = c.get('workspace') as any;
  const workspacePath = c.get('workspacePath') as string;
  const parentBranch = gitService.resolveParentBranch(workspacePath, workspace.parent_branch, workspace.default_branch);
  const stats = gitService.getDiffStats(workspacePath, parentBranch);
  return c.json(stats);
});

// Diff files
app.get('/workspaces/:id/diff-files', withWorkspace, (c) => {
  const workspace = c.get('workspace') as any;
  const workspacePath = c.get('workspacePath') as string;
  const parentBranch = gitService.resolveParentBranch(workspacePath, workspace.parent_branch, workspace.default_branch);
  const files = gitService.getDiffFiles(workspacePath, parentBranch);
  return c.json({ files });
});

// Diff file content
app.get('/workspaces/:id/diff-file', withWorkspace, (c) => {
  const file = c.req.query('file');
  if (!file) throw new ValidationError('file parameter is required');

  const workspace = c.get('workspace') as any;
  const workspacePath = c.get('workspacePath') as string;
  const parentBranch = gitService.resolveParentBranch(workspacePath, workspace.parent_branch, workspace.default_branch);
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
    else { newContent = gitService.getGitFileContent(workspacePath, 'HEAD', safeNewPath); }

    return c.json({ file, diff: output, old_content: oldContent, new_content: newContent });
  } catch (gitError: any) {
    const errorResponse: any = {
      error: 'diff_failed', message: 'Failed to get diff', retryable: true,
      details: { file, parentBranch, reason: null as string | null }
    };
    if (gitError.killed) { errorResponse.message = 'Diff operation timed out'; errorResponse.details.reason = 'timeout'; }
    else if (gitError.message?.includes('unknown revision')) { errorResponse.message = 'Parent branch not found'; errorResponse.details.reason = 'branch_not_found'; errorResponse.retryable = false; }
    else if (gitError.message?.includes('not a git repository')) { errorResponse.message = 'Not a git repository'; errorResponse.details.reason = 'not_git_repo'; errorResponse.retryable = false; }
    else { errorResponse.details.reason = 'git_error'; errorResponse.details.errorMessage = gitError.message; }
    return c.json(errorResponse, 500);
  }
});

// PR status
app.get('/workspaces/:id/pr-status', withWorkspace, (c) => {
  const workspacePath = c.get('workspacePath') as string;
  try {
    const output = execFileSync('gh', ['pr', 'view', '--json', 'number,title,url,mergeable'], {
      cwd: workspacePath, encoding: 'utf-8', timeout: 5000
    }).toString().trim();
    const prData = JSON.parse(output);
    return c.json({
      has_pr: true, pr_number: prData.number, pr_title: prData.title,
      pr_url: prData.url, merge_status: prData.mergeable === 'MERGEABLE' ? 'ready' : 'blocked'
    });
  } catch {
    return c.json({ has_pr: false });
  }
});

// Pen files
app.get('/workspaces/:id/pen-files', withWorkspace, (c) => {
  const workspacePath = c.get('workspacePath') as string;
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
  const { filePath } = await c.req.json();
  if (!filePath) throw new ValidationError('filePath is required');

  const workspacePath = c.get('workspacePath') as string;
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
  const { repository_id } = await c.req.json();
  if (!repository_id) throw new ValidationError('repository_id is required');

  const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(repository_id) as any;
  if (!repo) throw new NotFoundError('Repository not found');

  const workspace_name = generateUniqueCityName(db);
  const parent_branch = repo.default_branch || 'main';
  const workspaceId = randomUUID();

  let branchPrefix = 'workspace';
  try {
    const gitUser = execSync('git config user.name', { cwd: repo.root_path, encoding: 'utf8' })
      .trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (gitUser) branchPrefix = gitUser;
  } catch {}
  const placeholderBranchName = `${branchPrefix}/${workspace_name}`;

  const tmpDir = os.tmpdir();
  const initLogPath = path.join(tmpDir, `conductor-${Date.now()}-init.log`);

  db.prepare(`
    INSERT INTO workspaces (
      id, repository_id, directory_name, branch, placeholder_branch_name,
      parent_branch, state, initialization_log_path,
      initialization_files_copied, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(workspaceId, repository_id, workspace_name, placeholderBranchName,
    placeholderBranchName, parent_branch, 'initializing', initLogPath, 0);

  const workspacePath = path.join(repo.root_path, '.conductor', workspace_name);
  const initLog = fs.createWriteStream(initLogPath);
  const worktreeProcess = spawn('git', [
    'worktree', 'add', '-b', placeholderBranchName, workspacePath, parent_branch
  ], { cwd: repo.root_path, stdio: ['ignore', 'pipe', 'pipe'] });

  worktreeProcess.stdout.pipe(initLog);
  worktreeProcess.stderr.pipe(initLog);

  worktreeProcess.on('close', (code) => {
    try { initLog.end(); } catch {}
    if (code === 0) {
      const sessionId = randomUUID();
      db.prepare("INSERT INTO sessions (id, status, created_at, updated_at) VALUES (?, 'idle', datetime('now'), datetime('now'))").run(sessionId);
      db.prepare("UPDATE workspaces SET state = 'ready', active_session_id = ?, updated_at = datetime('now') WHERE id = ?").run(sessionId, workspaceId);
    } else {
      db.prepare("UPDATE workspaces SET state = 'error', updated_at = datetime('now') WHERE id = ?").run(workspaceId);
    }
  });

  const workspace = db.prepare(`
    SELECT w.*, r.name as repo_name, r.root_path
    FROM workspaces w LEFT JOIN repos r ON w.repository_id = r.id WHERE w.id = ?
  `).get(workspaceId);

  return c.json(workspace);
});

export default app;
