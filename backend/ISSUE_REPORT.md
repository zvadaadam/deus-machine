# Backend Unresponsive Issue - Root Cause Analysis

## Problem
The frontend was making many requests to the backend (`http://localhost:3333/api`), but all requests were **pending/hanging** with no response.

## Root Cause
**The backend server was not running at all!**

The application has 3 components:
1. **Frontend** (React + Vite) - Port 1420
2. **Backend** (Node.js + Express) - Port 3333  
3. **Tauri App** (Rust) - Desktop wrapper

### What Went Wrong
- You were running only `npm run dev` which starts **just the frontend**
- The backend at `http://localhost:3333` was **not started**
- Frontend polls every 2 seconds (`POLL_INTERVAL: 2000` in `api.config.ts`)
- All requests timeout after 30 seconds (`REQUEST_TIMEOUT: 30000`)
- This caused the unresponsive/pending state

### Why Tauri Wasn't Starting It
The `main.rs` is designed to auto-start the backend, but it only works when running the **full Tauri app** (`npm run tauri:dev`), not when running just Vite.

## Solution

### Option 1: Use the Full Dev Script (Recommended)
```bash
npm run dev:full
```

This runs both frontend AND backend together (using the new `dev.sh` script).

### Option 2: Run Backend Separately
Terminal 1:
```bash
npm run dev:backend
```

Terminal 2:
```bash
npm run dev
```

### Option 3: Run Full Tauri App
```bash
npm run tauri:dev
```

This runs the complete desktop app which auto-starts the backend.

## Configuration Details

### Frontend Polling
From `src/config/api.config.ts`:
- Base URL: `http://localhost:3333/api`
- Poll interval: **2 seconds**
- Request timeout: **30 seconds**

### Backend Dependencies
The backend requires:
- `express` - API server
- `cors` - CORS handling
- `better-sqlite3` - Database
- Other Node.js packages

All dependencies are installed via `npm install` in the backend directory.

## Verification
Backend is now working:
```bash
$ curl http://localhost:3333/api/health
{"status":"ok","database":"connected","sidecar":"running","socket":"connected"}

$ curl http://localhost:3333/api/stats
{"workspaces":171,"workspaces_ready":25,"repos":10,"sessions":173,...}
```

## Next Steps
1. Kill any manually started backend processes
2. Use `npm run dev:full` for development
3. Consider reducing the frontend polling interval if needed
4. The backend auto-starts when running production Tauri app

## Files Modified
- ✅ Created `dev.sh` - Script to run both frontend + backend
- ✅ Made `dev.sh` executable

## Architecture Notes
```
┌─────────────────┐      HTTP Requests       ┌──────────────────┐
│   Frontend      │ ───────────────────────> │   Backend        │
│   (React+Vite)  │   localhost:3333/api     │   (Node+Express) │
│   Port: 1420    │ <─────────────────────── │   Port: 3333     │
└─────────────────┘      JSON Responses       └──────────────────┘
                                                      │
                                                      │ SQLite
                                                      ▼
                                              ┌──────────────────┐
                                              │    Database      │
                                              │  conductor.db    │
                                              └──────────────────┘
```

The frontend was calling the backend, but the backend wasn't there to answer!
