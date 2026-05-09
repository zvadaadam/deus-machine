# Deus Machine

IDE for managing multiple parallel AI coding agents. Built for semi-technical people who care about output, not the code underneath. AI chat is the first-class citizen, code is secondary.

Design inspiration: Linear, Vercel, Stripe, Perplexity. Dense, pro-consumer aesthetic.

## Tech Stack

Electron desktop app + React frontend + Node.js backend. Monorepo under `apps/`.

- **Package manager: Bun.** Always `bun add`, `bun install`, `bun run`, `bunx`. Never npm or yarn — CI uses `bun install --frozen-lockfile`.
- **Desktop + Mobile Web:** Primary target is Electron. Web version (`app.deusmachine.ai`) also supports mobile via `MobileLayout`. Don't write `isElectronEnv` conditionals for feature parity.
- **Key libraries:** `ts-pattern` for discriminated unions (prefer `.exhaustive()`), Zustand for UI state, TanStack Query v5 for server state, Framer Motion for presence/layout animations, Tailwind CSS v4.

## Running the App

```bash
bun run dev:web   # Web: backend + frontend (dev.sh)
bun run dev       # Desktop: Vite + backend + Electron
```

Never run `bun run dev:frontend` alone — it skips the backend.

- Frontend: http://localhost:1420 (Vite auto-increments if taken)
- Backend: dynamic port (check terminal output)

## Architecture (3 Processes)

```text
Frontend (React)
  ├── WebSocket → Backend (apps/backend/) — all data + commands
  ├── Electron IPC → Desktop Main (apps/desktop/) — native ops only
  └── HTTP REST → Backend — fallback + workspace creation

Backend → Agent-Server (apps/agent-server/) — JSON-RPC 2.0 over WebSocket
```

**Electron Main** — Thin shell. Window lifecycle, native dialogs, process spawning. No business logic.

**Backend (Hono)** — All business logic. DB reads/writes, config, agent event persistence, tool relay, PTY, file watching. Routes under `/api`.

**Agent-Server** — Stateless. Wraps Claude/Codex SDKs, emits canonical events to backend. No DB access, no direct frontend communication. Separate process for isolation.

**Rule of thumb:** Needs native Electron API? → Main process. Everything else → Backend or Agent-Server.

### WebSocket Query Protocol

Single WS connection (`/ws`) using `q:` prefixed JSON frames:

| Frame                                    | Purpose                                                             |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `q:subscribe` / `q:snapshot` / `q:delta` | Reactive data subscriptions (workspaces, stats, sessions, messages) |
| `q:mutate` / `q:mutate_result`           | Sync writes (archiveWorkspace, updateWorkspaceTitle)                |
| `q:command` / `q:command_ack`            | Async actions (sendMessage, stopSession)                            |
| `q:event`                                | Ephemeral push (tool relay, plan-mode)                              |

Resources, mutations, commands, and events are all defined in `shared/events.ts`. Frontend subscribes via `useQuerySubscription()`.

### Adding a New WS Resource

1. Add resource to `QUERY_RESOURCES` in `shared/events.ts`
2. Add `runQuery` match in `apps/backend/src/services/query-engine.ts`
3. Add invalidation in `agent-event-handler.ts` or relevant route
4. Use `useQuerySubscription(resource, { queryKey, params })` in frontend
5. Set `staleTime: Infinity`, `refetchOnWindowFocus: false` (WS handles freshness)

## Database

Own SQLite at `~/Library/Application Support/com.deus.app/deus.db`. Schema in `shared/schema.ts` — 5 tables: `repositories`, `workspaces`, `sessions`, `messages`, `paired_devices`.

- Only the backend writes to DB
- All indexes/triggers defined in `shared/schema.ts`
- Use `sessions.last_user_message_at` instead of correlated subqueries
- No N+1 queries — batch or denormalize
- Column deprecation: rename with `DEPRECATED_` prefix, never drop

## Testing

```bash
bun run test:backend          # apps/backend/test/unit/
bun run test:agent-server     # apps/agent-server/test/
```

Vitest with `vi.mock()` and `vi.hoisted()`. Tests live outside `src/` — never colocate.

## Code Style

Detailed conventions for Tailwind v4, components, animations, and performance live in `.claude/skills/deus-code-style/`. Read the relevant file before writing or reviewing code.

## Hard Rules

- Never edit outside your worktree directory
- Never start the app outside your worktree directory
- Never use npm or yarn
- WebSocket push over polling — only poll for git diffs on working sessions
- All colors via CSS variables/tokens, never hardcoded

## Cursor Cloud specific instructions

### Environment

- **Bun** must be on `$PATH`. The update script installs it to `~/.bun/bin`. Ensure `export PATH="$HOME/.bun/bin:$PATH"` is active in your shell before running any `bun` commands.
- **Node.js 22** is pre-installed in the VM.
- The SQLite database on Linux lives at `~/.local/share/deus/deus.db` (not the macOS `~/Library/Application Support/` path mentioned elsewhere in the docs).

### Running services

- Use `bun run dev:web` to start all three services (agent-server, backend, frontend) together. See `DEVELOPMENT.md` for details. The script (`scripts/dev.sh`) uses Electron's Node binary with `ELECTRON_RUN_AS_NODE=1` for native module ABI compatibility.
- Use `bun run dev` to start the Electron desktop app (includes Vite, backend, agent-server). D-Bus errors in the VM logs (`Failed to connect to the bus`) are harmless — there is no system D-Bus in the Cloud VM.
- The agent-server bundle must exist before running `dev:web`. It is built automatically by `dev.sh` on first run, but you can pre-build it with `bun run build:agent-server`.

### Testing caveats

- **Backend integration tests** (`test/integration/`) fail under system Node because `better-sqlite3` and `node-pty` are compiled against Electron's Node ABI (`postinstall` runs `electron-builder install-app-deps`). Unit tests (`test/unit/`) pass fine. Use `bun run test:backend` for unit tests (3 integration files will fail with ABI mismatch — this is expected).
- **Agent-server unit tests** run cleanly: `bun run test:agent-server:unit`.
- **Lint** has pre-existing errors (3 errors, ~69 warnings) in the codebase. These are not introduced by your changes.

### Commands reference

| Task                 | Command                          |
| -------------------- | -------------------------------- |
| Install deps         | `bun install`                    |
| Dev server (web)     | `bun run dev:web`                |
| Dev server (desktop) | `bun run dev`                    |
| Backend tests        | `bun run test:backend`           |
| Agent-server tests   | `bun run test:agent-server:unit` |
| Lint                 | `bun run lint`                   |
| Format check         | `bun run format:check`           |
| Typecheck            | `bun run typecheck`              |
