# Current Architecture Deep Dive

## Component Map

```
┌────────────────────────────────────────────────────────────┐
│                    FRONTEND (React)                        │
│                                                            │
│  - socketService.ts (connects via Tauri)                  │
│  - useSocket() hook                                        │
│  - useQuery() polling every 2s                            │
└──────────────────────┬─────────────────────────────────────┘
                       │ Tauri invoke()
                       ↓
┌────────────────────────────────────────────────────────────┐
│                   RUST (Tauri Backend)                     │
│                                                            │
│  - SocketManager (src-tauri/src/socket.rs)                │
│  - commands.rs (Tauri commands)                           │
│  - BackendManager (starts Node backend)                   │
└──────────────────────┬─────────────────────────────────────┘
                       │ Unix Socket
                       ↓
┌────────────────────────────────────────────────────────────┐
│            SIDECAR (src-tauri/sidecar/index.cjs)          │
│                                                            │
│  - Unix Socket Server                                      │
│  - broadcast() method ← KEY!                              │
│  - Routes commands to backend HTTP API                     │
└──────────────────────┬─────────────────────────────────────┘
                       │ HTTP requests
                       ↓
┌────────────────────────────────────────────────────────────┐
│              BACKEND (backend/server.cjs)                  │
│                                                            │
│  - HTTP REST API                                           │
│  - Claude session management                               │
│  - SQLite database                                         │
│  - Sidecar connection (backend/lib/sidecar/)              │
└──────────────────────┬─────────────────────────────────────┘
                       │ spawn/stdio
                       ↓
┌────────────────────────────────────────────────────────────┐
│                   CLAUDE CLI                               │
│                                                            │
│  - Managed by claude-session.cjs                          │
│  - Streams responses via stdout                           │
│  - handleClaudeMessage() saves to SQLite                  │
└────────────────────────────────────────────────────────────┘
```

## Current Message Flow (Polling)

**User sends message:**
```
Frontend → HTTP POST /api/sessions/:id/messages
         → Backend saves to SQLite
         → Starts Claude CLI
         → Returns 200 OK
Frontend → Polls GET /api/sessions/:id/messages every 2s
```

**Claude responds:**
```
Claude → stdout stream-json
      → handleClaudeMessage()
      → db.prepare('INSERT INTO session_messages ...')
      → ⚠️ NO EVENT SENT

Frontend → Polls every 2s to discover new message
```

## What Already Exists ✅

1. **Sidecar Unix Socket Server** ✅
   - Location: `src-tauri/sidecar/index.cjs`
   - Has `broadcast()` method for pushing to all clients
   - Already started by backend

2. **Backend → Sidecar Connection** ✅
   - Location: `backend/lib/sidecar/socket-manager.cjs`
   - Backend CAN send messages to sidecar
   - Uses `send(message)` method

3. **Rust → Sidecar Connection** ✅
   - Location: `src-tauri/src/socket.rs`
   - Rust connects via Unix socket
   - Can send/receive messages

4. **Tauri Event System** ✅
   - Location: `src-tauri/src/pty.rs` (proven pattern)
   - Rust can emit events: `handle.emit("event-name", payload)`
   - Frontend can listen: `listen('event-name', callback)`

## What's Missing ❌

1. **Backend doesn't notify sidecar when messages arrive**
   - handleClaudeMessage() only saves to DB
   - Need to add: Send event to sidecar

2. **Sidecar doesn't broadcast events**
   - Has broadcast() method but not used for events
   - Need to add: Broadcast when backend sends event

3. **Rust doesn't listen for broadcast events**
   - Currently only does request/response
   - Need to add: Background thread listening for events

4. **Rust doesn't emit Tauri events**
   - Has capability (proven with PTY)
   - Need to add: Forward sidecar events as Tauri events

5. **Frontend doesn't listen for Tauri events**
   - Has capability (proven with Terminal)
   - Need to add: useSessionEvents() hook

## Implementation Plan

### Phase 1: Backend → Sidecar Event Push

**File: `backend/lib/claude-session.cjs`**

```javascript
// Line 200 (after saving message)
db.prepare(`INSERT INTO session_messages ...`).run(...);

// ✅ NEW: Notify sidecar
const { getSidecarManager } = require('./sidecar/index.cjs');
const sidecar = getSidecarManager();
sidecar.send({
  type: 'frontend_event',
  event: 'session:message',
  payload: {
    session_id: sessionId,
    message_id: messageId,
    role: 'assistant'
  }
});
```

### Phase 2: Sidecar Broadcast Events

**File: `src-tauri/sidecar/index.cjs`**

```javascript
// Line 102 (in handleMessage)
async handleMessage(socket, line) {
  const message = JSON.parse(line);

  // NEW: Handle frontend_event type
  if (message.type === 'frontend_event') {
    console.log('[SOCKET] 📢 Broadcasting event:', message.event);
    this.broadcast(message);
    return;
  }

  // Existing: Route to backend
  const response = await this.routeMessage(message);
  this.send(socket, response);
}
```

### Phase 3: Rust Event Listener

**File: `src-tauri/src/socket.rs`**

```rust
// NEW: Start background event listener
pub fn start_event_listener(&self, app_handle: AppHandle) {
    let stream = Arc::clone(&self.stream);

    std::thread::spawn(move || {
        loop {
            if let Some(socket) = stream.lock().unwrap().as_ref() {
                let reader = BufReader::new(socket);

                for line in reader.lines() {
                    if let Ok(line) = line {
                        if let Ok(event) = serde_json::from_str::<Value>(&line) {
                            if event["type"] == "frontend_event" {
                                let event_name = event["event"].as_str().unwrap_or("unknown");
                                let payload = &event["payload"];

                                // Emit to frontend
                                app_handle.emit(event_name, payload).ok();
                            }
                        }
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(100));
        }
    });
}
```

### Phase 4: Frontend Event Hook

**File: `src/features/session/hooks/useSessionEvents.ts`**

```typescript
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';

export function useSessionEvents(sessionId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!sessionId || !('__TAURI__' in window)) return;

    const unlisten = listen('session:message', (event) => {
      if (event.payload.session_id === sessionId) {
        queryClient.invalidateQueries(['sessions', 'messages', sessionId]);
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [sessionId]);
}
```

### Phase 5: Disable Polling

**File: `src/features/session/api/session.queries.ts`**

```typescript
export function useMessages(sessionId: string | null) {
  // Listen for events
  useSessionEvents(sessionId);

  return useQuery({
    // ...
    refetchInterval: false, // ✅ NO POLLING!
  });
}
```

## Estimated Effort

| Phase | Files | Lines | Time |
|-------|-------|-------|------|
| 1. Backend notify | 1 | ~10 | 30min |
| 2. Sidecar broadcast | 1 | ~8 | 20min |
| 3. Rust listener | 1 | ~40 | 1h |
| 4. Frontend hook | 1 | ~25 | 30min |
| 5. Disable polling | 2 | ~5 | 15min |
| **Total** | **6** | **~88** | **2.5h** |

## Testing Checklist

- [ ] Backend sends event when Claude responds
- [ ] Sidecar broadcasts event to all clients
- [ ] Rust receives event
- [ ] Rust emits Tauri event
- [ ] Frontend listens and invalidates query
- [ ] Message appears instantly (<100ms)
- [ ] No polling requests in Network tab
- [ ] Works with multiple sessions
- [ ] Graceful degradation if sidecar disconnected

## Benefits

- **Latency:** 2s → <100ms (20× faster)
- **API calls:** 1,700/min → <10/min (99% reduction)
- **Network:** Minimal (only initial fetch)
- **Battery:** Much better (no constant polling)
- **Architecture:** Clean, event-driven, extensible
