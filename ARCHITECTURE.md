# OpenDevs Architecture

## Overview

OpenDevs is a **proper Tauri 2.0 application** with Rust managing the entire application lifecycle. The app provides an AI-powered development environment with Claude Code integration.

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────┐
│                 CONDUCTOR TAURI APPLICATION                │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  Frontend (React + TypeScript)                       │ │
│  │  - Dashboard, WorkspaceDetail, Terminal, Settings    │ │
│  │  - Vite dev server (localhost:1420 in dev)          │ │
│  └────────────┬───────────────────────┬─────────────────┘ │
│               │                       │                    │
│               │ invoke()              │ HTTP fetch()       │
│               ▼                       ▼                    │
│  ┌───────────────────┐    ┌──────────────────────────┐   │
│  │  Rust Layer       │    │  Node.js Backend         │   │
│  │  (src-tauri/src/) │    │  (backend/server.cjs)    │   │
│  │                   │    │                          │   │
│  │  • PTY Manager    │    │  • Express API (:3333)   │   │
│  │  • Backend Mgr ◄──┼────┼─ Spawned/Managed by Rust│   │
│  │  • Tauri Window   │    │  • SQLite Database       │   │
│  └───────────────────┘    │  • Claude CLI Manager    │   │
│                            │  • Workspace Logic       │   │
│                            └──────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### 1. Rust Backend (`src-tauri/src/`)

**Files:**
- `main.rs` - Application entry point, manages all startup/shutdown
- `backend.rs` - BackendManager for Node.js backend lifecycle
- `pty.rs` - PTY (pseudo-terminal) management for terminals
- `commands.rs` - Tauri command handlers for frontend
- `lib.rs` - Module exports

**Responsibilities:**
- ✅ Start/stop Node.js backend automatically
- ✅ Manage terminal (PTY) sessions
- ✅ Provide Tauri window/app management
- ✅ Handle graceful shutdown of all child processes

**Key Features:**
- Backend auto-starts on app launch
- Backend auto-stops when app closes
- No manual process management needed

### 2. Node.js Backend (`backend/server.cjs`)

**Port:** 3333

**Responsibilities:**
- ✅ REST API for workspaces, sessions, repositories
- ✅ SQLite database management
- ✅ Claude CLI process spawning and management
- ✅ Git operations and diff calculations
- ✅ Configuration management (MCP servers, commands, agents, hooks)

**Key Endpoints:**
```
/api/workspaces         - Workspace management
/api/sessions           - Claude session management
/api/repos              - Repository information
/api/stats              - Application statistics
/api/config/*           - Configuration management
```

**Database:** `~/Library/Application Support/com.conductor.app/conductor.db`

### 3. Frontend (`src/`)

**Technology:** React + TypeScript + Vite

**Main Components:**
- `Dashboard.tsx` - Main workspace/repository view
- `WorkspaceDetail.tsx` - Claude session chat interface
- `Terminal.tsx` - Terminal emulator (xterm.js)
- `TerminalPanel.tsx` - Terminal management panel
- `Settings.tsx` - Application configuration

**Communication:**
- **Rust commands**: Via `invoke()` for PTY operations
- **Backend API**: Via `fetch()` to `http://localhost:3333`

## Startup Flow

### Development Mode

```bash
$ npm run tauri:dev
```

**What happens:**
1. Vite starts frontend dev server (localhost:1420)
2. Rust compiles and runs Tauri app
3. **Rust automatically starts Node.js backend** (localhost:3333)
4. Backend initializes database and starts API server
5. Frontend loads and connects to backend
6. ✅ Everything works with ONE command!

### Production Mode

```bash
$ npm run tauri:build
```

**What happens:**
1. Frontend is bundled into `dist/`
2. Backend is bundled into app resources
3. Rust app is compiled
4. macOS `.app` bundle is created
5. When user opens the app:
   - Rust starts backend from bundled resources
   - Frontend loads from bundled dist
   - Everything works automatically!

## Removed/Simplified Components

### What Was Removed:
- ❌ `src-tauri/src/database.rs` - Empty placeholder
- ❌ `src-tauri/src/sidecar.rs` - Orphaned, never used by frontend
- ❌ Rust sidecar commands - Frontend never called them
- ❌ `sidecar-src/` - Entire directory (56MB) - Source code for disabled sidecar
- ❌ `src-tauri/sidecar/` - Bundled sidecar no longer needed

### What Was Disabled:
- ⚠️ Sidecar process (`backend/lib/sidecar/`) - Commented out, redundant
  - Backend handles Claude CLI directly
  - Sidecar caused crashes due to native module bundling issues

## Configuration Files

### `tauri.conf.json`
```json
{
  "bundle": {
    "resources": [
      "sidecar/*",
      "../backend/**/*.cjs"  // Backend bundled in app
    ]
  }
}
```

### `package.json`
```json
{
  "scripts": {
    "tauri:dev": "tauri dev",      // Start everything
    "tauri:build": "tauri build"   // Build production app
  }
}
```

## Database Schema

**Location:** `~/Library/Application Support/com.conductor.app/conductor.db`

**Main Tables:**
- `workspaces` - Development workspaces (Git repos + branches)
- `sessions` - Claude conversation sessions
- `messages` - Chat messages and tool calls
- `repositories` - Git repository metadata

## Development Workflow

### Starting Development:
```bash
npm install          # Install dependencies
npm run tauri:dev    # Start app (everything auto-starts!)
```

### Making Changes:
- **Frontend**: Edit `src/*.tsx` - Vite hot-reloads automatically
- **Backend**: Edit `backend/*.cjs` - Restart app to see changes
- **Rust**: Edit `src-tauri/src/*.rs` - Cargo recompiles automatically

### Building for Production:
```bash
npm run build        # Build frontend
npm run tauri:build  # Build entire app
```

**Output:** `src-tauri/target/release/bundle/macos/OpenDevs.app`

## Key Improvements Made

### Before (Broken):
```bash
$ npm run tauri:dev
$ cd backend && node server.cjs  # Manual!
$ # Now it works...
```

### After (Fixed):
```bash
$ npm run tauri:dev
$ # Everything works automatically!
```

## Benefits of New Architecture

1. ✅ **Proper Tauri Pattern** - Rust manages all processes
2. ✅ **Single Command Startup** - `npm run tauri:dev` does everything
3. ✅ **Automatic Lifecycle** - Backend starts/stops with app
4. ✅ **No Manual Steps** - No need to remember to start backend
5. ✅ **Clean Shutdown** - All processes terminate gracefully
6. ✅ **Production Ready** - Backend bundles into app automatically

## Future Enhancements

### Phase 2 (Optional):
- Move simple database operations to Rust (using tauri-plugin-sql)
- Migrate file operations to Rust native code
- Keep Claude CLI management in Node.js (complex logic)

### Phase 3 (Optional):
- Full Rust backend (remove Node.js entirely)
- Pure native performance
- Single binary deployment

## Troubleshooting

### Backend not starting:
1. Check logs: Backend starts on port 3333
2. Verify Node.js is installed: `node --version`
3. Check backend path in logs: Should point to `backend/server.cjs`

### Frontend not connecting:
1. Ensure backend is running: `curl http://localhost:3333/api/stats`
2. Check browser console for errors
3. Verify API_BASE in frontend: `http://localhost:3333/api`

### Terminal not working:
1. PTY is managed by Rust, check Rust logs
2. Ensure PTY commands are registered in `main.rs`
3. Check terminal component for `invoke()` calls

## Summary

OpenDevs is now a **proper, production-ready Tauri application** with:
- ✅ Rust orchestrating everything
- ✅ Node.js backend auto-managed
- ✅ Single-command startup
- ✅ Graceful lifecycle management
- ✅ Clean architecture with clear responsibilities

**One command to rule them all:** `npm run tauri:dev` 🎉
