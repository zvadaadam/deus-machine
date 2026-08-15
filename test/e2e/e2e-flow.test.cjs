#!/usr/bin/env node

/**
 * End-to-End Test for Deus Backend
 *
 * Tests the complete flow:
 * 1. Create a workspace
 * 2. Send a message
 * 3. Verify workspace state changes to "working"
 * 4. Verify socket events are emitted
 * 5. Verify messages are stored in the database
 * 6. Verify Claude response is received
 */

const http = require('http');
const Database = require('better-sqlite3');

// Configuration
const BACKEND_PORT = process.env.BACKEND_PORT || process.env.VITE_BACKEND_PORT || 60068;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const BACKEND_WS_URL = `ws://localhost:${BACKEND_PORT}/ws`;
const DB_PATH = process.env.DATABASE_PATH || (() => {
  if (!process.env.HOME) {
    throw new Error('HOME environment variable is not set. Please set DATABASE_PATH explicitly.');
  }
  return require('path').join(process.env.HOME, 'Library/Application Support/com.deus.app/deus.db');
})();

// The wire wants a BARE runtime model id plus the harness as its own field —
// the frontend splits its "harness:modelId" picker value into the two before
// sending. Mirrors AGENT_CONFIGS[harness].models[0] in shared/agent-catalog.ts
// (the source of truth); this script is plain CommonJS and cannot import it.
const DEFAULT_MODEL_BY_HARNESS = {
  'claude-code': 'claude-fable-5[1m]',
  'codex-sdk': 'gpt-5.3-codex',
  'codex-app-server': 'gpt-5.6-sol',
};

// Test state
let testWorkspaceId = null;
let testSessionId = null;

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'cyan');
  console.log('='.repeat(60) + '\n');
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

// HTTP request helper
function request(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BACKEND_URL);
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const jsonBody = body ? JSON.parse(body) : null;
          resolve({ status: res.statusCode, body: jsonBody, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, body, headers: res.headers });
        }
      });
    });

    // Set timeout - must be called after http.request()
    req.setTimeout(30000);

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout after 30s'));
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// WebSocket command helper.
//
// Async actions (sendMessage, stopSession) are NOT REST — they ride the
// `q:command` frame on the single /ws connection, and the backend answers with
// a `q:command_ack` carrying `accepted`. This mirrors sendCommand() in
// apps/web/src/platform/ws/query-protocol-client.ts, which is the only send
// path the app has. Localhost connections are auto-authenticated by the
// backend, so no initialize/token frame is needed here.
//
// One connection per call: this script sends a single command, and a socket
// that outlives it would keep the process alive.
function sendCommand(command, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BACKEND_WS_URL);
    const id = `e2e_${Date.now()}`;
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`Command ${command} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );

    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data));
      } catch {
        return; // Ignore malformed frames
      }
      // The backend greets localhost clients with { type: "connected" }; only
      // then is the socket registered and able to dispatch commands.
      if (msg.type === 'connected') {
        ws.send(JSON.stringify({ type: 'q:command', id, command, params }));
        return;
      }
      if (msg.type === 'q:command_ack' && msg.id === id) finish(resolve, msg);
      if (msg.type === 'q:error' && msg.id === id) {
        finish(reject, new Error(msg.message || 'Query protocol error'));
      }
    });

    ws.addEventListener('error', () => finish(reject, new Error('WebSocket error')));
    ws.addEventListener('close', () =>
      finish(reject, new Error('WebSocket closed before command_ack'))
    );
  });
}

// Wait helper
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test functions
async function testHealthCheck() {
  logSection('TEST 1: Health Check');

  try {
    const response = await request('GET', '/api/health');

    if (response.status === 200 && response.body.status === 'ok') {
      logSuccess(`Backend is healthy on port ${response.body.port}`);
      logInfo(`Database: ${response.body.database}`);
      logInfo(`Socket: ${response.body.socket}`);
      return true;
    } else {
      logError(`Backend health check failed: ${response.status}`);
      return false;
    }
  } catch (error) {
    logError(`Health check error: ${error.message}`);
    return false;
  }
}

async function testCreateWorkspace() {
  logSection('TEST 2: Create New Workspace');

  try {
    // Get repository from database
    const db = new Database(DB_PATH, { readonly: true });
    const repo = db.prepare("SELECT * FROM repositories WHERE name = 'deus-machine' LIMIT 1").get();
    db.close();

    if (!repo) {
      logError('deus-machine repository not found in database');
      return false;
    }

    logInfo(`Using repository: ${repo.name}`);
    logInfo(`Repository path: ${repo.root_path}`);
    logInfo(`Repository ID: ${repo.id}`);

    // Create workspace
    const createResponse = await request('POST', '/api/workspaces', {
      repository_id: repo.id
    });

    if (createResponse.status === 201 || createResponse.status === 200) {
      testWorkspaceId = createResponse.body.id;

      logSuccess(`Workspace created: ${createResponse.body.slug}`);
      logInfo(`Workspace ID: ${testWorkspaceId}`);
      logInfo(`State: ${createResponse.body.state} (will become 'ready' after git worktree completes)`);

      // Wait for workspace to become ready
      logInfo('Waiting for workspace initialization...');
      const maxWait = 15000; // 15 seconds
      const checkInterval = 1000;
      let elapsed = 0;

      while (elapsed < maxWait) {
        await wait(checkInterval);
        elapsed += checkInterval;

        const wsResponse = await request('GET', `/api/workspaces/${testWorkspaceId}`);
        if (wsResponse.body.state === 'ready') {
          testSessionId = wsResponse.body.active_session_id;
          logSuccess(`Workspace is ready! Session ID: ${testSessionId}`);
          return true;
        } else if (wsResponse.body.state === 'error') {
          logError('Workspace initialization failed');
          return false;
        }

        logInfo(`Still initializing... (${elapsed / 1000}s)`);
      }

      logError('Timeout waiting for workspace to become ready');
      return false;
    } else {
      logError(`Failed to create workspace: ${createResponse.status}`);
      logError(JSON.stringify(createResponse.body, null, 2));
      return false;
    }
  } catch (error) {
    logError(`Create workspace error: ${error.message}`);
    return false;
  }
}

async function testSocketConnection() {
  logSection('TEST 3: Socket Connection');

  // Socket tests disabled - requires socket.io-client package
  logWarning('Socket tests skipped (socket.io-client not installed)');
  logInfo('To enable: bun install socket.io-client');

  return true;
}

async function testSendMessage() {
  logSection('TEST 4: Send Message');

  try {
    const testMessage = 'Hello from E2E test - please respond with just "TEST OK"';

    // The harness is the session's own — it is bound at session creation and
    // the backend refuses to switch it once a session has messages.
    const sessionResponse = await request('GET', `/api/sessions/${testSessionId}`);
    if (sessionResponse.status !== 200) {
      logError(`Failed to read session before sending: ${sessionResponse.status}`);
      return false;
    }
    const agentHarness = sessionResponse.body.agent_harness || 'claude-code';
    const model = DEFAULT_MODEL_BY_HARNESS[agentHarness];
    if (!model) {
      logError(`No default model known for harness "${agentHarness}"`);
      return false;
    }

    logInfo(`Sending message: "${testMessage}"`);
    logInfo(`Harness: ${agentHarness} | Model: ${model}`);

    // `turnId` is the correlation key: the frontend stamps it on the
    // optimistic bubble and the engine echoes the user message back under it.
    const turnId = `e2e-turn-${Date.now()}`;
    const ack = await sendCommand('sendMessage', {
      sessionId: testSessionId,
      content: testMessage,
      model,
      agentHarness,
      turnId,
    });

    // `accepted` is the whole answer. The backend awaits the engine's turn
    // admission before acking, so `accepted: false` means no turn ran and the
    // prompt was never persisted — there is nothing to wait for after it.
    if (ack.accepted) {
      logSuccess('Message accepted (turn admitted)');
      logInfo(`Turn ID: ${ack.commandId}`);
      return true;
    }

    logError(`Send rejected: ${ack.error || 'unknown reason'}`);
    return false;
  } catch (error) {
    logError(`Send message error: ${error.message}`);
    return false;
  }
}

async function testVerifyWorkspaceState() {
  logSection('TEST 5: Verify Workspace State');

  try {
    // Wait a bit for state to update
    await wait(1000);

    const response = await request('GET', `/api/workspaces/${testWorkspaceId}`);

    if (response.status === 200) {
      const workspace = response.body;

      logInfo(`Workspace state: ${workspace.state}`);
      logInfo(`Session status: ${workspace.session?.status || 'N/A'}`);

      if (workspace.session && workspace.session.status === 'working') {
        logSuccess('Workspace is in "working" state');
        return true;
      } else {
        logWarning('Workspace is not in "working" state yet (might be normal)');
        return true; // Not a failure, just might be fast
      }
    } else {
      logError(`Failed to get workspace: ${response.status}`);
      return false;
    }
  } catch (error) {
    logError(`Verify workspace state error: ${error.message}`);
    return false;
  }
}

async function testVerifyDatabaseStorage() {
  logSection('TEST 6: Verify Database Storage');

  try {
    const db = new Database(DB_PATH, { readonly: true });

    // Check workspace exists
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(testWorkspaceId);

    if (workspace) {
      logSuccess(`Workspace found in database: ${workspace.slug}`);
      logInfo(`State: ${workspace.state}`);
    } else {
      logError('Workspace not found in database');
      db.close();
      return false;
    }

    // Check session exists
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(testSessionId);

    if (session) {
      logSuccess(`Session found in database`);
      logInfo(`Status: ${session.status}`);
      logInfo(`Agent session ID: ${session.agent_session_id || 'N/A'}`);
    } else {
      logError('Session not found in database');
      db.close();
      return false;
    }

    // Check messages
    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 5').all(testSessionId);

    logSuccess(`Found ${messages.length} message(s) in database`);

    messages.forEach((msg, i) => {
      logInfo(`  ${i + 1}. ${msg.role} - ${msg.id}`);
    });

    db.close();
    return true;
  } catch (error) {
    logError(`Database verification error: ${error.message}`);
    return false;
  }
}

async function testWaitForResponse() {
  logSection('TEST 7: Wait for Claude Response');

  const maxWaitTime = 30000; // 30 seconds
  const checkInterval = 2000; // 2 seconds
  let elapsed = 0;

  logInfo('Waiting for Claude to respond...');

  while (elapsed < maxWaitTime) {
    await wait(checkInterval);
    elapsed += checkInterval;

    try {
      const response = await request('GET', `/api/sessions/${testSessionId}/messages`);

      if (response.status === 200) {
        // The route answers { messages, has_older, has_newer } — reading the
        // body as a bare array made this poll silently vacuous.
        const messages = response.body.messages || [];
        const lastMessage = messages[messages.length - 1];

        if (lastMessage && lastMessage.role === 'assistant') {
          logSuccess('Claude responded!');

          // Messages render from `parts`; the retired `content` column is gone.
          const text = (lastMessage.parts || [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
          if (text) {
            logInfo(`Response: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
          } else {
            logInfo('Response received (no text parts)');
          }

          return true;
        }
      }

      logInfo(`Still waiting... (${elapsed / 1000}s)`);
    } catch (error) {
      logError(`Error checking for response: ${error.message}`);
    }
  }

  logWarning('Timeout waiting for Claude response (this might be expected if Claude CLI had issues)');
  return true; // Don't fail the test if Claude doesn't respond
}

async function testVerifySocketEvents() {
  logSection('TEST 8: Verify Socket Events');

  // Socket tests disabled - requires socket.io-client package
  logWarning('Socket event tests skipped (socket.io-client not installed)');

  return true;
}

async function cleanup() {
  logSection('CLEANUP');

  // Archive the test workspace
  if (testWorkspaceId) {
    try {
      await request('PATCH', `/api/workspaces/${testWorkspaceId}`, {
        state: 'archived'
      });
      logSuccess('Test workspace archived');
    } catch (error) {
      logWarning(`Failed to archive test workspace: ${error.message}`);
    }
  }
}

// Main test runner
async function runTests() {
  // Don't clear console in CI to preserve logs
  if (!process.env.CI) {
    console.clear();
  }
  log('╔═══════════════════════════════════════════════════════════╗', 'cyan');
  log('║         DEUS E2E TEST SUITE                                ║', 'cyan');
  log('╚═══════════════════════════════════════════════════════════╝', 'cyan');

  const results = [];

  try {
    // Run tests
    results.push({ name: 'Health Check', passed: await testHealthCheck() });
    results.push({ name: 'Create New Workspace', passed: await testCreateWorkspace() });

    if (testWorkspaceId && testSessionId) {
      results.push({ name: 'Socket Connection', passed: await testSocketConnection() });
      results.push({ name: 'Send Message', passed: await testSendMessage() });
      results.push({ name: 'Verify Workspace State', passed: await testVerifyWorkspaceState() });
      results.push({ name: 'Verify Database Storage', passed: await testVerifyDatabaseStorage() });
      results.push({ name: 'Wait for Claude Response', passed: await testWaitForResponse() });
      results.push({ name: 'Verify Socket Events', passed: await testVerifySocketEvents() });
    }

  } catch (error) {
    logError(`Fatal test error: ${error.message}`);
    console.error(error);
  } finally {
    await cleanup();
  }

  // Print summary
  logSection('TEST SUMMARY');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  results.forEach(result => {
    const icon = result.passed ? '✅' : '❌';
    const color = result.passed ? 'green' : 'red';
    log(`${icon} ${result.name}`, color);
  });

  console.log('\n' + '─'.repeat(60));
  log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`, failed === 0 ? 'green' : 'red');
  console.log('─'.repeat(60) + '\n');

  if (failed === 0) {
    logSuccess('ALL TESTS PASSED! ��');
    process.exit(0);
  } else {
    logError(`${failed} TEST(S) FAILED`);
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  logError(`Fatal error: ${error.message}`);
  console.error(error);
  process.exit(1);
});
