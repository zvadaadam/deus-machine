# 🎯 Proper Development Workflow

## The Issue

You're right - the 36-port scanning is overengineered! It only exists as a **fallback** when things aren't run properly.

## The Correct Way

### ✅ Use `npm run dev:full`

This script (`./dev.sh`) does it properly:

1. **Starts backend** with `PORT=0` (dynamic port)
2. **Waits for backend** to log `[BACKEND_PORT]51176`
3. **Captures the port** from the log
4. **Passes it to Vite**: `VITE_BACKEND_PORT=51176 npm run dev`

Then the frontend code does:

```typescript
// Check env var first (from dev.sh)
if (import.meta.env.VITE_BACKEND_PORT) {
  const port = parseInt(import.meta.env.VITE_BACKEND_PORT as string, 10);
  console.log(`[API] Using web dev backend port: ${port}`);
  return port; // ✅ Instant, no scanning!
}

// Only if env var missing, do port discovery (fallback)
const discoveredPort = await discoverBackendPort();
```

## What You're Probably Doing Wrong

Running processes **separately**:
```bash
# Terminal 1
npm run dev:backend

# Terminal 2
npm run dev
```

This causes the problem because:
- Backend runs on random port (e.g., 51176)
- Frontend starts **without** knowing the port
- Has to scan 36 ports to find it

## The Fix

### For Web Development
**Use this instead:**
```bash
npm run dev:full
```

This runs **both** backend and frontend together with proper port communication.

### For Desktop App (Tauri)
```bash
npm run tauri:dev
```

This is already correct! Tauri uses `invoke('get_backend_port')` to get the port directly from Rust's BackendManager. No scanning needed!

## Summary

- **Desktop app (Tauri)**: Already perfect ✅
- **Web dev**: Should use `npm run dev:full` instead of separate processes
- **Port discovery**: Only fallback for incorrect setup

The proper architecture:
1. **Tauri**: Rust manages backend → Direct IPC → No discovery needed
2. **Web dev**: Shell script manages backend → Env var → No discovery needed
3. **Port scanning**: Emergency fallback for manual/incorrect starts

**Want me to remove the port discovery code since it's just hiding the real problem?**
