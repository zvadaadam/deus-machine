# Conductor Architecture

## Overview

Conductor is a desktop IDE for managing multiple parallel AI coding agents. It consists of 4 main layers:

```
┌─────────────────────────────────────────────────────────────┐
│                     USER INTERFACE                           │
│              (React/Vite Frontend - Port 1420)              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ HTTP REST API
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                  RUST/TAURI LAYER (Desktop Only)            │
│  • Manages backend lifecycle                                 │
│  • Port detection & management                               │
│  • Native OS integrations                                    │
│  • PTY for terminals                                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ Child Process
                           ↓
┌─────────────────────────────────────────────────────────────┐
│              NODE.JS BACKEND (Express Server)               │
│  Port: Dynamic (50XXX-60XXX range)                          │
│  • SQLite database management                                │
│  • Session/Workspace lifecycle                               │
│  • Claude CLI process management                             │
│  • Message routing & persistence                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ Child Process (spawn)
                           │ stdin/stdout (stream-json)
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                    CLAUDE CLI PROCESSES                      │
│  • One process per session                                   │
│  • Persistent across messages                                │
│  • Tool execution                                            │
│  • Permission management                                     │
└─────────────────────────────────────────────────────────────┘
```

## Message Send Flow

### 1. User Initiates Message

```typescript
// Frontend: src/features/session/ui/SessionPanel.tsx
User types "hello" → Click Send Button
  ↓
SessionService.sendMessage(sessionId, "hello")
  ↓
// src/features/session/api/session.service.ts
apiClient.post(ENDPOINTS.SESSION_MESSAGES(id), { content })
```

### 2. Frontend → Backend

```typescript
// src/shared/api/client.ts
POST http://localhost:{dynamic-port}/api/sessions/{id}/messages
Body: { "content": "hello" }
Content-Type: application/json
```

**Port Discovery Priority:**
1. `VITE_BACKEND_PORT` env variable (web dev mode)
2. Tauri `invoke('get_backend_port')` (desktop mode)
3. Port scanning (fallback for web mode)
4. Port 3333 (hard fallback)

### 3. Backend Processes Request

```javascript
// backend/server.cjs:783
app.post('/api/sessions/:id/messages', async (req, res) => {
  // 1. Validate session exists
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);

  // 2. Save user message to database
  db.prepare(`INSERT INTO session_messages ...`).run(messageId, sessionId, content, ...);

  // 3. Update session status to 'working'
  db.prepare('UPDATE sessions SET status = \'working\' ...').run(sessionId);

  // 4. Get workspace path
  const workspace = db.prepare(`SELECT w.*, r.root_path FROM workspaces ...`).get(sessionId);
  const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);

  // 5. Start or reuse Claude CLI session
  startClaudeSession(sessionId, workspacePath);

  // 6. Send message to Claude CLI via stdin
  sendToClaudeSession(sessionId, content);

  // 7. Return saved message immediately (response comes later via streaming)
  res.json(createdMessage);
});
```

### 4. Backend → Claude CLI

```javascript
// backend/lib/claude-session.cjs:401
function sendToClaudeSession(sessionId, content) {
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }]
    }
  };

  // Write to Claude CLI stdin as JSON line
  sessionInfo.process.stdin.write(JSON.stringify(message) + '\n');
}
```

### 5. Claude CLI Processes & Responds

```bash
Claude CLI receives message via stdin
  ↓
Processes message (tools, prompts, etc.)
  ↓
Streams response to stdout as JSON lines
  ↓
Backend captures stdout and parses JSON
```

### 6. Backend Saves Assistant Response

```javascript
// backend/lib/claude-session.cjs:171
claudeProcess.stdout.on('data', (data) => {
  // Parse stream-json lines
  const message = JSON.parse(line);

  if (message.type === 'assistant') {
    // Save assistant message to database
    db.prepare(`INSERT INTO session_messages (id, session_id, role, content, ...)
      VALUES (?, ?, 'assistant', ?, ...)`)
      .run(messageId, sessionId, prepared.content, sentAt, sdkMessageId);
  }

  if (message.type === 'result' && message.subtype === 'success') {
    // Mark session as idle when done
    db.prepare('UPDATE sessions SET status = \'idle\' ...').run(sessionId);
  }
});
```

### 7. Frontend Polls for Updates

```typescript
// Frontend uses TanStack Query for polling
// src/features/session/api/session.queries.ts
useQuery({
  queryKey: ['session', 'messages', sessionId],
  queryFn: () => SessionService.fetchMessages(sessionId),
  refetchInterval: 2000, // Poll every 2 seconds
})
```

Frontend polls:
```
GET /api/sessions/{id}/messages every 2 seconds
  ↓
Backend returns all messages from database
  ↓
Frontend diffs and displays new messages
```

## Error Handling

### Global Error Handlers (Added)

```javascript
// backend/server.cjs:123-150
process.on('uncaughtException', (error, origin) => {
  // Log error and continue running
});

process.on('unhandledRejection', (reason, promise) => {
  // Log promise rejection and continue running
});
```

### Claude CLI Error Handlers (Added)

```javascript
// backend/lib/claude-session.cjs:381-433
claudeProcess.stdout.on('error', ...);
claudeProcess.stderr.on('error', ...);
claudeProcess.stdin.on('error', ...);
claudeProcess.on('error', ...);
claudeProcess.on('exit', (code, signal) => {
  // Clean up session and update database
});
```

## Database Schema

```sql
-- Workspaces
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  repository_id TEXT,
  directory_name TEXT,
  branch TEXT,
  parent_branch TEXT,
  state TEXT, -- 'ready', 'initializing', 'archived'
  active_session_id TEXT,
  ...
);

-- Sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  status TEXT, -- 'idle', 'working'
  claude_session_id TEXT, -- Claude CLI session ID for resume
  ...
);

-- Messages
CREATE TABLE session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  role TEXT, -- 'user', 'assistant'
  content TEXT, -- JSON stringified message
  sdk_message_id TEXT, -- Claude's message ID
  ...
);
```

## Development Modes

### Web Dev Mode (`npm run dev:full`)
- Runs `./dev.sh` which:
  1. Starts backend with PORT=0 (dynamic allocation)
  2. Captures backend port from stdout
  3. Starts Vite with VITE_BACKEND_PORT env variable
- Frontend connects directly to backend via environment variable

### Desktop Mode (`npm run tauri:dev`)
- Runs everything in Tauri app
- Rust layer manages backend lifecycle
- Frontend uses `invoke('get_backend_port')` to get port

## Key Files

### Frontend
- `src/shared/config/api.config.ts` - Port discovery & API config
- `src/shared/api/client.ts` - HTTP client
- `src/features/session/api/session.service.ts` - Session API methods
- `src/features/session/api/session.queries.ts` - TanStack Query hooks

### Backend
- `backend/server.cjs` - Main Express server
- `backend/lib/claude-session.cjs` - Claude CLI process management
- `backend/lib/database.cjs` - SQLite database
- `backend/lib/message-sanitizer.cjs` - Message content handling

### Rust/Tauri
- `src-tauri/src/backend.rs` - Backend process manager
- `src-tauri/src/commands.rs` - Tauri commands (RPC)
- `src-tauri/src/lib.rs` - Main Tauri app

### Scripts
- `dev.sh` - Development server launcher
- `backend/server.cjs` - Backend entry point

## Common Issues & Solutions

### Issue: Claude doesn't respond to message

**Possible causes:**
1. **Backend crashed** → Check error handlers are in place
2. **Claude CLI not spawning** → Check binary path and permissions
3. **Frontend not polling** → Check refetchInterval in queries
4. **Session not found** → Verify workspace has active_session_id
5. **Wrong backend port** → Check port discovery in browser console

**Debug steps:**
```bash
# 1. Check backend is running
curl http://localhost:{port}/api/health

# 2. Check backend logs
tail -f /tmp/backend.log

# 3. Check session exists
curl http://localhost:{port}/api/sessions/{sessionId}

# 4. Check messages
curl http://localhost:{port}/api/sessions/{sessionId}/messages

# 5. Send test message
curl -X POST http://localhost:{port}/api/sessions/{sessionId}/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "test"}'
```

### Issue: Backend silently crashes

**Solution:** Added comprehensive error handling:
- Global uncaughtException handler
- Global unhandledRejection handler
- Child process error handlers
- Detailed logging at each step

See: `BACKEND_CRASH_BUG_SOLUTION.md`
