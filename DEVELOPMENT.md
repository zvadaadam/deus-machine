# 🚀 Development Guide

## Quick Start

### Desktop App Development
```bash
npm run tauri:dev
```
**This is all you need!** It starts:
- ✅ Vite dev server (frontend)
- ✅ Backend server (auto-managed by Rust)
- ✅ Tauri desktop app

**DO NOT** run `npm run dev` or `npm run dev:backend` separately when developing the desktop app!

### Web-Only Development
```bash
npm run dev:full
```
This runs both backend and frontend together with proper port configuration.

**DO NOT** run `npm run dev` and `npm run dev:backend` in separate terminals!

---

## Architecture

### Desktop App (Tauri)
```
npm run tauri:dev
  └─> Tauri starts Rust backend
      ├─> Rust manages Node.js backend process
      │   └─> Backend runs on dynamic port (e.g., 51176)
      ├─> Rust manages Vite dev server
      │   └─> Frontend runs on http://localhost:1420
      └─> Frontend gets backend port via invoke('get_backend_port')
          ✅ Zero port discovery needed!
```

### Web Development
```
npm run dev:full (./dev.sh)
  ├─> Starts backend with PORT=0
  │   └─> Captures port from log: [BACKEND_PORT]51176
  └─> Starts Vite with VITE_BACKEND_PORT=51176
      ✅ Frontend knows port immediately!
```

---

## Common Mistakes

### ❌ Don't Do This
```bash
# Terminal 1
npm run dev:backend

# Terminal 2
npm run dev
```
**Problem:** Frontend doesn't know backend port → triggers 36-port discovery scan → slow & fragile

### ✅ Do This Instead
```bash
# Desktop development
npm run tauri:dev

# OR web development
npm run dev:full
```

---

## Available Scripts

### Main Commands (Use These!)
- `npm run tauri:dev` - 🚀 **Desktop app** (recommended for most development)
- `npm run dev:full` - 🌐 **Web dev** (browser-only testing)
- `npm run tauri:build` - 📦 **Production build**

### Individual Components (Avoid!)
- `npm run dev` - ⚠️ Frontend only (needs backend separately)
- `npm run dev:backend` - ⚠️ Backend only (needs frontend separately)

### Why Individual Scripts Exist
They're useful for:
- CI/CD pipelines
- Debugging specific issues
- Advanced development workflows

But for normal development, use `tauri:dev` or `dev:full`!

---

## Port Configuration

### How Ports Work

**Backend:**
- Uses `PORT=0` → OS assigns random available port
- Logs port as `[BACKEND_PORT]51176`
- Dynamic to avoid conflicts

**Frontend:**
- Fixed port: `1420` (configured in Tauri)
- In web mode: Uses Vite default `5173` or `1420`

**Backend Discovery:**
1. **Tauri mode:** `invoke('get_backend_port')` → instant ✅
2. **Web dev mode:** `VITE_BACKEND_PORT` env var → instant ✅
3. **Fallback:** Port discovery (36-port scan) → slow ⚠️

The fallback only triggers if you run things incorrectly!

---

## For AI Assistants

**When asked to start the development server:**
- Desktop development: `npm run tauri:dev`
- Web development: `npm run dev:full`
- **NEVER** run `npm run dev` and `npm run dev:backend` separately

**Why?**
The proper scripts handle port communication automatically. Running components separately breaks the architecture and triggers slow port discovery fallbacks.

---

## Troubleshooting

### "Failed to fetch" errors in console
**Cause:** Frontend can't find backend
**Fix:** Make sure you used `npm run tauri:dev` or `npm run dev:full`, not individual scripts

### Backend on wrong port
**Cause:** Multiple backend instances running
**Fix:** Kill all node processes and restart with proper command
```bash
pkill -f "backend/server.cjs"
npm run tauri:dev
```

### Vite not hot-reloading
**Cause:** Vite wasn't started by Tauri/dev.sh
**Fix:** Stop everything, use `npm run tauri:dev`
