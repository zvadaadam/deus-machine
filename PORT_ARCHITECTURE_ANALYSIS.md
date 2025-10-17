# Hardcoded Port Analysis - Architecture Issues

## Current Problem

Port **3333 is hardcoded in 20+ places** across the codebase:

### Critical Hardcoded Locations
1. `src-tauri/src/main.rs` - `const BACKEND_PORT: u16 = 3333`
2. `src/config/api.config.ts` - `BASE_URL: 'http://localhost:3333/api'`
3. `backend/server.cjs` - `const PORT = 3333`
4. `src/services/socket.ts` - `http://localhost:3333/api/sidecar/status`
5. `src-tauri/sidecar/index.cjs` - `http://localhost:3333`

## Why This Is An Anti-Pattern

### 1. **Port Conflicts**
```bash
# If port 3333 is already in use:
$ npm run tauri:dev
Error: listen EADDRINUSE: address already in use :::3333
```

The app **fails to start** instead of finding an available port.

### 2. **Multiple Instances**
Cannot run multiple instances of the app (for testing, different repos, etc.)
```bash
Instance 1: ✅ Port 3333
Instance 2: ❌ Port conflict!
```

### 3. **Security Concerns**
- Predictable port = other local apps can connect
- No isolation between instances
- Potential for port hijacking attacks

### 4. **Platform Issues**
- Corporate firewalls may block specific ports
- Some OS configurations restrict port ranges
- Port 3333 might be reserved on certain systems

### 5. **Development Friction**
- Developers must manually check and kill processes
- CI/CD environments may have port conflicts
- Harder to run tests in parallel

## Better Architectural Approaches

### ✅ **Option 1: Dynamic Port Allocation** (RECOMMENDED)

**Backend (server.cjs):**
```javascript
// Instead of:
const PORT = 3333;

// Do this:
const PORT = process.env.PORT || 0; // 0 = OS assigns random available port

const server = app.listen(PORT, () => {
  const actualPort = server.address().port;
  console.log(`Server running on port ${actualPort}`);
  
  // Write port to file for frontend discovery
  fs.writeFileSync('.backend-port', actualPort.toString());
});
```

**Rust (main.rs):**
```rust
pub fn start(&self, backend_path: PathBuf) -> Result<u16> {
    // Don't specify port, let OS choose
    let child = Command::new("node")
        .arg(&backend_path)
        .spawn()?;
    
    // Read actual port from file
    thread::sleep(Duration::from_millis(500));
    let port = fs::read_to_string(".backend-port")?
        .parse::<u16>()?;
    
    Ok(port)
}
```

**Frontend (api.config.ts):**
```typescript
// Use Tauri API to get port dynamically
import { invoke } from '@tauri-apps/api/core';

async function getBackendUrl(): Promise<string> {
  const port = await invoke<number>('get_backend_port');
  return `http://localhost:${port}/api`;
}
```

### ✅ **Option 2: Use Tauri Commands Instead of HTTP**

Replace HTTP API with Tauri's IPC:

**Current (HTTP):**
```typescript
// frontend
const response = await fetch('http://localhost:3333/api/workspaces');
```

**Better (Tauri Commands):**
```typescript
// frontend
const workspaces = await invoke('get_workspaces');
```

```rust
// backend (main.rs)
#[tauri::command]
async fn get_workspaces(db: State<'_, Database>) -> Result<Vec<Workspace>, String> {
    // Direct database access, no HTTP needed
    db.get_workspaces().map_err(|e| e.to_string())
}
```

**Benefits:**
- ✅ No port conflicts
- ✅ Type-safe communication
- ✅ No CORS issues
- ✅ Better performance (no HTTP overhead)
- ✅ More secure (no exposed ports)

### ✅ **Option 3: Hybrid Approach** (REALISTIC)

Keep HTTP for complex operations (Claude CLI, streaming), use Tauri commands for simple data:

```typescript
// Simple CRUD -> Tauri commands
const workspaces = await invoke('get_workspaces');
const session = await invoke('create_session', { repoId });

// Complex streaming -> HTTP (dynamic port)
const port = await invoke('get_backend_port');
const response = await fetch(`http://localhost:${port}/api/sessions/${id}/messages`);
```

## Recommended Migration Path

### Phase 1: Dynamic Port (Quick Win)
1. Modify `backend/server.cjs` to use port 0
2. Write port to file after server starts
3. Add Tauri command `get_backend_port` to read it
4. Update frontend to call command before API requests

### Phase 2: Migrate to Tauri Commands (Long-term)
1. Identify endpoints that don't need HTTP
2. Create Tauri commands for CRUD operations
3. Keep HTTP only for streaming/complex ops
4. Remove Express server if possible

### Phase 3: Clean Architecture
```
┌─────────────────────────────────────────┐
│           Tauri App (Rust)              │
├─────────────────────────────────────────┤
│                                         │
│  ┌──────────────┐    ┌──────────────┐  │
│  │   Frontend   │    │   Backend    │  │
│  │   (React)    │    │   (Rust)     │  │
│  │              │    │              │  │
│  │  • UI Logic  │◄──►│  • Database  │  │
│  │  • Display   │IPC │  • Business  │  │
│  │              │    │  • Claude    │  │
│  └──────────────┘    └──────────────┘  │
│         ▲                    │          │
│         │                    │          │
│         └────────────────────┘          │
│          Tauri Commands                 │
│          (No HTTP!)                     │
└─────────────────────────────────────────┘
```

## Implementation Example

**Step 1: Add Tauri command for dynamic port**

```rust
// src-tauri/src/commands.rs
#[tauri::command]
pub fn get_backend_port(backend: State<'_, BackendManager>) -> Result<u16, String> {
    backend.get_port().ok_or_else(|| "Backend not started".to_string())
}
```

**Step 2: Update frontend config**

```typescript
// src/config/api.config.ts
import { invoke } from '@tauri-apps/api/core';

let cachedPort: number | null = null;

async function getBaseUrl(): Promise<string> {
  if (!cachedPort) {
    cachedPort = await invoke<number>('get_backend_port');
  }
  return `http://localhost:${cachedPort}/api`;
}

export const API_CONFIG = {
  getBaseUrl,
  POLL_INTERVAL: 2000,
  REQUEST_TIMEOUT: 30000,
} as const;
```

**Step 3: Update API client**

```typescript
// src/services/api.ts
class ApiClient {
  async request<T>(endpoint: string, options: RequestInit): Promise<T> {
    const baseUrl = await API_CONFIG.getBaseUrl();
    const url = `${baseUrl}${endpoint}`;
    // ... rest of code
  }
}
```

## Comparison Table

| Approach | Port Conflicts | Multi-Instance | Security | Complexity |
|----------|---------------|----------------|----------|------------|
| **Hardcoded Port** (current) | ❌ High | ❌ No | ⚠️ Medium | ✅ Low |
| **Dynamic Port** | ✅ None | ✅ Yes | ✅ Good | ⚠️ Medium |
| **Tauri Commands Only** | ✅ None | ✅ Yes | ✅ Excellent | ⚠️ High |
| **Hybrid** | ✅ None | ✅ Yes | ✅ Good | ⚠️ Medium |

## Real-World Example: VS Code

VS Code uses dynamic port allocation:
```typescript
// Extension host starts on random port
const server = net.createServer();
server.listen(0); // Let OS choose
const port = server.address().port;

// Store port for communication
process.env.VSCODE_IPC_PORT = port.toString();
```

## Conclusion

**Current architecture with hardcoded port 3333 is a technical debt issue:**
- ⚠️ Works for single-instance development
- ❌ Breaks in multi-instance scenarios
- ❌ Creates deployment friction
- ❌ Not production-ready

**Recommended fix:**
1. Short-term: Implement dynamic port allocation (~2-3 hours work)
2. Long-term: Migrate to Tauri commands (~1-2 weeks work)

The dynamic port approach gives you immediate benefits with minimal changes.
