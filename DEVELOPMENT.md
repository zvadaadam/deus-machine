# Development Guide

## Machine Setup

```bash
bun run setup    # root + apps/cloud-relay + apps/landing dependencies
bun run doctor   # verifies the toolchain below
```

| Tool                     | Needed for                                                | Notes                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 22.x                | everything                                                | Pinned in `.node-version`. Newer majors (Homebrew's default `node`) fail to compile `better-sqlite3`. Use `brew install node@22 && brew link --overwrite --force node@22`, or fnm/mise. |
| Bun                      | everything                                                | CI pins the version in `package.json` `packageManager`. A newer local Bun works; don't commit lockfile rewrites.                                                                        |
| Xcode Command Line Tools | native modules                                            | `xcode-select --install`                                                                                                                                                                |
| Full Xcode               | iOS simulator, `bun run build:all`, `bun run package:mac` | The simulator helpers are universal binaries; Command Line Tools cannot link the x86_64 slice. `bun install` skips them without Xcode.                                                  |
| `jq`, `gh`               | `scripts/bump-version.sh`, releases                       |                                                                                                                                                                                         |
| Developer ID certificate | signing locally                                           | Not needed normally: releases are signed and notarized in CI. See [docs/releases.md](docs/releases.md).                                                                                 |

`apps/cloud-relay` and `apps/landing` are standalone packages with their own lockfiles, so a plain
root `bun install` does not cover them and `bun run typecheck:all` fails until `bun run setup` has run.

The dev backend opens the same database as the installed app
(`~/Library/Application Support/com.deus.app/deus.db`), shared by every checkout. Set
`DATABASE_PATH=/some/other/deus.db` before `bun run dev` / `bun run dev:web` to isolate a branch
that changes the schema.

---

## Quick Start

### Desktop App Development

```bash
bun run dev
```

**This is all you need!** It starts:

- Vite dev server (frontend)
- Backend server (auto-managed by Electron main process)
- Electron desktop app

**DO NOT** run `bun run dev:frontend` or `bun run dev:backend` separately when developing the desktop app!

### Web-Only Development

```bash
bun run dev:web
```

This runs both backend and frontend together with proper port configuration.

**DO NOT** run `bun run dev:frontend` and `bun run dev:backend` in separate terminals!

---

## Architecture

### Desktop App (Electron)

```
bun run dev
  └─> electron-vite starts Electron + Vite
      ├─> Main process spawns Node.js backend as child process
      │   └─> Backend runs on dynamic port (e.g., 51176)
      ├─> Main process spawns agent-server as child process
      │   └─> Agent-server connects via Unix socket
      ├─> Vite dev server runs renderer
      │   └─> Frontend runs on http://localhost:1420
      └─> Frontend gets backend port via IPC (getBackendPort)
          No port discovery needed!
```

### Web Development

```
bun run dev:web (scripts/runtime/dev.ts)
  ├─> Starts backend with PORT=0
  │   └─> Captures port from log: [BACKEND_PORT]51176
  └─> Starts Vite with VITE_BACKEND_PORT=51176
      Frontend knows port immediately!
```

---

## Common Mistakes

### Don't Do This

```bash
# Terminal 1
bun run dev:backend

# Terminal 2
bun run dev:frontend
```

**Problem:** Frontend doesn't know backend port -> triggers port discovery scan -> slow & fragile

### Do This Instead

```bash
# Desktop development
bun run dev

# OR web development
bun run dev:web
```

---

## Local Database Schema

Deus is still pre-launch, so the checked-in SQLite schema is the source of truth.
Breaking schema changes should update `shared/schema.ts` directly instead of
adding compatibility migrations for old local databases.

If your local database was created by an older build and the backend reports a
pre-launch schema mismatch, reset it by deleting `deus.db` from the app data
directory or by pointing `DATABASE_PATH` at a fresh file before restarting.

Use durable migrations only after launch or once real external testers depend on
preserved local data.

---

## Available Scripts

### Main Commands (Use These!)

- `bun run dev` - Desktop app (recommended for most development)
- `bun run dev:web` - Web dev (browser-only testing)
- `bun run build:all` - Build everything for production
- `bun run package:mac` - Package macOS app

### Individual Components (Avoid!)

- `bun run dev:frontend` - Frontend only (needs backend separately)
- `bun run dev:backend` - Backend only (needs frontend separately)

---

## Port Configuration

### How Ports Work

**Backend:**

- Uses `PORT=0` -> OS assigns random available port
- Logs port as `[BACKEND_PORT]51176`
- Dynamic to avoid conflicts

**Frontend:**

- Default port: `1420`
- Auto-increments to next available port if 1420 is taken (1421, 1422, etc.)
- Check Vite terminal output to see actual port used

**Backend Discovery:**

1. **Electron mode:** IPC `getBackendPort()` -> instant
2. **Web dev mode:** `VITE_BACKEND_PORT` env var -> instant
3. **Fallback:** Default port 3333 (only if nothing else works)

---

## For AI Assistants

**When asked to start the development server:**

- Desktop development: `bun run dev`
- Web development: `bun run dev:web`
- **NEVER** run `bun run dev:frontend` and `bun run dev:backend` separately

**Why?**
The proper scripts handle port communication automatically. Running components separately breaks the architecture and triggers slow port discovery fallbacks.

---

## Troubleshooting

### "Failed to fetch" errors in console

**Cause:** Frontend can't find backend
**Fix:** Make sure you used `bun run dev` or `bun run dev:web`, not individual scripts

### Backend on wrong port

**Cause:** Multiple backend instances running
**Fix:** Kill all node processes and restart with proper command

```bash
pkill -f "apps/backend/server.cjs"
bun run dev
```

### Vite not hot-reloading

**Cause:** Vite wasn't started by electron-vite or `bun run dev:web`
**Fix:** Stop everything, use `bun run dev`
