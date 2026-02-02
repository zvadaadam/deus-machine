import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { getDatabase } from '../lib/database';
import { getMcpServers, getAgents } from './config.service';
import { prepareMessageContent } from '../lib/message-sanitizer';

const CLAUDE_BINARY = process.env.CLAUDE_CLI_PATH || '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js';

interface SessionInfo {
  process: ChildProcess;
  buffer: string;
  workspacePath: string;
}

const claudeSessions = new Map<string, SessionInfo>();

/**
 * Permission handler for Claude CLI tool usage requests.
 * Validates file editing operations are within workspace boundaries.
 */
export async function canUseTool(
  _sessionId: string,
  toolName: string,
  input: Record<string, any>,
  workspacePath: string
): Promise<{ behavior: string; updatedInput?: Record<string, any>; message?: string }> {
  if (toolName === 'ExitPlanMode') {
    return { behavior: 'allow', updatedInput: input };
  }

  const editTools = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

  if (editTools.includes(toolName)) {
    // Defense-in-depth: deny edits when workspace context is missing.
    // Callers (routes/sessions.ts) validate workspacePath before reaching here,
    // but this function shouldn't rely on that — missing context = deny.
    if (!workspacePath) {
      return {
        behavior: 'deny',
        message: 'Cannot allow file edits without a configured workspace path',
      };
    }

    const filePath = input.file_path || input.notebook_path || '';

    if (filePath) {
      const normalizedWorkingDir = path.resolve(workspacePath) + path.sep;
      const normalizedFilePath = path.resolve(filePath);

      if (!normalizedFilePath.startsWith(normalizedWorkingDir)) {
        return {
          behavior: 'deny',
          message: `Cannot edit files outside the working directory (${workspacePath}). Attempted to edit: ${filePath}`,
        };
      }
    }
  }

  return { behavior: 'allow', updatedInput: input };
}

function handleClaudeMessage(sessionId: string, message: any): void {
  const db = getDatabase();

  // Handle control requests (permission prompts)
  if (message.type === 'control_request') {
    const sessionInfo = claudeSessions.get(sessionId);

    if (sessionInfo && message.request) {
      if (message.request.subtype === 'can_use_tool') {
        const toolName = message.request.tool_name;
        const input = message.request.input || {};

        canUseTool(sessionId, toolName, input, sessionInfo.workspacePath)
          .then(result => {
            const response = {
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: message.request_id,
                response: result,
              },
            };

            try {
              sessionInfo.process.stdin!.write(JSON.stringify(response) + '\n');
            } catch (error) {
              console.error('Failed to send permission response:', error);
            }
          })
          .catch(error => {
            const errorResponse = {
              type: 'control_response',
              response: {
                subtype: 'error',
                request_id: message.request_id,
                error: error.message || String(error),
              },
            };

            try {
              sessionInfo.process.stdin!.write(JSON.stringify(errorResponse) + '\n');
            } catch (writeError) {
              console.error('Failed to send error response:', writeError);
            }
          });
      }
    }

    return;
  }

  // Save assistant messages immediately
  if (message.type === 'assistant' && message.message) {
    const messageId = randomUUID();
    const sentAt = new Date().toISOString();
    const sdkMessageId = message.message.id || null;

    try {
      const prepared = prepareMessageContent({ message: message.message });

      if (!prepared.success) {
        console.error(`Failed to prepare message content: ${prepared.error}`);
        const errorContent = JSON.stringify({
          error: 'Failed to serialize message',
          details: prepared.error,
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

      // Notify sidecar for real-time frontend update
      try {
        const { getSidecarManager } = require('../sidecar');
        const sidecar = getSidecarManager();
        sidecar.send({
          type: 'frontend_event',
          event: 'session:message',
          payload: {
            session_id: sessionId,
            message_id: messageId,
            role: 'assistant',
            sdk_message_id: sdkMessageId,
          },
        });
      } catch (error: any) {
        console.error('Failed to emit event (sidecar not connected):', error.message);
      }
    } catch (error) {
      console.error('Failed to save assistant message:', error);
    }
  }

  // Save user messages with tool_result blocks
  if (message.type === 'user' && message.message) {
    const messageId = randomUUID();
    const sentAt = new Date().toISOString();

    try {
      const prepared = prepareMessageContent({ message: message.message });

      if (!prepared.success) {
        console.error(`Failed to prepare tool result content: ${prepared.error}`);
        return;
      }

      db.prepare(`
        INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model)
        VALUES (?, ?, 'user', ?, datetime('now'), ?, 'sonnet')
      `).run(messageId, sessionId, prepared.content, sentAt);
    } catch (error) {
      console.error('Failed to save user message:', error);
    }
  }

  // Update claude_session_id if provided
  if (message.session_id || message.claude_session_id) {
    const claudeSessionId = message.session_id || message.claude_session_id;
    try {
      db.prepare(`
        UPDATE sessions SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?
      `).run(claudeSessionId, sessionId);
    } catch (error) {
      console.error('Failed to update claude_session_id:', error);
    }
  }

  // Update session status to idle when done
  if (message.type === 'result' && message.subtype === 'success') {
    try {
      db.prepare(`
        UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?
      `).run(sessionId);
    } catch (error) {
      console.error('Failed to update session status:', error);
    }
  }
}

export function startClaudeSession(sessionId: string, workspacePath: string): SessionInfo {
  // Reuse existing session if available
  if (claudeSessions.has(sessionId)) {
    return claudeSessions.get(sessionId)!;
  }

  const db = getDatabase();

  // Verify Claude binary exists
  if (!fs.existsSync(CLAUDE_BINARY)) {
    throw new Error(`Claude binary not found at ${CLAUDE_BINARY}`);
  }

  try {
    fs.accessSync(CLAUDE_BINARY, fs.constants.X_OK);
  } catch {
    throw new Error(`Claude binary is not executable: ${CLAUDE_BINARY}`);
  }

  // Check if claude_session_id exists (for resume)
  const session = db.prepare('SELECT claude_session_id FROM sessions WHERE id = ?').get(sessionId) as any;
  const claudeSessionId = session?.claude_session_id;

  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--max-turns', '1000',
    '--model', 'sonnet',
    '--debug-to-stderr',
    '--permission-prompt-tool', 'stdio',
  ];

  // Load MCP servers from file-based config
  const mcpServers = getMcpServers();
  if (mcpServers.length > 0) {
    const mcpServersObj: Record<string, any> = {};
    mcpServers.forEach(server => {
      mcpServersObj[server.name] = {
        command: server.command,
        args: server.args || [],
        env: server.env || {},
      };
    });
    args.push('--mcp-config', JSON.stringify({ mcpServers: mcpServersObj }));
  }

  // Load agents from file-based config
  const agents = getAgents();
  if (agents.length > 0) {
    const agentsObj: Record<string, any> = {};
    agents.forEach(agent => {
      agentsObj[agent.id] = {
        name: agent.name,
        description: agent.description,
        tools: agent.tools || [],
      };
    });
    args.push('--agents', JSON.stringify(agentsObj));
  }

  args.push('--permission-mode', 'acceptEdits');

  if (claudeSessionId) {
    args.push('--resume', claudeSessionId);
  }

  const claudeProcess = spawn(process.execPath, [CLAUDE_BINARY, ...args], {
    cwd: workspacePath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  const sessionInfo: SessionInfo = {
    process: claudeProcess,
    buffer: '',
    workspacePath,
  };

  claudeSessions.set(sessionId, sessionInfo);

  // Handle stdout (stream-json output)
  claudeProcess.stdout!.on('data', (data: Buffer) => {
    try {
      sessionInfo.buffer += data.toString();
      const lines = sessionInfo.buffer.split('\n');
      sessionInfo.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          handleClaudeMessage(sessionId, message);
        } catch (error) {
          console.error('Failed to parse Claude output:', line.substring(0, 100), error);
        }
      }
    } catch (error) {
      console.error(`[CLAUDE ${sessionId.substring(0, 8)}] Error processing stdout:`, error);
    }
  });

  claudeProcess.stdout!.on('error', (error: Error) => {
    console.error(`[CLAUDE ${sessionId.substring(0, 8)}] stdout error:`, error);
  });

  claudeProcess.stderr!.on('data', (data: Buffer) => {
    console.log(`[CLAUDE STDERR ${sessionId.substring(0, 8)}]`, data.toString().trim().substring(0, 200));
  });

  claudeProcess.stderr!.on('error', (error: Error) => {
    console.error(`[CLAUDE ${sessionId.substring(0, 8)}] stderr error:`, error);
  });

  claudeProcess.stdin!.on('error', (error: Error) => {
    console.error(`[CLAUDE ${sessionId.substring(0, 8)}] stdin error:`, error);
  });

  claudeProcess.on('error', (error: any) => {
    console.error(`[CLAUDE ${sessionId.substring(0, 8)}] Process error:`, error);
  });

  claudeProcess.on('exit', (code, signal) => {
    console.log(`[CLAUDE ${sessionId.substring(0, 8)}] Process exited:`, { code, signal });
    claudeSessions.delete(sessionId);

    const db = getDatabase();
    try {
      db.prepare(`
        UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?
      `).run(sessionId);
    } catch (error) {
      console.error('Failed to update session status after exit:', error);
    }
  });

  claudeProcess.on('close', (code, signal) => {
    console.log(`[CLAUDE ${sessionId.substring(0, 8)}] Process closed:`, { code, signal });
  });

  console.log(`Claude CLI process started (PID: ${claudeProcess.pid})`);
  return sessionInfo;
}

export function sendToClaudeSession(sessionId: string, content: string): boolean {
  const sessionInfo = claudeSessions.get(sessionId);
  if (!sessionInfo) {
    console.error(`No Claude session found for ${sessionId}`);
    return false;
  }

  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }],
    },
  };

  try {
    sessionInfo.process.stdin!.write(JSON.stringify(message) + '\n');
    return true;
  } catch (error) {
    console.error('Failed to send message to Claude CLI:', error);
    return false;
  }
}

export function getActiveSessions(): string[] {
  return Array.from(claudeSessions.keys());
}

export function stopClaudeSession(sessionId: string): boolean {
  const sessionInfo = claudeSessions.get(sessionId);
  if (!sessionInfo) return false;

  try {
    sessionInfo.process.kill('SIGTERM');
    claudeSessions.delete(sessionId);
    return true;
  } catch (error) {
    console.error(`Failed to stop Claude session ${sessionId}:`, error);
    return false;
  }
}

export function stopAllClaudeSessions(): void {
  console.log(`Stopping ${claudeSessions.size} Claude session(s)`);
  for (const sessionId of claudeSessions.keys()) {
    stopClaudeSession(sessionId);
  }
}
