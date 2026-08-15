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

## Cursor Cloud setup

Fresh cloud images should have Bun available. If `command -v bun` fails, install it before any repo commands:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
```

For a fresh cloud agent, set up and smoke-test the repo from the workspace root:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test:backend
bun run test:agent-server
bun run dev:web
```

`bun run dev:web` is the preferred cloud smoke because it rebuilds the Node native module ABI, starts the backend, lets the backend own agent-server startup, and then starts Vite with the emitted backend port. Confirm the terminal shows `[agent-server] LISTEN_URL=...`, `[BACKEND_PORT]...`, `Server ready!`, and `[AgentService] Connected, agents: [claude, codex-sdk, codex-server]` before opening the frontend URL.

For browser-based UI smoke tests, install the Playwright browser after dependencies are installed:

```bash
bunx playwright install chromium
```

For Linux package/distribution checks:

```bash
bun run package:linux
```

This should produce both `dist-electron/Deus-*.AppImage` and `dist-electron/deus_*_amd64.deb`. On Cursor Cloud, direct AppImage execution may fail without `libfuse.so.2`; use `APPIMAGE_EXTRACT_AND_RUN=1` for smoke tests in that environment.

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

### The @zvada/agent-server package (upstream engine + wire)

The agent-server runs on the upstream **[`@zvada/agent-server`](https://github.com/zvadaadam/agent-server)** package (same author as this repo): `/core` is the engine (AgentRuntime + Claude/Codex/ACP harness adapters), `/protocol` the zod wire contract, `/server` the JSON-RPC 2.0 wire (per-session `seq`, bounded replay, quick-ack turns), `/client` the typed consumer the backend uses. Deus-specific traffic (tool round-trips, AAP MCP hot-swap, provider auth, titles) rides a `deus/*` side channel multiplexed on the same pipe — see `shared/agent-side-channel.ts`.

When debugging agent-server behavior (event shapes, turn admission, cancel semantics, resume, provisioning), **read the package source — you have full access**:

- `node_modules/@zvada/agent-server/src/` — the package ships readable TypeScript source, not compiled JS. This is the fastest reference and always matches the installed version.
- Local clone at `~/Developer/agent/agent-server` (Conductor-managed; work lives on branches/origin, the main checkout is a stale empty worktree) and https://github.com/zvadaadam/agent-server for history, DESIGN.md, and plans/.
- Engine bugs belong upstream (branch + PR there, then bump the pin here); deus consumes the engine protocol natively (no translate layer) — consumer-side behavior lives in the backend's `services/agent/` fold-and-persist path and the frontend's `agentEventFold` projection.

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
