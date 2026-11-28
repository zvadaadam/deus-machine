# Development Guide

## Machine Setup

```bash
bun run setup    # root + apps/cloud-relay + apps/landing dependencies
bun run doctor   # verifies the toolchain below
```

| Tool                     | Needed for                          | Notes                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 22 or newer         | everything                          | CI runs the version in `.node-version`. `better-sqlite3` carries Node-API prebuilds on all platforms and `node-pty` does on macOS and Windows (Linux builds `node-pty` once below), so any Node 22.14+ (including Homebrew's default `node`) works without rebuilding per major. |
| Bun                      | everything                          | CI and runtime builds require the Bun version in the root `packageManager` field. Run `bun run build:runtime` before `bun run package:mac:dir`, which uses the staged runtime.                                                                                                   |
| Xcode Command Line Tools | native modules                      | `xcode-select --install`                                                                                                                                                                                                                                                         |
| Full Xcode               | Local iOS Simulators                | Settings → Devices shows the installed version.                                                                                                                                                                                                                                  |
| `jq`, `gh`               | `scripts/bump-version.sh`, releases |                                                                                                                                                                                                                                                                                  |
| Developer ID certificate | signing locally                     | Not needed normally: releases are signed and notarized in CI. See [docs/releases.md](docs/releases.md).                                                                                                                                                                          |

`apps/cloud-relay` and `apps/landing` are standalone packages with their own lockfiles, so a plain
root `bun install` does not cover them and `bun run typecheck:all` fails until `bun run setup` has run.

Before pushing, run `bun run check`. Its browser journeys need Chromium
(`bunx playwright install chromium`) and its video tests need FFmpeg and ffprobe
(`brew install ffmpeg` on macOS). On Linux, build the terminal binding once
with `(cd node_modules/node-pty && bunx node-gyp rebuild)`.

Each checkout uses `.deus-dev/deus.db` for `bun run dev`, `bun run dev:web`,
`bun run dev:backend`, and `bun run cli:backend`. Set `DATABASE_PATH` to use
another file. Checkout launchers discard database overrides inherited from
older packaged Deus agent shells. The dev desktop also keeps its profile in
`.deus-dev/`, so a new worktree starts signed out. The installed Mac app uses
`~/Library/Application Support/com.deus.app/deus.db`.

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
      │   └─> Backend runs on dynamic port (e.g., 51176), with the agent engine in it
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
