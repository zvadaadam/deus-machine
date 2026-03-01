# Code Reviewer Memory

## Project: OpenDevs IDE

### Architecture

- Tauri (Rust) + React frontend + Node.js backend + Sidecar (Claude Agent SDK)
- Working directory for worktree: `/Users/zvada/Developer/agent/box-ide/.conductor/tripoli-v2`
- Rust source: `src-tauri/src/`
- Frontend: `src/` (React + Zustand + TanStack Query)
- Backend: `backend/src/` (Hono on Node.js)
- Sidecar: `sidecar/` (Claude SDK, direct SQLite)

### Sentry Integration (reviewed 2026-03-01)

- Three separate Sentry projects, three separate DSNs:
  - Rust/Tauri: `4510971271053312` (main.rs)
  - Frontend: `4510971280097280` (main.tsx, errorReporting.ts)
  - Backend + Sidecar: `4510971283898368` (server.ts, sidecar/index.ts — **shared DSN**)
- Frontend Sentry disabled in dev (`enabled: !import.meta.env.DEV`); Rust and Node have no such guard
- Rust uses `cfg!(dev)` for environment label (Tauri-specific, not `#[cfg(debug_assertions)]`)
- `unhandledRejection` in backend does NOT call `Sentry.close()` before continuing — intentional (non-fatal)
- Sidecar does NOT flush Sentry on `unhandledRejection` — potentially lossy
- `sentryVitePlugin` uses stale org/project slugs `deus-40` / `deus-desktop-frontend` (leftover from old brand)
- `sourcemap: true` in vite build config enables source maps globally — leaks to client in prod unless Sentry strips them

### Recurring Patterns

- Import ordering matters: Sentry must be imported and initialized before other side-effectful imports
- `Sentry.close(2000)` pattern used correctly in `uncaughtException` handlers to flush before exit
- `send_default_pii: true` across all layers — confirm this is intentional before shipping

### File Locations for Common Concerns

- Error reporting util: `src/shared/utils/errorReporting.ts`
- Global type declarations: `src/vite-env.d.ts`
- Vite config: `vite.config.ts`
- Backend entry: `backend/src/server.ts`
- Sidecar entry: `sidecar/index.ts`
- Rust entry: `src-tauri/src/main.rs`
- Cargo deps: `src-tauri/Cargo.toml`
