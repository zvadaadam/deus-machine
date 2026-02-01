#!/usr/bin/env node

/**
 * Conductor Backend Server
 *
 * Main entry point for the modular backend server.
 * Uses clean module separation for maintainability.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const { randomUUID } = require('crypto');

// Import our modular components
const { initDatabase, getDatabase, closeDatabase, DB_PATH } = require('./lib/database.cjs');
const { startClaudeSession, sendToClaudeSession, stopClaudeSession, stopAllClaudeSessions } = require('./lib/claude-session.cjs');
const { startSidecar, sendToSidecar, getSidecarStatus, stopSidecar } = require('./lib/sidecar/index.cjs');
const { getMcpServers, saveMcpServers, getCommands, saveCommand, deleteCommand,
        getAgents, saveAgent, deleteAgent, getHooks, saveHooks } = require('./lib/config.cjs');
const { generateUniqueCityName } = require('./lib/workspace.cjs');

const app = express();
// Use environment variable PORT, or let OS assign available port (0 = auto-assign)
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 0;

// Middleware
app.use(cors());
app.use(express.json());

// Global variable to store actual port
let actualServerPort = null;
const parentBranchCache = new Map();
const PARENT_BRANCH_CACHE_TTL_MS = 5000;

// Initialize database
const db = initDatabase();

/**
 * Helper function to verify if a git branch exists locally
 */
function verifyBranchExists(root_path, branch) {
  const checks = [
    `refs/heads/${branch}`,
    `refs/remotes/origin/${branch}`,
    'refs/heads/main',
    'refs/heads/master',
  ];
  for (const ref of checks) {
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', ref], { cwd: root_path, timeout: 2000 });
      if (ref.endsWith('/main')) return 'main';
      if (ref.endsWith('/master')) return 'master';
      return branch;
    } catch {}
  }
  // Final safe default
  return 'main';
}

/**
 * Detect the default branch for a git repository
 * Tries multiple strategies with fallbacks
 */
function detectDefaultBranch(root_path) {
  const strategies = [
    {
      name: 'origin HEAD',
      fn: () => {
        const output = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
          cwd: root_path,
          encoding: 'utf-8',
          timeout: 2000
        }).trim();
        return output.replace(/^refs\/remotes\/origin\//, '');
      }
    },
    {
      name: 'current branch',
      fn: () => execFileSync('git', ['branch', '--show-current'], {
        cwd: root_path,
        encoding: 'utf-8',
        timeout: 2000
      }).trim()
    },
    {
      name: 'default fallback',
      fn: () => 'main'
    }
  ];

  for (const strategy of strategies) {
    try {
      const branch = strategy.fn();
      if (branch) {
        console.log(`Detected default branch '${branch}' using ${strategy.name}`);
        return verifyBranchExists(root_path, branch);
      }
    } catch (err) {
      console.warn(`Failed to detect branch using ${strategy.name}`);
    }
  }

  return 'main';
}

/**
 * Resolve the parent branch for a workspace with fallback strategy
 * This is called dynamically on each diff request to handle branch changes
 *
 * @param {string} workspacePath - Full path to workspace directory
 * @param {string|null} parentBranch - Workspace's configured parent branch
 * @param {string|null} defaultBranch - Repository's default branch
 * @returns {string} The resolved branch ref (e.g., "origin/main")
 */
function resolveParentBranch(workspacePath, parentBranch, defaultBranch) {
  const cacheKey = `${workspacePath}::${parentBranch || ''}::${defaultBranch || ''}`;
  const cached = parentBranchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.branch;
  }

  // Priority order: parent_branch → default_branch → main → master → develop
  const candidates = [
    parentBranch,
    defaultBranch,
    'main',
    'master',
    'develop',
  ].filter(Boolean);

  for (const branch of candidates) {
    const ref = `origin/${branch}`;
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`], {
        cwd: workspacePath,
        timeout: 2000
      });
      parentBranchCache.set(cacheKey, {
        branch: ref,
        expiresAt: Date.now() + PARENT_BRANCH_CACHE_TTL_MS
      });
      return ref; // Branch exists
    } catch {
      // Branch doesn't exist, try next
    }
  }

  // Try local branches if no remote branch is found
  for (const branch of candidates) {
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: workspacePath,
        timeout: 2000
      });
      const resolved = branch;
      parentBranchCache.set(cacheKey, {
        branch: resolved,
        expiresAt: Date.now() + PARENT_BRANCH_CACHE_TTL_MS
      });
      return resolved;
    } catch {
      // Local branch doesn't exist, try next
    }
  }

  const fallback = defaultBranch || 'main';
  parentBranchCache.set(cacheKey, {
    branch: fallback,
    expiresAt: Date.now() + PARENT_BRANCH_CACHE_TTL_MS
  });
  return fallback;
}

function resolveWorkspaceRelativePath(workspacePath, filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  if (filePath.includes('\0')) return null;

  const normalized = path.normalize(filePath);
  if (path.isAbsolute(normalized)) return null;

  const resolved = path.resolve(workspacePath, normalized);
  const relative = path.relative(workspacePath, resolved);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return relative;
}

function normalizeGitPath(pathToken) {
  if (!pathToken || typeof pathToken !== 'string') return null;
  let cleaned = pathToken.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  }
  if (cleaned.startsWith('a/')) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('b/')) {
    cleaned = cleaned.slice(2);
  }
  return cleaned;
}

function splitGitDiffTokens(value) {
  if (!value) return [];
  const tokens = [];
  let i = 0;
  while (i < value.length && tokens.length < 2) {
    while (value[i] === ' ') i += 1;
    if (i >= value.length) break;
    if (value[i] === '"') {
      let end = i + 1;
      while (end < value.length && value[end] !== '"') end += 1;
      tokens.push(value.slice(i + 1, Math.min(end, value.length)));
      i = end + 1;
    } else {
      let end = i;
      while (end < value.length && value[end] !== ' ') end += 1;
      tokens.push(value.slice(i, end));
      i = end + 1;
    }
  }
  return tokens;
}

function extractDiffInfo(diffOutput) {
  let oldPath = null;
  let newPath = null;
  let isNew = false;
  let isDeleted = false;

  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const tokens = splitGitDiffTokens(line.slice('diff --git '.length));
      if (tokens[0]) oldPath = normalizeGitPath(tokens[0]);
      if (tokens[1]) newPath = normalizeGitPath(tokens[1]);
      continue;
    }
    if (line.startsWith('rename from ')) {
      oldPath = normalizeGitPath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      newPath = normalizeGitPath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('new file mode')) {
      isNew = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      isDeleted = true;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const match = line.match(/^(---|\+\+\+)\s+([^\t\r\n]+)(.*)$/);
      if (!match) continue;
      const [, prefix, fileName] = match;
      if (fileName === '/dev/null') {
        if (prefix === '---') isNew = true;
        if (prefix === '+++') isDeleted = true;
        continue;
      }
      if (prefix === '---' && !oldPath) {
        oldPath = normalizeGitPath(fileName);
      } else if (prefix === '+++' && !newPath) {
        newPath = normalizeGitPath(fileName);
      }
    }
  }

  return { oldPath, newPath, isNew, isDeleted };
}

function getGitFileContent(workspacePath, ref, filePath) {
  if (!filePath) return null;
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000
    }).toString();
  } catch {
    return null;
  }
}

function getMergeBase(workspacePath, parentBranch) {
  try {
    return execFileSync('git', ['merge-base', parentBranch, 'HEAD'], {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 5000
    }).toString().trim();
  } catch {
    return parentBranch;
  }
}

function getOpenCommand(target) {
  if (process.platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', 'start', '', target] };
  }
  if (process.platform === 'darwin') {
    return { cmd: 'open', args: [target] };
  }
  return { cmd: 'xdg-open', args: [target] };
}

// Initialize settings table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

console.log('✅ All modules loaded successfully');

//============================================================================
// GLOBAL ERROR HANDLERS
//============================================================================

// Handle uncaught exceptions - exit gracefully and let process manager restart
process.on('uncaughtException', (error, origin) => {
  console.error('\n❌ [FATAL] Uncaught Exception:');
  console.error('Origin:', origin);
  console.error('Error:', error);
  console.error('Stack:', error.stack);
  console.error('Time:', new Date().toISOString());
  // Process may be in an undefined state after uncaught exception.
  // Clean up and exit; the process manager (Tauri sidecar) will restart us.
  try {
    stopSidecar();
    stopAllClaudeSessions();
    closeDatabase();
  } catch {
    // Best-effort cleanup
  }
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ [FATAL] Unhandled Promise Rejection:');
  console.error('Promise:', promise);
  console.error('Reason:', reason);
  if (reason instanceof Error) {
    console.error('Stack:', reason.stack);
  }
  console.error('Time:', new Date().toISOString());
  // Don't exit - try to keep server running
});

// Log when server is about to crash for any reason
process.on('beforeExit', (code) => {
  console.log(`\n⚠️  Process is about to exit with code: ${code}`);
});

console.log('✅ Global error handlers installed');

//============================================================================
// HEALTH & DISCOVERY ENDPOINTS
//============================================================================

// Comprehensive health check endpoint
// Returns server port for discovery + database/sidecar status
app.get('/api/health', (req, res) => {
  const sidecarStatus = getSidecarStatus();
  res.json({
    app: 'conductor-backend',
    status: 'ok',
    port: actualServerPort,
    timestamp: new Date().toISOString(),
    database: db ? 'connected' : 'disconnected',
    sidecar: sidecarStatus.running ? 'running' : 'stopped',
    socket: sidecarStatus.connected ? 'connected' : 'disconnected'
  });
});

// Simple port endpoint for easy discovery
app.get('/api/port', (req, res) => {
  res.json({ port: actualServerPort });
});

//============================================================================
// CONFIGURATION ENDPOINTS
//============================================================================

// MCP Servers
app.get('/api/config/mcp-servers', (req, res) => {
  try {
    const servers = getMcpServers();
    res.json(servers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/config/mcp-servers', (req, res) => {
  try {
    const { servers } = req.body;
    if (!Array.isArray(servers)) {
      return res.status(400).json({ error: 'servers must be an array' });
    }
    const success = saveMcpServers(servers);
    res.json({ success, servers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Commands
app.get('/api/config/commands', (req, res) => {
  try {
    res.json(getCommands());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/config/commands', (req, res) => {
  try {
    const { name, content } = req.body;
    if (!name || !content) {
      return res.status(400).json({ error: 'name and content are required' });
    }
    const success = saveCommand(name, content);
    res.json({ success, name, content });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/config/commands/:name', (req, res) => {
  try {
    const success = deleteCommand(req.params.name);
    res.json({ success });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Agents
app.get('/api/config/agents', (req, res) => {
  try {
    res.json(getAgents());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/config/agents', (req, res) => {
  try {
    const { id, ...agentData } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }
    const success = saveAgent(id, agentData);
    res.json({ success, id, ...agentData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/config/agents/:id', (req, res) => {
  try {
    const success = deleteAgent(req.params.id);
    res.json({ success });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Hooks
app.get('/api/config/hooks', (req, res) => {
  try {
    res.json(getHooks());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/config/hooks', (req, res) => {
  try {
    const { hooks } = req.body;
    if (!hooks || typeof hooks !== 'object') {
      return res.status(400).json({ error: 'hooks must be an object' });
    }
    const success = saveHooks(hooks);
    res.json({ success, hooks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//============================================================================
// SETTINGS ENDPOINTS
//============================================================================

// Get all settings
app.get('/api/settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();

    // Convert rows to object with parsed JSON values
    const settings = {};
    rows.forEach(row => {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch (e) {
        settings[row.key] = row.value;
      }
    });

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save a setting
app.post('/api/settings', (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key) {
      return res.status(400).json({ error: 'key is required' });
    }

    // Serialize value to JSON
    const serializedValue = JSON.stringify(value);

    // Insert or update
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `).run(key, serializedValue);

    res.json({ success: true, key, value });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//============================================================================
// WORKSPACE ENDPOINTS
//============================================================================

app.get('/api/workspaces', (req, res) => {
  try {
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

    res.json(workspaces);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/workspaces/by-repo', (req, res) => {
  try {
    const { state } = req.query;
    let stateFilter = state ? "AND w.state = ?" : "";

    const workspaces = db.prepare(`
      SELECT
        w.id, w.repository_id, w.directory_name, w.branch, w.state,
        w.active_session_id, w.unread, w.created_at, w.updated_at,
        r.name as repo_name, r.display_order as repo_display_order, r.root_path,
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

    // Group by repository
    const grouped = {};
    workspaces.forEach(workspace => {
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

    const result = Object.values(grouped).sort((a, b) => a.display_order - b.display_order);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/workspaces/:id', (req, res) => {
  try {
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
    `).get(req.params.id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    res.json(workspace);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/workspaces/:id', (req, res) => {
  try {
    const { state } = req.body;

    if (state) {
      db.prepare('UPDATE workspaces SET state = ? WHERE id = ?')
        .run(state, req.params.id);
    }

    const updated = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get diff stats for a workspace
app.get('/api/workspaces/:id/diff-stats', async (req, res) => {
  try {
    const workspace = db.prepare(`
      SELECT w.*, r.root_path, r.default_branch
      FROM workspaces w
      LEFT JOIN repos r ON w.repository_id = r.id
      WHERE w.id = ?
    `).get(req.params.id);

    if (!workspace || !workspace.root_path || !workspace.directory_name) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);
    const parentBranch = resolveParentBranch(workspacePath, workspace.parent_branch, workspace.default_branch);

    // Get git diff stats comparing against remote parent branch
    // This ensures we always compare against the latest remote state
    try {
      const output = execFileSync(
        'git',
        ['diff', `${parentBranch}...HEAD`, '--shortstat'],
        {
          cwd: workspacePath,
          encoding: 'utf-8',
          timeout: 5000
        }
      ).toString().trim();

      // Parse output like: "3 files changed, 45 insertions(+), 12 deletions(-)"
      const additions = output.match(/(\d+)\s+insertion(?:s)?/)?.[1] || '0';
      const deletions = output.match(/(\d+)\s+deletion(?:s)?/)?.[1] || '0';

      res.json({
        additions: parseInt(additions, 10),
        deletions: parseInt(deletions, 10)
      });
    } catch (gitError) {
      // No changes or git error
      res.json({ additions: 0, deletions: 0 });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get diff files for a workspace
app.get('/api/workspaces/:id/diff-files', async (req, res) => {
  try {
    const workspace = db.prepare(`
      SELECT w.*, r.root_path, r.default_branch
      FROM workspaces w
      LEFT JOIN repos r ON w.repository_id = r.id
      WHERE w.id = ?
    `).get(req.params.id);

    if (!workspace || !workspace.root_path || !workspace.directory_name) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);
    const parentBranch = resolveParentBranch(workspacePath, workspace.parent_branch, workspace.default_branch);

    try {
      const output = execFileSync(
        'git',
        ['diff', `${parentBranch}...HEAD`, '--numstat'],
        {
          cwd: workspacePath,
          encoding: 'utf-8',
          timeout: 5000
        }
      ).toString().trim();

      if (!output) {
        return res.json({ files: [] });
      }

      // Parse lines like: "45\t12\tpath/to/file.js"
      const files = output.split('\n').map(line => {
        const [additions, deletions, file] = line.split('\t');
        return {
          file,
          additions: parseInt(additions, 10) || 0,
          deletions: parseInt(deletions, 10) || 0
        };
      });

      res.json({ files });
    } catch (gitError) {
      res.json({ files: [] });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get diff content for a specific file in a workspace
app.get('/api/workspaces/:id/diff-file', async (req, res) => {
  try {
    const { file } = req.query;

    if (!file) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'file parameter is required',
        retryable: false
      });
    }

    const workspace = db.prepare(`
      SELECT w.*, r.root_path, r.default_branch
      FROM workspaces w
      LEFT JOIN repos r ON w.repository_id = r.id
      WHERE w.id = ?
    `).get(req.params.id);

    if (!workspace || !workspace.root_path || !workspace.directory_name) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Workspace not found',
        retryable: false
      });
    }

    const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);
    const parentBranch = resolveParentBranch(workspacePath, workspace.parent_branch, workspace.default_branch);
    const safeFilePath = resolveWorkspaceRelativePath(workspacePath, file);

    if (!safeFilePath) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'Invalid file path',
        retryable: false
      });
    }

    try {
      const output = execFileSync(
        'git',
        ['diff', `${parentBranch}...HEAD`, '--', safeFilePath],
        {
          cwd: workspacePath,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
          timeout: 5000
        }
      ).toString();

      const diffInfo = extractDiffInfo(output);
      const mergeBase = getMergeBase(workspacePath, parentBranch);
      const safeOldPath =
        resolveWorkspaceRelativePath(workspacePath, diffInfo.oldPath || safeFilePath) ||
        safeFilePath;
      const safeNewPath =
        resolveWorkspaceRelativePath(workspacePath, diffInfo.newPath || safeFilePath) ||
        safeFilePath;

      let oldContent = null;
      let newContent = null;

      if (diffInfo.isNew) {
        oldContent = '';
      } else {
        oldContent = getGitFileContent(workspacePath, mergeBase, safeOldPath);
      }

      if (diffInfo.isDeleted) {
        newContent = '';
      } else {
        newContent = getGitFileContent(workspacePath, 'HEAD', safeNewPath);
      }

      res.json({
        file,
        diff: output,
        old_content: oldContent,
        new_content: newContent
      });
    } catch (gitError) {
      // Structured error response with details for debugging
      const errorResponse = {
        error: 'diff_failed',
        message: 'Failed to get diff',
        retryable: true,
        details: {
          file,
          parentBranch,
          reason: null
        }
      };

      if (gitError.killed) {
        errorResponse.message = 'Diff operation timed out';
        errorResponse.details.reason = 'timeout';
      } else if (gitError.message?.includes('unknown revision')) {
        errorResponse.message = 'Parent branch not found';
        errorResponse.details.reason = 'branch_not_found';
        errorResponse.retryable = false;
      } else if (gitError.message?.includes('not a git repository')) {
        errorResponse.message = 'Not a git repository';
        errorResponse.details.reason = 'not_git_repo';
        errorResponse.retryable = false;
      } else {
        errorResponse.details.reason = 'git_error';
        errorResponse.details.errorMessage = gitError.message;
      }

      res.status(500).json(errorResponse);
    }
  } catch (error) {
    res.status(500).json({
      error: 'server_error',
      message: error.message,
      retryable: true
    });
  }
});

// Get PR status for a workspace
app.get('/api/workspaces/:id/pr-status', async (req, res) => {
  try {
    const workspace = db.prepare(`
      SELECT w.*, r.root_path
      FROM workspaces w
      LEFT JOIN repos r ON w.repository_id = r.id
      WHERE w.id = ?
    `).get(req.params.id);

    if (!workspace || !workspace.root_path || !workspace.directory_name) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);

    try {
      // Check if branch has a PR using gh CLI
      const output = execFileSync(
        'gh',
        ['pr', 'view', '--json', 'number,title,url,mergeable'],
        {
          cwd: workspacePath,
          encoding: 'utf-8',
          timeout: 5000
        }
      ).toString().trim();

      const prData = JSON.parse(output);

      res.json({
        has_pr: true,
        pr_number: prData.number,
        pr_title: prData.title,
        pr_url: prData.url,
        merge_status: prData.mergeable === 'MERGEABLE' ? 'ready' : 'blocked'
      });
    } catch (gitError) {
      // No PR found
      res.json({ has_pr: false });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Find .pen design files in a workspace
app.get('/api/workspaces/:id/pen-files', async (req, res) => {
  try {
    const workspace = db.prepare(`
      SELECT w.*, r.root_path
      FROM workspaces w
      LEFT JOIN repos r ON w.repository_id = r.id
      WHERE w.id = ?
    `).get(req.params.id);

    if (!workspace || !workspace.root_path || !workspace.directory_name) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);

    const MAX_PEN_SCAN_DEPTH = 10;
    const MAX_PEN_FILES = 500;

    function findPenFiles(dirPath, relativeTo, depth = 0, results = []) {
      if (depth > MAX_PEN_SCAN_DEPTH || results.length >= MAX_PEN_FILES) {
        return results;
      }
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            findPenFiles(fullPath, relativeTo, depth + 1, results);
          } else if (entry.isFile() && entry.name.endsWith('.pen')) {
            results.push({
              name: entry.name,
              path: path.relative(relativeTo, fullPath),
            });
            if (results.length >= MAX_PEN_FILES) {
              return results;
            }
          }
        }
      } catch (e) {
        // skip unreadable directories
      }
      return results;
    }

    const files = findPenFiles(workspacePath, workspacePath);
    res.json({ files, count: files.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Open a .pen file in the Pencil desktop app
app.post('/api/workspaces/:id/open-pen-file', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }

    const workspace = db.prepare(`
      SELECT w.*, r.root_path
      FROM workspaces w
      LEFT JOIN repos r ON w.repository_id = r.id
      WHERE w.id = ?
    `).get(req.params.id);

    if (!workspace || !workspace.root_path || !workspace.directory_name) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);
    const safeRelativePath = resolveWorkspaceRelativePath(workspacePath, filePath);
    if (!safeRelativePath) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    const absolutePath = path.resolve(workspacePath, safeRelativePath);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Open file via Pencil if available; fallback to default app association.
    // This avoids macOS routing .pen files back into Conductor if it becomes the default handler.
    const envPencilApp = process.env.PENCIL_APP_NAME || process.env.PENCIL_APP;
    const pencilCandidates = [
      envPencilApp,
      '/Applications/Pencil.app',
      path.join(os.homedir(), 'Applications', 'Pencil.app'),
      'Pencil',
    ].filter(Boolean);

    let pencilApp = null;
    for (const candidate of pencilCandidates) {
      if (candidate.endsWith('.app') || candidate.startsWith('/')) {
        if (fs.existsSync(candidate)) {
          pencilApp = candidate;
          break;
        }
      } else {
        pencilApp = candidate;
        break;
      }
    }

    if (process.platform === 'darwin' && pencilApp) {
      console.log(`[pen] Opening file (Pencil):`, absolutePath);
      const child = spawn('open', ['-a', pencilApp, absolutePath], { stdio: 'ignore' });
      let didFallback = false;
      const fallbackToWeb = () => {
        if (didFallback) return;
        didFallback = true;
        console.warn('[pen] Pencil open failed, opening pencil.dev:', absolutePath);
        const { cmd, args } = getOpenCommand('https://pencil.dev');
        const webChild = spawn(cmd, args, { stdio: 'ignore' });
        webChild.unref();
      };
      child.on('error', fallbackToWeb);
      child.on('exit', (code) => {
        if (code !== 0) fallbackToWeb();
      });
      child.unref();
    } else {
      console.warn('[pen] Pencil app not found, opening pencil.dev:', absolutePath);
      const { cmd, args } = getOpenCommand('https://pencil.dev');
      const webChild = spawn(cmd, args, { stdio: 'ignore' });
      webChild.unref();
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get dev servers for a workspace
app.get('/api/workspaces/:id/dev-servers', async (req, res) => {
  try {
    // For now, return empty array - this feature can be implemented later
    // when we track dev servers per workspace
    res.json({ servers: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/workspaces', async (req, res) => {
  try {
    const { repository_id } = req.body;

    if (!repository_id) {
      return res.status(400).json({ error: 'repository_id is required' });
    }

    const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(repository_id);
    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    const workspace_name = generateUniqueCityName(db);
    const parent_branch = repo.default_branch || 'main';
    const workspaceId = randomUUID();
    // Derive branch prefix from git config or fall back to a generic prefix
    let branchPrefix = 'workspace';
    try {
      const gitUser = require('child_process')
        .execSync('git config user.name', { cwd: repo.path, encoding: 'utf8' })
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-');
      if (gitUser) branchPrefix = gitUser;
    } catch {
      // Fall back to generic prefix if git config is not available
    }
    const placeholderBranchName = `${branchPrefix}/${workspace_name}`;

    const tmpDir = os.tmpdir();
    const initLogPath = path.join(tmpDir, `conductor-${Date.now()}-init.log`);

    db.prepare(`
      INSERT INTO workspaces (
        id, repository_id, directory_name, branch, placeholder_branch_name,
        parent_branch, state, initialization_log_path,
        initialization_files_copied, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      workspaceId, repository_id, workspace_name, placeholderBranchName,
      placeholderBranchName, parent_branch, 'initializing',
      initLogPath, 0
    );

    console.log(`\n🚀 Creating workspace: ${workspace_name}`);
    const workspacePath = path.join(repo.root_path, '.conductor', workspace_name);

    // Create git worktree in background (implementation matches original)
    const initLog = fs.createWriteStream(initLogPath);
    const worktreeProcess = spawn('git', [
      'worktree', 'add', '-b', placeholderBranchName,
      workspacePath, parent_branch
    ], { cwd: repo.root_path, stdio: ['ignore', 'pipe', 'pipe'] });

    worktreeProcess.stdout.pipe(initLog);
    worktreeProcess.stderr.pipe(initLog);

    worktreeProcess.on('close', (code) => {
      try { initLog.end(); } catch {}
      if (code === 0) {
        console.log(`✅ Worktree created: ${workspacePath}`);

        // Create initial session
        const sessionId = randomUUID();
        db.prepare('INSERT INTO sessions (id, status, created_at, updated_at) VALUES (?, \'idle\', datetime(\'now\'), datetime(\'now\'))')
          .run(sessionId);

        db.prepare('UPDATE workspaces SET state = \'ready\', active_session_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(sessionId, workspaceId);

        console.log(`✅ Workspace ${workspace_name} is now ready!\n`);
      } else {
        console.error(`❌ Worktree creation failed with code ${code}`);
        db.prepare('UPDATE workspaces SET state = \'error\', updated_at = datetime(\'now\') WHERE id = ?')
          .run(workspaceId);
      }
    });

    const workspace = db.prepare(`
      SELECT w.*, r.name as repo_name, r.root_path
      FROM workspaces w
      LEFT JOIN repos r ON w.repository_id = r.id
      WHERE w.id = ?
    `).get(workspaceId);

    res.json(workspace);
  } catch (error) {
    console.error('Error creating workspace:', error);
    res.status(500).json({ error: error.message });
  }
});

//============================================================================
// SESSION ENDPOINTS
//============================================================================

app.get('/api/sessions', (req, res) => {
  try {
    const sessions = db.prepare(`
      SELECT s.*, w.directory_name, w.state as workspace_state,
             COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN workspaces w ON s.id = w.active_session_id
      LEFT JOIN session_messages m ON m.session_id = s.id
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT 50
    `).all();

    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  try {
    const session = db.prepare(`
      SELECT s.*, w.directory_name, w.state as workspace_state,
             COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN workspaces w ON s.id = w.active_session_id
      LEFT JOIN session_messages m ON m.session_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
    `).get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(session);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:id/messages', (req, res) => {
  try {
    const messages = db.prepare(`
      SELECT * FROM session_messages
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(req.params.id);

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:id/messages', async (req, res) => {
  const sessionId = req.params.id;
  console.log(`\n📨 [MESSAGE SEND] Starting for session ${sessionId?.substring(0, 8)}`);

  try {
    const { content } = req.body;
    console.log(`   Content length: ${content?.length || 0} chars`);

    if (!content || typeof content !== 'string') {
      console.log('   ❌ Invalid content');
      return res.status(400).json({ error: 'content is required and must be a string' });
    }

    console.log('   📝 Validating session...');
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) {
      console.log('   ❌ Session not found');
      return res.status(404).json({ error: 'Session not found' });
    }
    console.log('   ✅ Session found');

    const messageId = randomUUID();
    const sentAt = new Date().toISOString();

    console.log('   📝 Getting last assistant message...');
    // Get the most recent assistant message's sdk_message_id for linking
    const lastAssistantMessage = db.prepare(`
      SELECT sdk_message_id FROM session_messages
      WHERE session_id = ? AND role = 'assistant' AND sdk_message_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId);
    console.log(`   ✅ Last assistant message: ${lastAssistantMessage?.sdk_message_id || 'none'}`);

    console.log('   💾 Inserting message into database...');
    db.prepare(`
      INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model, last_assistant_message_id)
      VALUES (?, ?, 'user', ?, datetime('now'), ?, 'sonnet', ?)
    `).run(messageId, sessionId, content, sentAt, lastAssistantMessage?.sdk_message_id || null);
    console.log('   ✅ Message inserted');

    console.log('   📝 Updating session status...');
    db.prepare('UPDATE sessions SET status = \'working\', updated_at = datetime(\'now\') WHERE id = ?')
      .run(sessionId);
    console.log('   ✅ Session status updated');

    console.log('   📁 Getting workspace info...');
    // Get workspace info to start Claude CLI
    const workspace = db.prepare(`
      SELECT w.*, r.root_path FROM workspaces w
      LEFT JOIN repos r ON w.repository_id = r.id
      WHERE w.active_session_id = ?
    `).get(sessionId);

    if (!workspace || !workspace.root_path || !workspace.directory_name) {
      console.log('   ❌ Workspace not found');
      return res.status(400).json({ error: 'Workspace not found for session' });
    }
    console.log(`   ✅ Workspace: ${workspace.directory_name}`);

    const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);
    console.log(`   📂 Workspace path: ${workspacePath}`);

    console.log('   🚀 Starting Claude session...');
    // Start or get existing Claude CLI session
    startClaudeSession(sessionId, workspacePath);
    console.log('   ✅ Claude session started/resumed');

    console.log('   📤 Sending message to Claude CLI...');
    // Send the user message to Claude CLI
    const sent = sendToClaudeSession(sessionId, content);

    if (!sent) {
      console.warn('   ⚠️  Failed to send message to Claude CLI, but message saved to database');
    } else {
      console.log('   ✅ Message sent to Claude CLI');
    }

    console.log('   📝 Fetching created message...');
    const createdMessage = db.prepare('SELECT * FROM session_messages WHERE id = ?').get(messageId);
    console.log('   ✅ [MESSAGE SEND] Complete!\n');

    res.json(createdMessage);
  } catch (error) {
    console.error('   ❌ [MESSAGE SEND] Error:', error);
    console.error('   Stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Stop/Cancel a running session
 * POST /api/sessions/:id/stop
 *
 * Sets cancelled_at timestamp on the latest user message and stops the Claude process
 */
app.post('/api/sessions/:id/stop', (req, res) => {
  const { id: sessionId } = req.params;

  console.log(`\n🛑 [SESSION CANCEL] Cancelling session ${sessionId.substring(0, 8)}`);

  try {
    // Get the session to verify it exists and is working
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);

    if (!session) {
      console.log('   ❌ Session not found');
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log(`   📋 Session status: ${session.status}`);

    // Get the latest user message that hasn't been cancelled yet
    const latestUserMessage = db.prepare(`
      SELECT * FROM session_messages
      WHERE session_id = ? AND role = 'user' AND cancelled_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId);

    if (latestUserMessage) {
      console.log(`   📝 Marking message ${latestUserMessage.id.substring(0, 8)} as cancelled`);
      db.prepare(`
        UPDATE session_messages
        SET cancelled_at = datetime('now')
        WHERE id = ?
      `).run(latestUserMessage.id);
      console.log('   ✅ Message marked as cancelled');
    } else {
      console.log('   ℹ️  No user message to cancel');
    }

    // Stop the Claude CLI process
    console.log('   🛑 Stopping Claude CLI process...');
    const stopped = stopClaudeSession(sessionId);
    console.log(`   ${stopped ? '✅' : '⚠️ '} Claude process ${stopped ? 'stopped' : 'not found or already stopped'}`);

    // Update session status to idle
    console.log('   📝 Updating session status to idle...');
    db.prepare(`
      UPDATE sessions
      SET status = 'idle',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId);
    console.log('   ✅ Session status updated');

    // Get updated session
    const updatedSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);

    console.log('   ✅ [SESSION CANCEL] Complete!\n');
    res.json({
      success: true,
      session: updatedSession,
      message: latestUserMessage ? 'Session cancelled and message marked' : 'Session cancelled'
    });

  } catch (error) {
    console.error('   ❌ [SESSION CANCEL] Error:', error);
    console.error('   Stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

//============================================================================
// OTHER ENDPOINTS
//============================================================================

app.get('/api/repos', (req, res) => {
  try {
    const repos = db.prepare(`
      SELECT r.*,
             COUNT(CASE WHEN w.state = 'ready' THEN 1 END) as ready_count,
             COUNT(CASE WHEN w.state = 'archived' THEN 1 END) as archived_count,
             COUNT(w.id) as total_count
      FROM repos r
      LEFT JOIN workspaces w ON w.repository_id = r.id
      GROUP BY r.id
      ORDER BY r.display_order, r.created_at DESC
    `).all();

    res.json(repos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/repos', async (req, res) => {
  try {
    let { root_path } = req.body;

    if (!root_path) {
      return res.status(400).json({ error: 'root_path is required' });
    }

    // Normalize path to resolve symlinks and get canonical path
    try {
      root_path = fs.realpathSync(root_path);
    } catch (err) {
      return res.status(400).json({ error: 'Path does not exist or is inaccessible' });
    }

    // Verify read and execute permissions
    try {
      fs.accessSync(root_path, fs.constants.R_OK | fs.constants.X_OK);
    } catch (err) {
      return res.status(403).json({
        error: 'Path is not accessible (permission denied)',
        details: err.code
      });
    }

    const stats = fs.statSync(root_path);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    // Check if it's a git repository
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root_path, timeout: 2000 });
    } catch {
      return res.status(400).json({ error: 'Path is not a git repository' });
    }

    // Get repository name from directory
    const repoName = path.basename(root_path);

    // Get default branch using helper function
    const defaultBranch = detectDefaultBranch(root_path);

    // Use a transaction to prevent race conditions
    const insertRepo = db.transaction((root_path, repoId, repoName, defaultBranch) => {
      // Check if repository already exists
      const existing = db.prepare('SELECT * FROM repos WHERE root_path = ?').get(root_path);
      if (existing) {
        throw { status: 409, message: 'Repository already exists', repo: existing };
      }

      // Get highest display_order to add new repo at the end (inside transaction to prevent race)
      const maxOrder = db.prepare('SELECT MAX(display_order) as max FROM repos').get();
      const displayOrder = (maxOrder?.max || 0) + 1;

      // Insert repository
      db.prepare(`
        INSERT INTO repos (id, name, root_path, default_branch, display_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(repoId, repoName, root_path, defaultBranch, displayOrder);

      return db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId);
    });

    try {
      const repoId = randomUUID();

      const repo = insertRepo(root_path, repoId, repoName, defaultBranch);

      console.log(`✅ Repository added: ${repoName} (id: ${repoId})`);
      res.status(201).json(repo);
    } catch (err) {
      if (err.status === 409) {
        return res.status(409).json({ error: err.message, repo: err.repo });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error creating repository:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      workspaces: db.prepare('SELECT COUNT(*) as count FROM workspaces').get().count,
      workspaces_ready: db.prepare("SELECT COUNT(*) as count FROM workspaces WHERE state = 'ready'").get().count,
      workspaces_archived: db.prepare("SELECT COUNT(*) as count FROM workspaces WHERE state = 'archived'").get().count,
      repos: db.prepare('SELECT COUNT(*) as count FROM repos').get().count,
      sessions: db.prepare('SELECT COUNT(*) as count FROM sessions').get().count,
      sessions_idle: db.prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'idle'").get().count,
      sessions_working: db.prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'working'").get().count,
      messages: db.prepare('SELECT COUNT(*) as count FROM session_messages').get().count
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sidecar/status', (req, res) => {
  res.json(getSidecarStatus());
});

app.post('/api/sidecar/command', (req, res) => {
  const { command, data } = req.body;
  const sent = sendToSidecar({ command, data });

  if (sent) {
    res.json({ success: true, message: 'Command sent to sidecar' });
  } else {
    res.status(500).json({ error: 'Failed to send command' });
  }
});

//============================================================================
// START SERVER
//============================================================================

const server = app.listen(PORT, () => {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    console.error('❌ Failed to get server address');
    process.exit(1);
  }
  const actualPort = addr.port;
  actualServerPort = actualPort; // Store port globally for health endpoint

  // Output port in machine-readable format for Rust to capture
  console.log(`[BACKEND_PORT]${actualPort}`);

  console.log('\n🎉 Command Backend Server (Modular)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 API Server: http://localhost:${actualPort}`);
  console.log(`📊 Database: ${DB_PATH}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Start sidecar with backend port
  process.env.BACKEND_PORT = actualPort.toString();
  startSidecar(DB_PATH);

  console.log('✅ Server ready!\n');
});

server.on('error', (err) => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  stopSidecar();
  stopAllClaudeSessions();
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
  stopSidecar();
  stopAllClaudeSessions();
  closeDatabase();
  process.exit(0);
});
