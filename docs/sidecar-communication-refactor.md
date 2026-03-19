# Sidecar Communication Refactor

## The Problem

The frontend currently uses **three overlapping transport layers** to communicate with the backend/sidecar:

### 1. WebSocket Query Protocol (`q:command`)

Used by: PTY, file watcher, browser server

```
Frontend → WS sendCommand("pty:spawn") → Backend query-engine → node-pty
```

Clean, consistent, works well.

### 2. HTTP Sidecar Relay (`socketService.ts`)

Used by: sending messages, stopping sessions

```
Frontend → socketService.sendQuery() → HTTP POST /api/sidecar/send → Backend → Unix Socket → Sidecar
Frontend → socketService.cancelQuery() → HTTP POST /api/sidecar/send → Backend → Unix Socket → Sidecar
```

Frontend is aware of the sidecar's existence and speaks to it through the backend as a dumb pipe.

### 3. Mixed WS + HTTP for Sidecar RPC

Used by: agent plan approval, question answering, getDiff

```
Sidecar → Unix Socket → Backend → WS q:event "sidecar:request" → Frontend  (WS inbound)
Frontend → HTTP POST /api/sidecar/respond → Backend → Unix Socket → Sidecar  (HTTP outbound)
```

Requests arrive via WebSocket, responses go back via HTTP. Asymmetric.

### Why This Is a Problem

1. **The frontend knows about the sidecar.** The `socketService.ts` file constructs JSON-RPC messages with sidecar-specific shapes (`{ type: "query", id, agentType, prompt, options }`). The frontend should not need to know the sidecar exists.

2. **Dual message-sending paths.** Desktop mode uses `socketService.sendQuery()` (HTTP relay), web mode uses `SessionService.sendMessage()` (HTTP REST). The query engine already has a `sendMessage` command handler that writes to DB, but nobody uses it because it doesn't relay to the sidecar.

3. **Dual session-stopping paths.** `socketService.cancelQuery()` (HTTP relay) + `SessionService.stop()` (HTTP REST). Same duplication.

4. **Three protocols for one connection.** WS for subscriptions/commands, HTTP for sidecar relay, HTTP for REST fallback. The WebSocket is already there and handles PTY/fs/browser commands — there's no reason messages and sidecar RPC shouldn't flow through it too.

5. **The sidecar relay endpoints are unnecessary.** `/api/sidecar/send`, `/api/sidecar/respond`, `/api/sidecar/status` exist only because the frontend was originally built with Tauri (which had direct Unix socket access) and the HTTP relay was a quick bridge. Now that we have a proper WebSocket query protocol, these endpoints are redundant.

---

## The Solution: Everything Through WebSocket

**Principle: The frontend talks ONLY to the backend via WebSocket. The backend owns the sidecar relationship.**

### Message Sending

**Before:**

```
Frontend → socketService.sendQuery() → HTTP → Backend → Unix Socket → Sidecar
                                                                        ↓
                                                         Sidecar writes message + starts agent
```

**After:**

```
Frontend → sendCommand("sendMessage", { sessionId, content, model, agentType })
             ↓
         Backend query-engine:
           1. Write message to DB (writeUserMessage)
           2. Set session status = 'working'
           3. Relay "process session" to sidecar via Unix socket
           4. Return q:command_ack { accepted: true }
             ↓
         Sidecar reads message from DB, starts agent
```

The backend's existing `sendMessage` handler (query-engine.ts:365-377) already does steps 1-2. Step 3 is the only addition — a single `sidecarService.sendMessage()` call after the DB write.

### Session Stopping

**Before:**

```
Frontend → socketService.cancelQuery() → HTTP → Backend → Sidecar
Frontend → SessionService.stop() → HTTP → Backend → DB update
```

**After:**

```
Frontend → sendCommand("stopSession", { sessionId, agentType })
             ↓
         Backend query-engine:
           1. Send "cancel" to sidecar via Unix socket
           2. Set session status = 'idle' in DB
           3. Return q:command_ack { accepted: true }
```

The backend's existing `stopSession` handler (query-engine.ts:378-389) already does step 2. Step 1 is the addition.

### Sidecar RPC Responses

**Before:**

```
Frontend receives sidecar:request via WS q:event     ← WS inbound
Frontend sends response via HTTP POST /api/sidecar/respond  ← HTTP outbound
```

**After:**

```
Frontend receives sidecar:request via WS q:event     ← WS inbound (same)
Frontend → sendCommand("sidecar:respond", { id, result })  ← WS outbound
             ↓
         Backend query-engine:
           1. Relay response to sidecar via Unix socket
           2. Return q:command_ack { accepted: true }
```

Symmetric: both directions use WebSocket.

---

## What Gets Deleted

| File / Endpoint                                                | Reason                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/web/src/platform/socket/socketService.ts`                | Entire file. All functionality moves to WS commands.                            |
| `apps/backend/src/routes/sidecar.ts`                           | All 3 endpoints (`/api/sidecar/send`, `/respond`, `/status`). No longer needed. |
| `socketService` imports in `session.queries.ts`                | Replace with `sendCommand()` calls.                                             |
| `socketService` imports in `useSessionActions.ts`              | Replace with `sendCommand()` calls.                                             |
| HTTP POST to `/api/sidecar/respond` in `useAgentRpcHandler.ts` | Replace with `sendCommand("sidecar:respond", ...)`.                             |

## What Gets Added

| Location                                        | Change                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `query-engine.ts` `sendMessage` handler         | After DB write, relay `{ type: "query", ... }` to sidecar via `sidecarService.sendMessage()` |
| `query-engine.ts` `stopSession` handler         | Before/after DB write, send cancel to sidecar via `sidecarService.sendMessage()`             |
| `query-engine.ts` new `sidecar:respond` command | Relay response to sidecar via `sidecarService.sendResponseToSidecar()`                       |
| `session.queries.ts` `useSendMessage`           | Replace `socketService.sendQuery()` with `sendCommand("sendMessage", ...)`                   |
| `useSessionActions.ts` `stopSession`            | Replace `socketService.cancelQuery()` with `sendCommand("stopSession", ...)`                 |
| `useAgentRpcHandler.ts` `sendResponse`          | Replace HTTP POST with `sendCommand("sidecar:respond", ...)`                                 |

## What Gets Modified (Frontend)

The `useSendMessage` mutation simplifies dramatically:

```ts
// Before: two code paths, socketService import, sidecar-aware JSON-RPC construction
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

1. **Backend first**: Add sidecar relay logic to existing `sendMessage`/`stopSession` command handlers + add `sidecar:respond` command.
2. **Frontend second**: Switch `session.queries.ts` and `useSessionActions.ts` to use `sendCommand()`. Switch `useAgentRpcHandler.ts` response path.
3. **Cleanup**: Delete `socketService.ts`, sidecar routes, remove dead code.
4. **Test**: Verify message sending, session stopping, and agent RPC (plan approval, questions) all work through WS.

---

## Benefits

- **Single transport**: All frontend↔backend communication over one WebSocket connection
- **Frontend doesn't know about sidecar**: The sidecar is an internal backend implementation detail
- **Symmetric RPC**: Sidecar requests and responses both flow through WS
- **No more dual code paths**: Desktop and web mode use the same `sendCommand()` calls
- **Simpler error handling**: WS command ACK replaces HTTP response parsing
- **Fewer endpoints to maintain**: 3 HTTP routes deleted, 1 WS command added
