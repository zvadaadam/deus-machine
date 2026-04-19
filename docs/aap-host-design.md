# AAP host integration — design decisions

Living record of how Deus becomes the first host for AAP v1. Captures decisions
from the design interview with reasoning and open items. Companion to
`docs/aap-v1-design.html` (protocol spec) and `docs/device-use-v2-design.md`
(first AAP-shaped app).

---

## Core thesis

`packages/device-use` is now AAP-shaped. This work makes Deus the host: a
registry of installed agentic apps, a backend spawner/probe/watchdog, a bridge
that registers each running app's MCP server with the Claude Agent SDK
mid-session, and a launcher mounted as a tab inside the existing Browser
feature. New apps add one `agentic-app.json` + one registry line; nothing else
changes.

Design philosophy: **keep the host boring, keep the code cohesive in one
directory per process, don't block v2**.

---

## Locked decisions

| #   | Topic                   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **MCP registration**    | Register via `Query.setMcpServers` on launch, unregister on stop. Verified against `@anthropic-ai/claude-agent-sdk@0.2.63` (`sdk.d.ts:1373`). Dynamic ports make upfront registration impossible without port-pinning.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | **Port allocation**     | Dynamic. Bind `0.0.0.0:0`, capture, release, pass via `{port}`. Retry once on EADDRINUSE.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | **Dedupe**              | One instance per `(app_id, workspace_id)`. Multiple workspaces can each run the same app. Enforced as a service-level policy check, **not** a DB constraint — keeps the door open for multi-instance in v2.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | **Runtime state store** | In-memory `Map<runningAppId, RunningAppEntry>` inside `apps.service`. **Not** SQLite. Rationale: runtime state is transient (an OS process + port); SQLite creates a stale-data window (crashed-backend leaves "ready" rows on disk that misrepresent OS reality), buys no benefit (one writer, no durability desired, no cross-process coordination). Terminal states (stopped, crashed) are not kept — absence means "not running." Post-mortem surface is a structured stdout/Sentry log, not a DB row. Cross-restart orphan cleanup uses a flat PID journal file (append on spawn, sweep+clear on boot) — one purpose, not a state store. |
| 4b  | **Restart resilience**  | Graceful (SIGTERM/SIGINT): `stopAllApps()` in `server.ts` shutdown handler SIGTERMs every child. Ungraceful (SIGKILL/OOM): `sweepOrphanApps()` on next boot reads `{userDataDir}/aap-pids.txt`, SIGKILLs any PIDs still alive, clears the file. Also called from `uncaughtException` handler.                                                                                                                                                                                                                                                                                                                                                 |
| 5   | **Tab on launch**       | Backend emits a one-shot `apps:launched` `q:event` on any successful launch (agent or user). Frontend reacts by opening a Browser tab at the app's URL. Backend stays ignorant of tabs.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | **Lifecycle tools**     | Live in the existing `deus` MCP server via `apps/agent-server/agents/deus-tools/apps.ts`. Same pattern as `simulator.ts`, `browser.ts`, `workspace.ts`. No new server process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 7   | **Launcher UI**         | One React component mounted as a tab inside the existing Browser feature. No sidebar entry, no `deus://` scheme, no new tab registry in v1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8   | **Registry**            | Hardcoded TS module (`apps/backend/src/config/installed-apps.ts`) pointing at `packages/device-use/agentic-app.json`. Workspace-local manifest scanning is v2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 9   | **Skills**              | Not Deus's problem. App's MCP server exposes a `help` tool; agent calls it on demand. Manifest `bootstrap` one-liner is returned from `launch_app`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | **Storage**             | Deus guarantees `storage.workspace` and `storage.global` dirs exist before spawn. If `storage.workspace` resolves to a path inside the workspace, Deus auto-appends that path (relative, as declared by the manifest) to the workspace `.gitignore` — idempotent. No hardcoded `.deus/` assumption: apps pick their own dir (`.device-use/`, `.deus/apps/{id}/`, etc.) and whatever they pick gets ignored.                                                                                                                                                                                                                                   |

---

## Architecture

```
Backend (owns state)                  Agent-server (stateless)           Frontend
─────────────────────                 ─────────────────────              ────────
services/aap/
  apps.service      ← public API
  registry
  lifecycle         ─spawn─→ app process → http://localhost:{port}/mcp
  port-allocator                                        ▲
  storage                                               │ setMcpServers
  mcp-bridge        ──RPC──→ app-registrar ─────────────┘
                                  │
                                  ▼
                   Query.setMcpServers({ deus_mobile_use: { type:"http", url } })

  query-engine      ──WS──→ "apps" / "running_apps" resources ──→ useQuerySubscription
  index (boot)      ──────→ orphan sweep + workspace-close hook

  deus-tools/apps.ts  (list_apps, launch_app, stop_app) — registered into existing deus MCP server

  q:event("apps:launched", { appId, url }) ──WS──→ features/apps → openTab(url)
```

Three clear boundaries:

- **Backend** owns all state (DB, child-process refs, ports, storage dirs).
- **Agent-server** is stateless for AAP — it does what the bridge tells it.
- **Frontend** is passive — subscribes and reacts.

---

## File layout

```
shared/aap/
├── manifest.ts            # Zod schema, Manifest type, idToServerName
└── template.ts            # {port}/{workspace}/{storage.workspace}/{userData}/{sessionId}

shared/events.ts           # + "apps" / "running_apps" resources; + "apps:launched" event
# (no schema.ts change — running_apps lives in a module Map, not SQLite)

apps/backend/src/services/aap/
├── apps.service.ts        # PUBLIC: listApps, launchApp, stopApp, getRunningApps
├── registry.ts            # loadInstalledApps() — hardcoded paths in v1
├── lifecycle.ts           # spawn + ready probe (http|tcp) + child.on("exit") watchdog + SIGTERM → SIGKILL
├── port-allocator.ts      # allocateFreePort with single retry
├── storage.ts             # ensureStorageDirs + .gitignore injection
├── mcp-bridge.ts          # the ONLY backend → agent-server call (RPC → setMcpServers)
└── index.ts               # barrel: exports apps.service only

apps/backend/src/config/
└── installed-apps.ts      # hardcoded [packages/device-use/agentic-app.json]

apps/backend/src/index.ts                         # + boot orphan sweep
apps/backend/src/services/workspace.service.ts    # + kill workspace apps on close
apps/backend/src/services/query-engine.ts         # + handlers for "apps", "running_apps"

apps/agent-server/src/
└── app-registrar.ts       # holds Query ref per session; handles register/unregister RPCs

apps/agent-server/agents/deus-tools/
├── apps.ts                # list_apps, launch_app, stop_app (thin RPC wrappers)
└── index.ts               # + register the 3 tools

apps/agent-server/rpc-schemas.ts                  # + LaunchAppRequest/Response, StopAppRequest/Response, RegisterAppMcp…

apps/web/src/features/apps/
├── ui/
│   ├── AppsLauncher.tsx   # grid of AppCards; mounted as a Browser tab
│   ├── AppCard.tsx        # icon + name + description + status chip + Launch/Open/Retry
│   └── AppStatusChip.tsx
├── hooks/
│   ├── useInstalledApps.ts       # q:subscribe("apps")
│   ├── useRunningApps.ts         # q:subscribe("running_apps")
│   └── useAppsLaunched.ts        # q:event listener → openTab on receive
├── store/appsStore.ts
└── index.ts
```

---

## Structural rules

1. **`apps.service.ts` is the only public entry**. Everything in `services/aap/`
   is internal. Routes, WS query-engine, and tests import only the service.
   Lets us refactor internals without touching callers.
2. **`mcp-bridge.ts` is the only backend → agent-server coupling for AAP**.
   When a row transitions to `ready`, the bridge fires an RPC; the registrar
   calls `query.setMcpServers`. One choke point to trace, one thing to mock.
3. **Agent-server stays stateless for AAP**. No `running_apps` tracking there.
   It does what the bridge tells it.
4. **Registry is a TS module, not JSON or scanner, in v1**. Swap to
   `{workspace}/.deus/apps/*.json` scanner later is a one-file change.
5. **No sidebar entry, no `deus://` URLs, no custom tab registry in v1**.
   Launcher mounts inside the existing Browser multi-tab system.
6. **Tab-open on launch is frontend-driven**. Backend emits `apps:launched`;
   frontend decides the tab. Backend stays ignorant of tabs.

---

## Phased implementation

### Phase 1 — Shared code (pure, no runtime)

- `shared/aap/manifest.ts` + `template.ts` + tests
- `shared/schema.ts` — `running_apps` table + indexes
- `shared/events.ts` — `apps`, `running_apps` resources; `apps:launched` event

**Exit criterion**: `bun run test:backend` green; existing app still boots.

### Phase 2 — Backend foundation (no agent bridge, no UI)

- `apps/backend/src/services/aap/` — all files
- `apps/backend/src/config/installed-apps.ts`
- `apps/backend/src/services/query-engine.ts` — new resource handlers
- `apps/backend/src/index.ts` — orphan sweep on boot
- `apps/backend/src/services/workspace.service.ts` — kill on workspace close

**Exit criterion**: Backend can list device-use in the `apps` resource. An
internal test route spawns device-use, `running_apps` goes `starting → ready`,
URL is reachable. Stop kills process, row goes `stopped`. Backend restart
kills orphans.

### Phase 3 — Agent bridge + lifecycle tools

- `apps/agent-server/rpc-schemas.ts` — 5 new RPC schemas
- `apps/agent-server/src/app-registrar.ts` — Query-ref holder, setMcpServers
- `apps/agent-server/agents/deus-tools/apps.ts` — 3 tools
- `apps/agent-server/agents/deus-tools/index.ts` — register
- `apps/backend/src/services/aap/mcp-bridge.ts` — wire to state transitions
- Hook registrar into claude-handler session lifecycle

**Exit criterion**: Agent calls `launch_app("deus.mobile-use")` → backend
spawns → bridge fires RPC → registrar calls `query.setMcpServers` → agent sees
`mcp__deus_mobile_use__*` tools and can tap the sim. `stop_app` removes them.

### Phase 4 — Frontend launcher + auto-open

- `apps/web/src/features/apps/` — full feature
- Mount launcher inside Browser's tab system (research exact mechanism in
  `BrowserTab.tsx` / `BrowserTabBar.tsx` during implementation)
- `useAppsLaunched` hook reacts to `q:event` → opens Browser tab

**Exit criterion**: Open Browser → Apps tab shows Mobile Use card (IDLE) → click
Launch → chip goes STARTING → RUNNING → new Browser tab opens with the viewer
→ agent can drive it. Agent-initiated launch also auto-opens the tab.

### Phase 5 — Simulator deletion (later PR)

Deferred until Phase 4 soaks for 1+ week. Removes `features/simulator/`,
`simulator-context.ts`, `deus-tools/simulator.ts`, `sim-ops.ts`. Net ~2,500
LOC negative.

---

## Out of scope for this work

- Multi-instance (two copies of same app per workspace) — schema supports it,
  service policy blocks it. Flip later.
- Workspace-local manifest scanning.
- `requires` validation beyond `cli` + `platform` (device-use only needs these).
- `commands` field → palette dual-surface.
- `events` back-channel (app → Deus WS push).
- Capability enforcement — documentary in v1.
- Sidebar "Apps" entry — add later without touching the rest.
- `deus app install` CLI.
- Stdio / CLI tool transports — HTTP only in v1.

---

## Open questions (locked at implementation time, not blocking)

| Topic                                                | Tentative                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where does the launcher tab appear in Browser?       | Pin as first tab on open, or available via `+`. Resolve while reading `BrowserTabBar.tsx`.                                                             |
| How does agent-server get the Query ref per session? | Registrar subscribes to session-store create/end events; keeps `Map<sessionId, Query>`. Alternative: pass through claude-handler. Pick during Phase 3. |
| Error surface on launch failure                      | `launch_app` returns structured error with failing `requires` reason; frontend card goes CRASHED; `stderr_tail` on hover.                              |
