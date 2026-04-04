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

| Frame | Purpose |
|---|---|
| `q:subscribe` / `q:snapshot` / `q:delta` | Reactive data subscriptions (workspaces, stats, sessions, messages) |
| `q:mutate` / `q:mutate_result` | Sync writes (archiveWorkspace, updateWorkspaceTitle) |
| `q:command` / `q:command_ack` | Async actions (sendMessage, stopSession) |
| `q:event` | Ephemeral push (tool relay, plan-mode) |

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
