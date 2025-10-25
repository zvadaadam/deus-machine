# The REAL Solution: Use Tauri Events (NOT HTTP Polling!)

**Author:** Deep Dive Analysis
**Date:** 2025-10-25
**Revelation:** You're absolutely right - we have Tauri IPC and should use it!

---

## 🎯 THE REVELATION

**You asked the RIGHT question:** Why poll when we have Unix socket + Tauri IPC?

**Answer:** We shouldn't! The infrastructure ALREADY EXISTS for real-time push.

---

## 📡 CURRENT ARCHITECTURE (The Wasteful Way)

```
┌─────────────────────────────────────────────────────────────┐
│                     CLAUDE CLI                              │
│                  (spawned by backend)                       │
└──────────────────────┬──────────────────────────────────────┘
                       │ stdout (stream-json)
                       ↓
┌─────────────────────────────────────────────────────────────┐
│              claude-session.cjs                             │
│          handleClaudeMessage(message)                       │
│                      ↓                                      │
│          db.prepare('INSERT INTO session_messages ...')     │
│                  .run(...)                                  │
│                                                             │
│          ⚠️ NO EVENT EMITTED TO FRONTEND                    │
└─────────────────────────────────────────────────────────────┘
                       │
                       ↓ Saved to SQLite
┌─────────────────────────────────────────────────────────────┐
│                  SQLite Database                            │
└──────────────────────┬──────────────────────────────────────┘
                       ↑
                       │ HTTP GET every 2 seconds (POLLING!)
                       │
┌─────────────────────────────────────────────────────────────┐
│              Frontend (React Query)                         │
│                                                             │
│   useMessages(sessionId) {                                  │
│     return useQuery({                                       │
│       queryFn: () => SessionService.fetchMessages(...),    │
│       refetchInterval: 2000  // ⚠️ POLL EVERY 2s           │
│     });                                                     │
│   }                                                         │
└─────────────────────────────────────────────────────────────┘
```

**Result:** 1,700+ API calls/minute, 90,000 git operations/hour 🔥

---

## ✨ WHAT ALREADY EXISTS (PTY Pattern)

**The app ALREADY has real-time push working for terminals!**

### Rust Side (src-tauri/src/pty.rs:82)

```rust
// When PTY data arrives
let _ = handle.emit("pty-data", serde_json::json!({
    "id": session_id,
    "data": data
}));
```

### Frontend Side (src/features/terminal/ui/Terminal.tsx:100)

```typescript
// Listen for PTY data
const unlistenData = listen<{ id: string; data: number[] }>('pty-data', (event) => {
  if (event.payload.id === id) {
    xterm.write(new Uint8Array(event.payload.data));
  }
});
```

**No polling. Instant updates. Perfect.**

---

## 🏗️ THE IDEAL ARCHITECTURE (Event-Driven)

```
┌─────────────────────────────────────────────────────────────┐
│                     CLAUDE CLI                              │
└──────────────────────┬──────────────────────────────────────┘
                       │ stdout (stream-json)
                       ↓
┌─────────────────────────────────────────────────────────────┐
│              claude-session.cjs                             │
│          handleClaudeMessage(message)                       │
│                      ↓                                      │
│          1. Save to SQLite                                  │
│          2. Emit event to Tauri ✅ NEW                      │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ↓ Event notification
┌─────────────────────────────────────────────────────────────┐
│              Tauri Backend (Rust)                           │
│                                                             │
│   app_handle.emit("session-message", json!({               │
│     "session_id": session_id,                              │
│     "message": { ...message_data }                         │
│   }));                                                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ Tauri IPC event
                       ↓
┌─────────────────────────────────────────────────────────────┐
│              Frontend (React)                               │
│                                                             │
│   listen('session-message', (event) => {                   │
│     queryClient.setQueryData(                              │
│       ['sessions', 'messages', sessionId],                 │
│       (old) => [...old, event.payload.message]             │
│     );                                                      │
│   });                                                       │
│                                                             │
│   ✅ NO POLLING!                                           │
└─────────────────────────────────────────────────────────────┘
```

**Result:** <10 API calls/minute, instant message delivery (<100ms)

---

## 💡 IMPLEMENTATION OPTIONS

### Option A: Backend HTTP → Tauri Polls (Hybrid) ⭐ QUICK WIN

**Keep Node.js backend, add lightweight Rust polling**

#### Backend Changes (~10 lines)

```javascript
// backend/lib/claude-session.cjs:197-200

// After saving message to DB
db.prepare(`INSERT INTO session_messages ...`).run(...);

// ✅ NEW: Set a flag that Rust can poll
db.prepare(`
  INSERT OR REPLACE INTO pending_events (type, session_id, created_at)
  VALUES ('message', ?, datetime('now'))
`).run(sessionId);
```

#### Rust Changes (~50 lines)

```rust
// src-tauri/src/lib.rs - Add EventPoller

use tauri::{AppHandle, Emitter};
use std::time::Duration;
use std::thread;
use rusqlite::Connection;

pub struct EventPoller {
    db_path: String,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl EventPoller {
    pub fn start(&self) {
        let db_path = self.db_path.clone();
        let app_handle = self.app_handle.clone();

        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_millis(200)); // Poll every 200ms

                // Check for pending events
                if let Ok(conn) = Connection::open(&db_path) {
                    let mut stmt = conn.prepare("
                        SELECT session_id, type FROM pending_events
                        ORDER BY created_at ASC
                    ").unwrap();

                    let events: Vec<(String, String)> = stmt
                        .query_map([], |row| {
                            Ok((row.get(0)?, row.get(1)?))
                        })
                        .unwrap()
                        .filter_map(|r| r.ok())
                        .collect();

                    for (session_id, event_type) in events {
                        if event_type == "message" {
                            // Fetch the new message
                            // Emit Tauri event
                            if let Some(handle) = app_handle.lock().unwrap().as_ref() {
                                let _ = handle.emit("session-message", json!({
                                    "session_id": session_id
                                }));
                            }

                            // Delete processed event
                            conn.execute("DELETE FROM pending_events WHERE session_id = ?", [&session_id]).ok();
                        }
                    }
                }
            }
        });
    }
}
```

**Pros:**
- Minimal backend changes
- No new infrastructure
- Works in both web and desktop mode
- 200ms polling (server-side only, not network)

**Cons:**
- Still polling (but way more efficient than 2s HTTP polls)
- Requires SQLite table

---

### Option B: Use Existing Sidecar Socket ⭐⭐ BEST

**Leverage the sidecar that's ALREADY running!**

Looking at your architecture:
- Sidecar process ALREADY handles Claude messages
- Unix socket ALREADY connects Rust ↔ Sidecar
- We just need sidecar to emit events, Rust to listen

#### Sidecar Changes (~20 lines)

```javascript
// backend/lib/sidecar/message-handler.cjs:76-82

_handleResult(message) {
  const messageId = randomUUID();

  // Save to DB (existing code)
  this.db.prepare(`INSERT INTO session_messages ...`).run(...);

  // ✅ NEW: Emit event via socket
  const event = {
    type: 'frontend_event',
    event_name: 'session-message',
    payload: {
      session_id: message.session_id,
      message_id: messageId,
      role: 'assistant'
    }
  };

  // Send via socket (sidecar already has socket connection)
  // This will be received by Rust SocketManager
  process.stdout.write(JSON.stringify(event) + '\n');
}
```

#### Rust Changes (~30 lines)

```rust
// src-tauri/src/socket.rs - Add event forwarding

impl SocketManager {
    pub fn start_event_listener(&self, app_handle: AppHandle) {
        let stream = self.stream.clone();

        thread::spawn(move || {
            loop {
                if let Some(s) = stream.lock().unwrap().as_ref() {
                    let mut reader = BufReader::new(s);
                    let mut line = String::new();

                    if reader.read_line(&mut line).is_ok() {
                        if let Ok(event) = serde_json::from_str::<Value>(&line) {
                            if event["type"] == "frontend_event" {
                                // Forward to frontend via Tauri events
                                let event_name = event["event_name"].as_str().unwrap();
                                let payload = &event["payload"];

                                app_handle.emit(event_name, payload).ok();
                            }
                        }
                    }
                }

                thread::sleep(Duration::from_millis(10));
            }
        });
    }
}
```

#### Frontend Changes (~40 lines)

```typescript
// src/features/session/hooks/useSessionEvents.ts (NEW FILE)

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/api/queryKeys';
import { isTauriEnv } from '@/platform/tauri';

export function useSessionEvents(sessionId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauriEnv || !sessionId) return;

    // Listen for new messages
    const unlisten = listen<{ session_id: string; message_id: string }>(
      'session-message',
      (event) => {
        if (event.payload.session_id === sessionId) {
          // Invalidate messages query to refetch
          queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.messages(sessionId),
          });
        }
      }
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionId, queryClient]);
}
```

```typescript
// src/features/session/ui/SessionPanel.tsx

export const SessionPanel = forwardRef<SessionPanelRef, SessionPanelProps>(
  ({ sessionId, ... }, ref) => {

    // ✅ Add event listener hook
    useSessionEvents(sessionId);

    // ✅ DISABLE POLLING
    const messagesQuery = useQuery({
      queryKey: queryKeys.sessions.messages(sessionId || ''),
      queryFn: () => SessionService.fetchMessages(sessionId!),
      enabled: !!sessionId,
      refetchInterval: false, // ✅ NO POLLING - events do the work
      staleTime: Infinity,    // ✅ Never stale - trust events
    });

    // ... rest
  }
);
```

**Pros:**
- Uses existing infrastructure (sidecar, socket)
- True real-time (<100ms latency)
- No polling at all (not even server-side)
- Clean architecture
- Works for both HTTP backend users and Tauri users

**Cons:**
- Requires sidecar to be running (already is)
- Only works in Tauri mode (web mode falls back to smart polling)

---

### Option C: Tauri Event Bridge (Clean Architecture) ⭐⭐⭐ IDEAL

**Pure event-driven, no sockets needed**

Use Tauri's **app state** to share a message queue between backend thread and event emitter.

#### New Rust Component

```rust
// src-tauri/src/event_bridge.rs (NEW FILE)

use std::sync::{Arc, Mutex};
use std::collections::VecDeque;
use tauri::{AppHandle, Emitter};
use serde_json::Value;

#[derive(Clone)]
pub struct EventBridge {
    queue: Arc<Mutex<VecDeque<(String, Value)>>>, // (event_name, payload)
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl EventBridge {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock().unwrap() = Some(handle);
        self.start_emitter();
    }

    /// Push event to queue (called from backend thread)
    pub fn push_event(&self, event_name: String, payload: Value) {
        self.queue.lock().unwrap().push_back((event_name, payload));
    }

    /// Start background thread to emit events
    fn start_emitter(&self) {
        let queue = self.queue.clone();
        let app_handle = self.app_handle.clone();

        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(50));

                let event = queue.lock().unwrap().pop_front();
                if let Some((event_name, payload)) = event {
                    if let Some(handle) = app_handle.lock().unwrap().as_ref() {
                        handle.emit(&event_name, payload).ok();
                    }
                }
            }
        });
    }
}

/// Tauri command to push events from backend HTTP endpoint
#[tauri::command]
pub fn emit_backend_event(
    event_bridge: tauri::State<EventBridge>,
    event_name: String,
    payload: Value,
) -> Result<(), String> {
    event_bridge.push_event(event_name, payload);
    Ok(())
}
```

#### Backend Endpoint

```javascript
// backend/server.cjs - Add event emission endpoint

app.post('/api/events/emit', (req, res) => {
  const { event_name, payload } = req.body;

  // In Tauri mode, call Tauri command via HTTP
  // This is a bit hacky but works
  // Alternative: Use IPC if backend knows Tauri port

  res.json({ success: true });
});
```

Actually, this is getting complex. **Option B is cleaner.**

---

## 🎯 RECOMMENDED APPROACH

### Phase 1: Option B (Sidecar Events) - 2-4 hours

**Why:**
- Uses existing infrastructure
- True real-time (<100ms)
- No polling anywhere
- Clean architecture

**Implementation:**

1. **Sidecar emits events** (backend/lib/sidecar/message-handler.cjs) - 20 lines
2. **Rust forwards events** (src-tauri/src/socket.rs) - 30 lines
3. **Frontend listens** (new hook + disable polling) - 40 lines
4. **Fallback for web mode** (keep smart polling) - Already exists

**Testing:**
- Desktop mode: Events should fire instantly
- Web mode: Falls back to smart polling (Option 1 from previous doc)

---

### Phase 2: Smart Polling Fallback - 1-2 hours

For users in web mode (non-Tauri), keep the smart polling strategy from POLLING_DEEP_DIVE.md:

```typescript
// Detect Tauri mode
const isTauri = isTauriEnv;

export function useMessages(sessionId: string | null) {
  // Use events in Tauri mode
  useSessionEvents(sessionId);

  return useQuery({
    queryKey: queryKeys.sessions.messages(sessionId || ''),
    queryFn: () => SessionService.fetchMessages(sessionId!),
    enabled: !!sessionId,
    // Only poll in web mode, and only when working
    refetchInterval: !isTauri && session?.status === 'working' ? 2000 : false,
  });
}
```

---

## 📊 COMPARISON

| Approach | Latency | API Calls/Min | Complexity | Effort |
|----------|---------|---------------|------------|--------|
| **Current (HTTP Polling)** | 0-2s | 1,700+ | Low | - |
| **Option A (SQLite Poll)** | ~200ms | 300/min* | Medium | 2-3h |
| **Option B (Sidecar Events)** | <100ms | <10 | Medium | 2-4h |
| **Smart Polling Only** | 0-2s | 50-100 | Low | 2-4h |
| **Hybrid (B + Smart)** | <100ms | <10 (Tauri), 50 (Web) | Medium | 4-6h |

*Server-side polling, not network calls

---

## 🔧 DETAILED IMPLEMENTATION (Option B)

### Step 1: Update Message Handler (20 min)

```javascript
// backend/lib/sidecar/message-handler.cjs

class MessageHandler {
  constructor(db, socketManager) {
    this.db = db;
    this.socketManager = socketManager; // ✅ NEW: Pass socket manager
  }

  _handleResult(message) {
    const messageId = randomUUID();

    // Existing: Save to database
    this.db.prepare(`...`).run(...);

    // ✅ NEW: Emit event via socket
    if (this.socketManager) {
      this.socketManager.emitToFrontend('session-message', {
        session_id: message.session_id,
        message_id: messageId,
        role: 'assistant'
      });
    }
  }
}
```

### Step 2: Update Socket Manager (30 min)

```javascript
// backend/lib/sidecar/socket-manager.cjs

class SocketManager {
  // ... existing code ...

  /**
   * Emit event to frontend (via Rust → Tauri → React)
   */
  emitToFrontend(eventName, payload) {
    const message = {
      type: 'frontend_event',
      event_name: eventName,
      payload: payload
    };

    // Send via Unix socket (Rust listens on other end)
    if (this.socket) {
      this.socket.write(JSON.stringify(message) + '\n');
    }
  }
}
```

### Step 3: Update Rust Socket Manager (40 min)

```rust
// src-tauri/src/socket.rs

impl SocketManager {
    // ... existing code ...

    /// Start listening for frontend events from sidecar
    pub fn start_event_forwarding(&self, app_handle: AppHandle) {
        let stream = Arc::clone(&self.stream);

        std::thread::spawn(move || {
            loop {
                let socket_opt = stream.lock().unwrap().clone();

                if let Some(socket) = socket_opt {
                    let reader = BufReader::new(&socket);

                    for line in reader.lines() {
                        if let Ok(line) = line {
                            // Parse event
                            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                                if event.get("type").and_then(|v| v.as_str()) == Some("frontend_event") {
                                    let event_name = event.get("event_name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown");

                                    let payload = event.get("payload").cloned()
                                        .unwrap_or(Value::Null);

                                    // Emit to frontend
                                    let _ = app_handle.emit(event_name, payload);
                                }
                            }
                        }
                    }
                }

                std::thread::sleep(Duration::from_millis(100));
            }
        });
    }
}
```

### Step 4: Update Tauri Main (10 min)

```rust
// src-tauri/src/main.rs

fn main() {
    tauri::Builder::default()
        // ... existing setup ...
        .setup(|app| {
            // ... existing code ...

            // ✅ NEW: Start event forwarding
            let socket_manager: tauri::State<SocketManager> = app.state();
            socket_manager.start_event_forwarding(app.handle().clone());

            Ok(())
        })
        // ...
}
```

### Step 5: Frontend Hook (30 min)

```typescript
// src/features/session/hooks/useSessionEvents.ts

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/api/queryKeys';

interface SessionMessageEvent {
  session_id: string;
  message_id: string;
  role: string;
}

export function useSessionEvents(sessionId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!sessionId) return;

    // Only in Tauri mode
    const isTauri = '__TAURI__' in window;
    if (!isTauri) return;

    let unlistenFn: (() => void) | null = null;

    // Listen for session messages
    listen<SessionMessageEvent>('session-message', (event) => {
      const { session_id, message_id } = event.payload;

      if (session_id === sessionId) {
        console.log('[Events] New message received:', message_id);

        // Invalidate query to trigger refetch
        queryClient.invalidateQueries({
          queryKey: queryKeys.sessions.messages(sessionId),
        });

        // Also invalidate session to update status
        queryClient.invalidateQueries({
          queryKey: queryKeys.sessions.detail(sessionId),
        });
      }
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [sessionId, queryClient]);
}
```

### Step 6: Update Session Panel (15 min)

```typescript
// src/features/session/ui/SessionPanel.tsx

import { useSessionEvents } from '../hooks/useSessionEvents';

export const SessionPanel = forwardRef<SessionPanelRef, SessionPanelProps>(
  ({ sessionId, ... }, ref) => {

    // ✅ Add event listener
    useSessionEvents(sessionId);

    // ✅ Update query config
    const messagesQuery = useQuery({
      queryKey: queryKeys.sessions.messages(sessionId || ''),
      queryFn: () => SessionService.fetchMessages(sessionId!),
      enabled: !!sessionId,
      refetchInterval: false, // ✅ NO POLLING!
      staleTime: 60000,       // Cache for 1 min
    });

    // ... rest of component
  }
);
```

---

## ✅ SUCCESS CRITERIA

### Desktop Mode (Tauri)
- [ ] Message appears in UI within 100ms of Claude response
- [ ] Network tab shows NO polling requests to /api/sessions/:id/messages
- [ ] Browser console shows `[Events] New message received: xxx`

### Web Mode (Browser)
- [ ] Falls back to smart polling (2s when working, disabled when idle)
- [ ] No Tauri event errors in console

### Both Modes
- [ ] All messages displayed correctly
- [ ] No message loss
- [ ] Typing/sending works
- [ ] Session status updates

---

## 🎉 CONCLUSION

**You were absolutely right to question the polling approach!**

**The infrastructure ALREADY EXISTS:**
- ✅ Tauri event system (proven with PTY)
- ✅ Sidecar process with Unix socket
- ✅ Rust ↔ Frontend IPC

**We just need to connect the dots:**
1. Sidecar emits events (20 lines)
2. Rust forwards them (30 lines)
3. Frontend listens (40 lines)

**Result:**
- **Latency:** 2000ms → <100ms (20× faster!)
- **API calls:** 1,700/min → <10/min (99% reduction!)
- **Real-time:** True push, not pull
- **Battery:** Way better (no constant network)

**Estimated implementation:** 2-4 hours for Option B, fully tested.

**Should we implement this now?**
