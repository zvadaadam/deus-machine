/**
 * Claude CLI Session Management Module
 *
 * Manages Claude CLI processes for each session, handling:
 * - Session lifecycle (start, stop, resume)
 * - Permission requests (can_use_tool control flow)
 * - Message streaming (stream-json protocol)
 * - File path validation for security
 *
 * Each session maintains a persistent Claude CLI process that handles
 * multiple messages through stdin/stdout pipes. Sessions are reused
 * across messages to maintain conversation context.
 *
 * @module claude-session
 */

const { spawn } = require('child_process');
const path = require('path');
const { randomUUID } = require('crypto');
const { getDatabase } = require('./database.cjs');
const { getMcpServers, getAgents } = require('./config.cjs');
const { prepareMessageContent } = require('./message-sanitizer.cjs');

/**
 * Path to the Claude CLI binary
 * @type {string}
 */
const CLAUDE_BINARY = '/Users/zvada/conductor/cc/claude';

/**
 * Map of active Claude CLI sessions
 * Maps sessionId -> { process, buffer, workspacePath }
 * @type {Map<string, Object>}
 */
const claudeSessions = new Map();

/**
 * Permission handling function
 *
 * Validates tool usage requests from Claude CLI, particularly for file
 * editing operations. Ensures files being edited are within the workspace
 * directory to prevent security issues.
 *
 * Matches the implementation from OpenDevs sidecar exactly.
 *
 * @param {string} sessionId - The session ID
 * @param {string} toolName - The tool being requested (Edit, Write, etc.)
 * @param {Object} input - The tool input parameters
 * @param {string} workspacePath - The workspace directory path
 * @returns {Promise<Object>} Permission result with behavior and optional message
 */
async function canUseTool(sessionId, toolName, input, workspacePath) {
  // Special handling for ExitPlanMode (not implemented yet, but reserved)
  if (toolName === 'ExitPlanMode') {
    console.log(`   ℹ️  ExitPlanMode requested (not yet implemented)`);
    return { behavior: 'allow', updatedInput: input };
  }

  // Edit tools that modify files
  const editTools = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

  if (editTools.includes(toolName)) {
    if (workspacePath) {
      // Get file path from input
      const filePath = input.file_path || input.notebook_path || '';

      if (filePath) {
        // Normalize paths for comparison
        const normalizedWorkingDir = path.resolve(workspacePath);
        const normalizedFilePath = path.resolve(filePath);

        // Check if file is within workspace
        if (!normalizedFilePath.startsWith(normalizedWorkingDir)) {
          console.log(
            `   🚫 BLOCKED: ${toolName} operation on ${filePath} - outside working directory ${workspacePath}`
          );
          return {
            behavior: 'deny',
            message: `Cannot edit files outside the working directory (${workspacePath}). Attempted to edit: ${filePath}`
          };
        }
      }
    }
  }

  // Allow all other tools
  return { behavior: 'allow', updatedInput: input };
}

/**
 * Handle messages from Claude CLI process
 *
 * Processes stream-json messages including:
 * - control_request: Permission requests (can_use_tool)
 * - assistant: Assistant messages with tool_use blocks
 * - user: User messages with tool_result blocks
 * - result: Session completion messages
 *
 * @param {string} sessionId - The session ID
 * @param {Object} message - The parsed stream-json message
 */
function handleClaudeMessage(sessionId, message) {
  const db = getDatabase();

  // Handle control requests (permission prompts)
  if (message.type === 'control_request') {
    const sessionInfo = claudeSessions.get(sessionId);

    if (sessionInfo && message.request) {
      // Handle can_use_tool permission requests
      if (message.request.subtype === 'can_use_tool') {
        const toolName = message.request.tool_name;
        const input = message.request.input || {};

        console.log(`   🔐 Permission request: ${toolName}`);
        console.log(`   📍 Workspace: ${sessionInfo.workspacePath}`);

        // Check permission using canUseTool
        canUseTool(sessionId, toolName, input, sessionInfo.workspacePath)
          .then(result => {
            const response = {
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: message.request_id,
                response: result
              }
            };

            try {
              sessionInfo.process.stdin.write(JSON.stringify(response) + '\n');

              if (result.behavior === 'deny') {
                console.log(`   ❌ Permission DENIED for ${toolName}: ${result.message}`);
              } else {
                console.log(`   ✅ Permission ALLOWED for ${toolName}`);
              }
            } catch (error) {
              console.error('Failed to send permission response:', error);
            }
          })
          .catch(error => {
            // Send error response
            const errorResponse = {
              type: 'control_response',
              response: {
                subtype: 'error',
                request_id: message.request_id,
                error: error.message || String(error)
              }
            };

            try {
              sessionInfo.process.stdin.write(JSON.stringify(errorResponse) + '\n');
              console.error(`   ⚠️  Permission check error for ${toolName}:`, error);
            } catch (writeError) {
              console.error('Failed to send error response:', writeError);
            }
          });
      }
      else {
        console.log(`   ℹ️  Unknown control request subtype: ${message.request?.subtype}`);
      }
    }

    return;
  }

  // Save EVERY assistant message immediately (don't wait for result)
  // This ensures we capture tool_use blocks which come in separate messages
  if (message.type === 'assistant' && message.message) {
    const messageId = randomUUID();
    const sentAt = new Date().toISOString();
    // Extract sdk_message_id from Claude's response (message.message.id)
    const sdkMessageId = message.message.id || null;

    try {
      // Use sanitizer to safely prepare content for storage
      const prepared = prepareMessageContent({ message: message.message });

      if (!prepared.success) {
        console.error(`❌ Failed to prepare message content: ${prepared.error}`);
        console.error(`   Message ID: ${messageId}, Session: ${sessionId.substring(0, 8)}`);
        // Store error placeholder instead of failing silently
        const errorContent = JSON.stringify({
          error: 'Failed to serialize message',
          details: prepared.error
        });
        db.prepare(`
          INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model, sdk_message_id)
          VALUES (?, ?, 'assistant', ?, datetime('now'), ?, 'sonnet', ?)
        `).run(messageId, sessionId, errorContent, sentAt, sdkMessageId);
        return;
      }

      db.prepare(`
        INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model, sdk_message_id)
        VALUES (?, ?, 'assistant', ?, datetime('now'), ?, 'sonnet', ?)
      `).run(messageId, sessionId, prepared.content, sentAt, sdkMessageId);

      console.log(`   ✅ Saved assistant message for session ${sessionId.substring(0, 8)} (sdk: ${sdkMessageId})`);
    } catch (error) {
      console.error('Failed to save assistant message:', error);
    }
  }

  // Save user messages with tool_result blocks (these are tool execution results)
  if (message.type === 'user' && message.message) {
    const messageId = randomUUID();
    const sentAt = new Date().toISOString();

    try {
      // Use sanitizer to safely prepare content for storage
      const prepared = prepareMessageContent({ message: message.message });

      if (!prepared.success) {
        console.error(`❌ Failed to prepare tool result content: ${prepared.error}`);
        console.error(`   Message ID: ${messageId}, Session: ${sessionId.substring(0, 8)}`);
        return;
      }

      db.prepare(`
        INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model)
        VALUES (?, ?, 'assistant', ?, datetime('now'), ?, 'sonnet')
      `).run(messageId, sessionId, prepared.content, sentAt);

      console.log(`   ✅ Saved user message (tool result) for session ${sessionId.substring(0, 8)}`);
    } catch (error) {
      console.error('Failed to save user message:', error);
    }
  }

  // Update claude_session_id if provided
  if (message.session_id || message.claude_session_id) {
    const claudeSessionId = message.session_id || message.claude_session_id;
    try {
      db.prepare(`
        UPDATE sessions
        SET claude_session_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(claudeSessionId, sessionId);
      console.log(`   ✅ Updated claude_session_id: ${claudeSessionId}`);
    } catch (error) {
      console.error('Failed to update claude_session_id:', error);
    }
  }

  // Update session status to idle when done
  if (message.type === 'result' && message.subtype === 'success') {
    try {
      db.prepare(`
        UPDATE sessions
        SET status = 'idle', updated_at = datetime('now')
        WHERE id = ?
      `).run(sessionId);
      console.log(`   ✅ Session ${sessionId.substring(0, 8)} set to idle`);
    } catch (error) {
      console.error('Failed to update session status:', error);
    }
  }
}

/**
 * Start a Claude CLI session
 *
 * Creates or reuses an existing Claude CLI process for the given session.
 * The process runs with stream-json I/O format and handles permission
 * prompts programmatically.
 *
 * @param {string} sessionId - The session ID from the database
 * @param {string} workspacePath - The absolute path to the workspace directory
 * @returns {Object} Session info with process, buffer, and workspacePath
 */
function startClaudeSession(sessionId, workspacePath) {
  // Reuse existing session if available
  if (claudeSessions.has(sessionId)) {
    console.log(`   Session ${sessionId} already running`);
    return claudeSessions.get(sessionId);
  }

  const db = getDatabase();

  console.log(`\n🤖 Starting Claude CLI session`);
  console.log(`   Session ID: ${sessionId}`);
  console.log(`   Working directory: ${workspacePath}`);

  // Check if claude_session_id exists (for resume)
  const session = db.prepare('SELECT claude_session_id FROM sessions WHERE id = ?').get(sessionId);
  const claudeSessionId = session?.claude_session_id;

  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--max-turns', '1000',
    '--model', 'sonnet',
    '--debug-to-stderr',
    // Use --permission-prompt-tool stdio to handle permissions programmatically
    '--permission-prompt-tool', 'stdio'
  ];

  // Load MCP servers from file-based config
  const mcpServers = getMcpServers();
  if (mcpServers && mcpServers.length > 0) {
    // Convert array to object keyed by name (as Claude CLI expects)
    const mcpServersObj = {};
    mcpServers.forEach(server => {
      mcpServersObj[server.name] = {
        command: server.command,
        args: server.args || [],
        env: server.env || {}
      };
    });
    args.push('--mcp-config', JSON.stringify({ mcpServers: mcpServersObj }));
    console.log(`   📦 Loaded ${mcpServers.length} MCP server(s)`);
  }

  // Load agents from file-based config
  const agents = getAgents();
  if (agents && agents.length > 0) {
    // Convert array to object keyed by id
    const agentsObj = {};
    agents.forEach(agent => {
      agentsObj[agent.id] = {
        name: agent.name,
        description: agent.description,
        tools: agent.tools || []
      };
    });
    args.push('--agents', JSON.stringify(agentsObj));
    console.log(`   🤖 Loaded ${agents.length} agent(s)`);
  }

  // Add permission-mode as a fallback (works alongside permission-prompt-tool)
  args.push('--permission-mode', 'acceptEdits');

  // If we have a claude_session_id, resume the session
  if (claudeSessionId) {
    args.push('--resume', claudeSessionId);
    console.log(`   Resuming Claude session: ${claudeSessionId}`);
  }

  const claudeProcess = spawn(CLAUDE_BINARY, args, {
    cwd: workspacePath,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const sessionInfo = {
    process: claudeProcess,
    buffer: '',
    workspacePath
  };

  claudeSessions.set(sessionId, sessionInfo);

  // Handle stdout (stream-json output)
  claudeProcess.stdout.on('data', (data) => {
    sessionInfo.buffer += data.toString();

    // Process complete JSON lines
    const lines = sessionInfo.buffer.split('\n');
    sessionInfo.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);
        console.log(`[CLAUDE ${sessionId.substring(0, 8)}]`, JSON.stringify(message).substring(0, 200));
        handleClaudeMessage(sessionId, message);
      } catch (error) {
        console.error('Failed to parse Claude output:', line.substring(0, 100), error);
      }
    }
  });

  // Handle stderr (debug output)
  claudeProcess.stderr.on('data', (data) => {
    console.log(`[CLAUDE STDERR ${sessionId.substring(0, 8)}]`, data.toString().trim().substring(0, 200));
  });

  claudeProcess.on('exit', (code) => {
    console.log(`   Claude process exited: ${code}`);
    claudeSessions.delete(sessionId);
  });

  console.log(`   ✅ Claude CLI process started (PID: ${claudeProcess.pid})`);
  return sessionInfo;
}

/**
 * Send a message to a Claude CLI session
 *
 * Sends a user message to an existing Claude CLI process using the
 * stream-json protocol.
 *
 * @param {string} sessionId - The session ID
 * @param {string} content - The message content (plain text)
 * @returns {boolean} True if sent successfully, false otherwise
 */
function sendToClaudeSession(sessionId, content) {
  const sessionInfo = claudeSessions.get(sessionId);
  if (!sessionInfo) {
    console.error(`No Claude session found for ${sessionId}`);
    return false;
  }

  // Send message as stream-json format (Claude expects a message object)
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }]
    }
  };

  try {
    sessionInfo.process.stdin.write(JSON.stringify(message) + '\n');
    console.log(`   ✅ Message sent to Claude CLI`);
    return true;
  } catch (error) {
    console.error('Failed to send message to Claude CLI:', error);
    return false;
  }
}

/**
 * Get all active sessions
 *
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveSessions() {
  return Array.from(claudeSessions.keys());
}

/**
 * Stop a Claude CLI session
 *
 * @param {string} sessionId - The session ID to stop
 * @returns {boolean} True if stopped, false if not found
 */
function stopClaudeSession(sessionId) {
  const sessionInfo = claudeSessions.get(sessionId);
  if (!sessionInfo) {
    return false;
  }

  try {
    sessionInfo.process.kill('SIGTERM');
    claudeSessions.delete(sessionId);
    console.log(`   ✅ Stopped Claude session ${sessionId}`);
    return true;
  } catch (error) {
    console.error(`Failed to stop Claude session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Stop all Claude CLI sessions
 *
 * Should be called during application shutdown
 */
function stopAllClaudeSessions() {
  console.log(`👋 Stopping ${claudeSessions.size} Claude session(s)`);
  for (const sessionId of claudeSessions.keys()) {
    stopClaudeSession(sessionId);
  }
}

module.exports = {
  startClaudeSession,
  sendToClaudeSession,
  stopClaudeSession,
  stopAllClaudeSessions,
  getActiveSessions,
  canUseTool
};
