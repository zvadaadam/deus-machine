#!/usr/bin/env node

/**
 * OpenDevs Backend Server
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
const { startClaudeSession, sendToClaudeSession, stopAllClaudeSessions } = require('./lib/claude-session.cjs');
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
// HEALTH & DISCOVERY ENDPOINTS
//============================================================================

// Comprehensive health check endpoint
// Returns server port for discovery + database/sidecar status
app.get('/api/health', (req, res) => {
  const sidecarStatus = getSidecarStatus();
  res.json({
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
        s.unread_count as session_unread
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
        s.unread_count as session_unread
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
             s.status as session_status, s.is_compacting, s.context_token_count
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
    const parentBranch = workspace.parent_branch || workspace.default_branch || 'main';

    // Get git diff stats comparing against parent branch
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
    const parentBranch = workspace.parent_branch || workspace.default_branch || 'main';

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
      return res.status(400).json({ error: 'file parameter is required' });
    }

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
    const parentBranch = workspace.parent_branch || workspace.default_branch || 'main';

    try {
      const output = execFileSync(
        'git',
        ['diff', `${parentBranch}...HEAD`, '--', file],
        {
          cwd: workspacePath,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
          timeout: 5000
        }
      ).toString();

      res.json({
        file,
        diff: output
      });
    } catch (gitError) {
      res.status(500).json({ error: 'Failed to get diff', details: gitError.message });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    const placeholderBranchName = `zvadaadam/${workspace_name}`;

    const tmpDir = os.tmpdir();
    const initLogPath = path.join(tmpDir, `conductor-${Date.now()}-init.log`);

    db.prepare(`
      INSERT INTO workspaces (
        id, repository_id, directory_name, branch, placeholder_branch_name,
        parent_branch, state, initialization_log_path, setup_log_path,
        initialization_files_copied, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      workspaceId, repository_id, workspace_name, placeholderBranchName,
      placeholderBranchName, parent_branch, 'initializing',
      initLogPath, setupLogPath, 0
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
  try {
    const { content } = req.body;
    const sessionId = req.params.id;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required and must be a string' });
    }

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const messageId = randomUUID();
    const sentAt = new Date().toISOString();

    // Get the most recent assistant message's sdk_message_id for linking
    const lastAssistantMessage = db.prepare(`
      SELECT sdk_message_id FROM session_messages
      WHERE session_id = ? AND role = 'assistant' AND sdk_message_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId);

    db.prepare(`
      INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model, last_assistant_message_id)
      VALUES (?, ?, 'user', ?, datetime('now'), ?, 'sonnet', ?)
    `).run(messageId, sessionId, content, sentAt, lastAssistantMessage?.sdk_message_id || null);

    db.prepare('UPDATE sessions SET status = \'working\', updated_at = datetime(\'now\') WHERE id = ?')
      .run(sessionId);

    // Get workspace info to start Claude CLI
    const workspace = db.prepare(`
      SELECT w.*, r.root_path FROM workspaces w
      LEFT JOIN repos r ON w.repository_id = r.id
      WHERE w.active_session_id = ?
    `).get(sessionId);

    if (!workspace || !workspace.root_path || !workspace.directory_name) {
      return res.status(400).json({ error: 'Workspace not found for session' });
    }

    const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);

    // Start or get existing Claude CLI session
    startClaudeSession(sessionId, workspacePath);

    // Send the user message to Claude CLI
    const sent = sendToClaudeSession(sessionId, content);

    if (!sent) {
      console.warn('⚠️  Failed to send message to Claude CLI, but message saved to database');
    }

    const createdMessage = db.prepare('SELECT * FROM session_messages WHERE id = ?').get(messageId);
    res.json(createdMessage);
  } catch (error) {
    console.error('Error sending message:', error);
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
  const actualPort = server.address().port;
  actualServerPort = actualPort; // Store port globally for health endpoint

  // Output port in machine-readable format for Rust to capture
  console.log(`[BACKEND_PORT]${actualPort}`);

  console.log('\n🎉 OpenDevs Backend Server (Modular)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 API Server: http://localhost:${actualPort}`);
  console.log(`📊 Database: ${DB_PATH}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Start sidecar with backend port
  process.env.BACKEND_PORT = actualPort.toString();
  startSidecar(DB_PATH);

  console.log('✅ Server ready!\n');
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
