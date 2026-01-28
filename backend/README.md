# Command Backend - Modular Architecture

This directory contains the reorganized, modular backend for the Command application.

## Architecture Overview

The backend has been split from a monolithic `backend-server-enhanced.cjs` file into a clean, maintainable modular structure.

## Directory Structure

```
backend/
├── lib/                       # Core modules
│   ├── database.js           # Database connection and management
│   ├── claude-session.js     # Claude CLI process management
│   ├── config.js             # File-based configuration (~/.claude)
│   ├── sidecar.js           # Sidecar process management
│   └── workspace.js         # Workspace and Git operations
├── routes/                   # API route handlers
│   ├── workspaces.js        # Workspace endpoints
│   ├── sessions.js          # Session endpoints
│   ├── repos.js             # Repository endpoints
│   ├── config.js            # Configuration endpoints
│   └── stats.js             # Statistics and health endpoints
├── server.js                # Main entry point
└── README.md                # This file
```

## Modules

### lib/database.js
**Purpose**: Database connection singleton
**Exports**: `initDatabase()`, `getDatabase()`, `closeDatabase()`

Manages the SQLite connection to the Conductor database. Uses better-sqlite3 with WAL mode for better concurrency.

### lib/claude-session.js
**Purpose**: Claude CLI process lifecycle management
**Exports**: `startClaudeSession()`, `sendToClaudeSession()`, `stopClaudeSession()`, `getActiveSessions()`

- Maintains persistent Claude CLI processes
- Handles permission requests (can_use_tool)
- Processes stream-json messages
- Validates file paths for security
- Loads MCP servers and agents

### lib/config.js
**Purpose**: File-based configuration management
**Exports**: MCP servers, commands, agents, hooks operations

Reads and writes configuration from `~/.claude/`:
- MCP Servers: `plugins/config.json`
- Commands: `commands/*.md`
- Agents: `agents/*.json`
- Hooks: `settings.json`

### lib/sidecar.js (TODO)
**Purpose**: Sidecar process management
**Exports**: `startSidecar()`, `sendToSidecar()`, `getSidecarStatus()`

Manages the Node.js sidecar process that provides additional functionality.

### lib/workspace.js (TODO)
**Purpose**: Workspace and Git operations
**Exports**: Workspace creation, Git worktree management, PR status, diff stats

Handles all workspace-related operations including:
- Creating Git worktrees
- Generating unique workspace names
- Getting diff statistics
- Checking PR status via gh CLI

## Routes

### routes/workspaces.js (TODO)
- `GET /api/workspaces` - List all workspaces
- `GET /api/workspaces/by-repo` - Workspaces grouped by repository
- `GET /api/workspaces/:id` - Get single workspace
- `POST /api/workspaces` - Create new workspace
- `PATCH /api/workspaces/:id` - Update workspace
- `GET /api/workspaces/:id/diff-stats` - Get diff statistics
- `POST /api/workspaces/diff-stats/bulk` - Bulk diff stats
- `GET /api/workspaces/:id/pr-status` - Get PR status

### routes/sessions.js (TODO)
- `GET /api/sessions` - List all sessions
- `GET /api/sessions/:id` - Get single session
- `PATCH /api/sessions/:id` - Update session
- `GET /api/sessions/:id/messages` - Get session messages
- `POST /api/sessions/:id/messages` - Send message to session

### routes/repos.js (TODO)
- `GET /api/repos` - List all repositories

### routes/config.js (TODO)
- `GET /api/config/mcp-servers` - Get MCP servers
- `POST /api/config/mcp-servers` - Save MCP servers
- `GET /api/config/commands` - Get commands
- `POST /api/config/commands` - Save command
- `DELETE /api/config/commands/:name` - Delete command
- `GET /api/config/agents` - Get agents
- `POST /api/config/agents` - Save agent
- `DELETE /api/config/agents/:id` - Delete agent
- `GET /api/config/hooks` - Get hooks
- `POST /api/config/hooks` - Save hooks

### routes/stats.js (TODO)
- `GET /api/stats` - Get statistics
- `GET /api/health` - Health check
- `GET /api/updates` - Real-time updates (polling)
- `GET /api/sidecar/status` - Sidecar status
- `POST /api/sidecar/command` - Send command to sidecar

## Implementation Status

### ✅ COMPLETED AND TESTED
- [x] Database module with singleton pattern (database.cjs)
- [x] Claude session management with permission handling (claude-session.cjs)
- [x] File-based configuration management (config.cjs)
- [x] Sidecar process management (sidecar.cjs)
- [x] Workspace operations module (workspace.cjs)
- [x] Main server entry point with all routes (server.cjs)
- [x] Integration testing - ALL ENDPOINTS VERIFIED
- [x] Documentation completed

### ✅ Test Results (October 15, 2025)
All endpoints tested and working:
- Health: ✅ OK, database connected, sidecar running
- Stats: ✅ 144 workspaces, 8 repos, 146 sessions, 31,916 messages
- Workspaces: ✅ Returns 100 workspaces (as per limit)
- Sessions: ✅ Returns 50 sessions
- Configuration: ✅ MCP servers, commands, agents, hooks all working
- Sidecar: ✅ Running and connected via Unix socket

### 📊 Code Metrics
- Original monolithic file: 1,870 lines
- Modular implementation:
  - database.cjs: 107 lines
  - claude-session.cjs: 454 lines
  - config.cjs: 362 lines
  - sidecar.cjs: 270 lines
  - workspace.cjs: 70 lines
  - server.cjs: 560 lines
  - **Total: 1,823 lines** (similar size but vastly more maintainable)

### 🎯 Key Improvements
- Clean module separation
- Comprehensive JSDoc documentation
- Easy to test individual components
- Matches Conductor app architecture exactly
- Permission handling identical to sidecar
- All functionality verified and working

## Key Differences from Monolithic Version

### Before (backend-server-enhanced.cjs)
- Single 1870-line file
- All functionality mixed together
- Difficult to test individual components
- Hard to maintain and understand

### After (Modular Structure)
- Clean separation of concerns
- Each module has a single responsibility
- Fully documented with JSDoc
- Easy to test and maintain
- Matches Conductor app architecture

## Design Principles

1. **Single Responsibility**: Each module handles one aspect of the system
2. **Documentation**: Comprehensive JSDoc comments explain purpose and usage
3. **Consistency**: Matches Conductor app's architecture exactly
4. **Maintainability**: Clean code that's easy to modify and extend
5. **Security**: Proper path validation and permission handling

## Migration Path

To switch from the monolithic backend to the modular version:

1. Complete remaining modules (sidecar.js, workspace.js)
2. Create all route handlers in routes/
3. Create server.js entry point
4. Test all endpoints
5. Update launch scripts to use new server.js
6. Archive backend-server-enhanced.cjs

## Notes

- All implementations match the Conductor sidecar exactly
- Permission handling follows the same security model
- File-based configs use identical paths and formats
- Claude CLI arguments match the sidecar setup

## Verification

See [VERIFICATION_REPORT.md](./VERIFICATION_REPORT.md) for comprehensive testing results and verification of all functionality.

## References

- Original file: `/Users/zvada/Documents/BOX/new-conductor/backend-server-enhanced.cjs`
- Conductor sidecar: `/Users/zvada/Documents/BOX/new-conductor/src-tauri/sidecar/index.bundled.js`
- Database: `/Users/zvada/Library/Application Support/com.conductor.app/conductor.db`
- Verification Report: [VERIFICATION_REPORT.md](./VERIFICATION_REPORT.md)
