# Agent-server Communication Refactor

## The Problem

The frontend currently uses **three overlapping transport layers** to communicate with the backend/agent-server:

### 1. WebSocket Query Protocol (`q:command`)

Used by: PTY, file watcher, browser server

```
Frontend → WS sendCommand("pty:spawn") → Backend query-engine → node-pty
```

Clean, consistent, works well.

### 2. HTTP Agent-server Relay (`socketService.ts`)

Used by: sending messages, stopping sessions

```
Frontend → socketService.sendQuery() → HTTP POST /api/agent-server/send → Backend → Unix Socket → Agent-server
Frontend → socketService.cancelQuery() → HTTP POST /api/agent-server/send → Backend → Unix Socket → Agent-server
```

Frontend is aware of the agent-server's existence and speaks to it through the backend as a dumb pipe.

### 3. Mixed WS + HTTP for Agent-server RPC

Used by: agent plan approval, question answering, getDiff

```
Agent-server → Unix Socket → Backend → WS q:event "agent-server:request" → Frontend  (WS inbound)
Frontend → HTTP POST /api/agent-server/respond → Backend → Unix Socket → Agent-server  (HTTP outbound)
```

Requests arrive via WebSocket, responses go back via HTTP. Asymmetric.

### Why This Is a Problem

1. **The frontend knows about the agent-server.** The `socketService.ts` file constructs JSON-RPC messages with agent-server-specific shapes (`{ type: "query", id, agentType, prompt, options }`). The frontend should not need to know the agent-server exists.

2. **Dual message-sending paths.** Desktop mode uses `socketService.sendQuery()` (HTTP relay), web mode uses `SessionService.sendMessage()` (HTTP REST). The query engine already has a `sendMessage` command handler that writes to DB, but nobody uses it because it doesn't relay to the agent-server.

3. **Dual session-stopping paths.** `socketService.cancelQuery()` (HTTP relay) + `SessionService.stop()` (HTTP REST). Same duplication.

4. **Three protocols for one connection.** WS for subscriptions/commands, HTTP for agent-server relay, HTTP for REST fallback. The WebSocket is already there and handles PTY/fs/browser commands — there's no reason messages and agent-server RPC shouldn't flow through it too.

5. **The agent-server relay endpoints are unnecessary.** `/api/agent-server/send`, `/api/agent-server/respond`, `/api/agent-server/status` exist only because the frontend was originally built with Tauri (which had direct Unix socket access) and the HTTP relay was a quick bridge. Now that we have a proper WebSocket query protocol, these endpoints are redundant.

---

## The Solution: Everything Through WebSocket

**Principle: The frontend talks ONLY to the backend via WebSocket. The backend owns the agent-server relationship.**

### Message Sending

**Before:**

```
Frontend → socketService.sendQuery() → HTTP → Backend → Unix Socket → Agent-server
                                                                        ↓
                                                         Agent-server writes message + starts agent
```

**After:**

```
Frontend → sendCommand("sendMessage", { sessionId, content, model, agentType })
             ↓
         Backend query-engine:
           1. Write message to DB (writeUserMessage)
           2. Set session status = 'working'
           3. Relay "process session" to agent-server via Unix socket
           4. Return q:command_ack { accepted: true }
             ↓
         Agent-server reads message from DB, starts agent
```

The backend's existing `sendMessage` handler (query-engine.ts:365-377) already does steps 1-2. Step 3 is the only addition — a single `agent-serverService.sendMessage()` call after the DB write.

### Session Stopping

**Before:**

```
Frontend → socketService.cancelQuery() → HTTP → Backend → Agent-server
Frontend → SessionService.stop() → HTTP → Backend → DB update
```

**After:**

```
Frontend → sendCommand("stopSession", { sessionId, agentType })
             ↓
         Backend query-engine:
           1. Send "cancel" to agent-server via Unix socket
           2. Set session status = 'idle' in DB
           3. Return q:command_ack { accepted: true }
```

The backend's existing `stopSession` handler (query-engine.ts:378-389) already does step 2. Step 1 is the addition.

### Agent-server RPC Responses

**Before:**

```
Frontend receives agent-server:request via WS q:event     ← WS inbound
Frontend sends response via HTTP POST /api/agent-server/respond  ← HTTP outbound
```

**After:**

```
Frontend receives agent-server:request via WS q:event     ← WS inbound (same)
Frontend → sendCommand("agent-server:respond", { id, result })  ← WS outbound
             ↓
         Backend query-engine:
           1. Relay response to agent-server via Unix socket
           2. Return q:command_ack { accepted: true }
```

Symmetric: both directions use WebSocket.

---

## What Gets Deleted

| File / Endpoint                                                     | Reason                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/web/src/platform/socket/socketService.ts`                     | Entire file. All functionality moves to WS commands.                                 |
| `apps/backend/src/routes/agent-server.ts`                           | All 3 endpoints (`/api/agent-server/send`, `/respond`, `/status`). No longer needed. |
| `socketService` imports in `session.queries.ts`                     | Replace with `sendCommand()` calls.                                                  |
| `socketService` imports in `useSessionActions.ts`                   | Replace with `sendCommand()` calls.                                                  |
| HTTP POST to `/api/agent-server/respond` in `useAgentRpcHandler.ts` | Replace with `sendCommand("agent-server:respond", ...)`.                             |

## What Gets Added

| Location                                             | Change                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `query-engine.ts` `sendMessage` handler              | After DB write, relay `{ type: "query", ... }` to agent-server via `agent-serverService.sendMessage()` |
| `query-engine.ts` `stopSession` handler              | Before/after DB write, send cancel to agent-server via `agent-serverService.sendMessage()`             |
| `query-engine.ts` new `agent-server:respond` command | Relay response to agent-server via `agent-serverService.sendResponseToAgent-server()`                  |
| `session.queries.ts` `useSendMessage`                | Replace `socketService.sendQuery()` with `sendCommand("sendMessage", ...)`                             |
| `useSessionActions.ts` `stopSession`                 | Replace `socketService.cancelQuery()` with `sendCommand("stopSession", ...)`                           |
| `useAgentRpcHandler.ts` `sendResponse`               | Replace HTTP POST with `sendCommand("agent-server:respond", ...)`                                      |

## What Gets Modified (Frontend)

The `useSendMessage` mutation simplifies dramatically:

```ts
// Before: two code paths, socketService import, agent-server-aware JSON-RPC construction
const mutationFn = async (vars) => {
  if (cwd) {
    return socketService.sendQuery(sessionId, content, { cwd, model }, agentType);
  } else {
    return SessionService.sendMessage(sessionId, content, model);
  }
};

// After: single path, backend handles everything
const mutationFn = async (vars) => {
  return sendCommand("sendMessage", {
    sessionId: vars.sessionId,
    content: vars.content,
    model: vars.model,
    agentType: vars.agentType,
    cwd: vars.cwd,
  });
};
```

---

## Migration Order

1. **Backend first**: Add agent-server relay logic to existing `sendMessage`/`stopSession` command handlers + add `agent-server:respond` command.
2. **Frontend second**: Switch `session.queries.ts` and `useSessionActions.ts` to use `sendCommand()`. Switch `useAgentRpcHandler.ts` response path.
3. **Cleanup**: Delete `socketService.ts`, agent-server routes, remove dead code.
4. **Test**: Verify message sending, session stopping, and agent RPC (plan approval, questions) all work through WS.

---

## Benefits

- **Single transport**: All frontend↔backend communication over one WebSocket connection
- **Frontend doesn't know about agent-server**: The agent-server is an internal backend implementation detail
- **Symmetric RPC**: Agent-server requests and responses both flow through WS
- **No more dual code paths**: Desktop and web mode use the same `sendCommand()` calls
- **Simpler error handling**: WS command ACK replaces HTTP response parsing
- **Fewer endpoints to maintain**: 3 HTTP routes deleted, 1 WS command added
