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
const { spawn } = require('child_process');
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
const PORT = 3333;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database
const db = initDatabase();

console.log('✅ All modules loaded successfully');

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
    const { execSync } = require('child_process');
    try {
      const output = execSync(`git diff ${parentBranch}...HEAD --shortstat`, {
        cwd: workspacePath,
        encoding: 'utf-8'
      }).trim();

      // Parse output like: "3 files changed, 45 insertions(+), 12 deletions(-)"
      const additions = output.match(/(\d+) insertion/)?.[1] || '0';
      const deletions = output.match(/(\d+) deletion/)?.[1] || '0';

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

    const { execSync } = require('child_process');
    try {
      const output = execSync(`git diff ${parentBranch}...HEAD --numstat`, {
        cwd: workspacePath,
        encoding: 'utf-8'
      }).trim();

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

    const { execSync } = require('child_process');
    try {
      const output = execSync(`git diff ${parentBranch}...HEAD -- "${file}"`, {
        cwd: workspacePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large diffs
      });

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

    const { execSync } = require('child_process');
    try {
      // Check if branch has a PR using gh CLI
      const output = execSync(`gh pr view --json number,title,url,mergeable`, {
        cwd: workspacePath,
        encoding: 'utf-8'
      }).trim();

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

    const tmpDir = '/var/folders/_r/7d8d1f2x17b1vp589_bxs8k00000gn/T';
    const initLogPath = path.join(tmpDir, `conductor-${Date.now()}-init.log`);
    const setupLogPath = path.join(tmpDir, `conductor-${Date.now()}-setup.log`);

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

app.get('/api/health', (req, res) => {
  const sidecarStatus = getSidecarStatus();
  res.json({
    status: 'ok',
    database: db ? 'connected' : 'disconnected',
    sidecar: sidecarStatus.running ? 'running' : 'stopped',
    socket: sidecarStatus.connected ? 'connected' : 'disconnected'
  });
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

app.listen(PORT, () => {
  console.log('\n🎉 Conductor Backend Server (Modular)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 API Server: http://localhost:${PORT}`);
  console.log(`📊 Database: ${DB_PATH}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Start sidecar
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
