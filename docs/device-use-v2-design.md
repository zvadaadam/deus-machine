# device-use v2 — design decisions

Living record of the interview-driven design for the device-use refactor. Captures decisions made, reasoning, and open items. **PR 1 of the AAP effort — device-use becomes a standalone product first, AAP comes after.**

---

## Core thesis

device-use today is a stateless CLI + Swift `simbridge` binary + an afterthought MJPEG streamer in `/tmp/`. Post-refactor, device-use becomes **a standalone iOS workbench**: a long-running Bun server hosting a real web viewer, a build+run button, an element inspector, a live agent-activity overlay, and an MCP endpoint for agent control. Works without Deus; Deus (later) embeds its localhost URL as an AAP app.

Design philosophy: **dumb executor, smart caller.** device-use takes explicit project/scheme inputs. The AI agent does discovery (find `.xcodeproj`, list schemes, pick one) via its own file-reading tools. No magic auto-discovery in device-use.

---

## Locked decisions

| #   | Topic                                             | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **PR order**                                      | PR 1 = device-use refactor, standalone. AAP protocol comes after, informed by what this refactor teaches us.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2   | **Product shape**                                 | Standalone product — runs without Deus, has its own viewer accessible at localhost, embeddable by any IDE via iframe. Think "Storybook for iOS sims."                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3   | **Process model**                                 | One Bun process, monolithic. Serves `/` (viewer), `/mcp`, `/ws`, `/health`, `/api/*`. No multi-process architecture.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | **URL convention**                                | Root `/` IS the app. No `/viewer`, no `/app` prefix. Multi-view scenarios solved by multiple ports / instances, not sub-URLs.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 5   | **Tech stack**                                    | **Vite + React + TanStack Router (frontend) + Hono on Bun.serve (backend)**. Originally "TanStack Start + Vite" — refined during Phase 1 scaffolding: TanStack Start runs on Nitro (Node-compat on Bun), but our WebSocket + MJPEG streaming + long-lived subprocess needs are served much better by Bun.serve native. TanStack Router preserves the file-based typed routing the user wanted; Hono gives us a clean middleware model for `/mcp`, `/ws`, `/api/*`, `/health`. Vite handles frontend bundling + HMR. One codebase, two build targets (frontend SPA + server). |
| 6   | **MCP tool surface**                              | All 12 current tools in `agent-server/deus-tools/simulator.ts` (ListDevices, Screenshot, Tap, TypeText, Swipe, PressKey, Build, Launch, ListApps, ReadScreen, WaitFor, GetProjectInfo) + xcodebuild-backed Build tools + existing CLI primitives = ~15-18 MCP tools total.                                                                                                                                                                                                                                                                                                   |
| 7   | **Viewer v1 scope**                               | Phone + device frame (from current simulator UI), sim picker in top bar, one-click ▶ Run button, agent-activity overlay, element inspector sidebar, logs drawer. Cursor animation = v2. Screenshot history = v2.                                                                                                                                                                                                                                                                                                                                                             |
| 8   | **Build/Run flow**                                | One-click ▶ Run button. Chained build→install→launch internally. 3-phase progress shown in the button. Scheme dropdown appears inline only when project has multiple schemes.                                                                                                                                                                                                                                                                                                                                                                                                |
| 9   | **Project discovery**                             | device-use does **not** auto-discover. Agent finds `.xcodeproj`, lists schemes, picks one, calls `build({project, scheme})` with explicit paths. Human UI does a trivial `find cwd -name "*.xcodeproj"` once on first open to offer a default. No deep parsing in device-use.                                                                                                                                                                                                                                                                                                |
| 10  | **Event protocol (WS)**                           | Reuse the MCP tool-call schema — no parallel `ToolEvent` type. Every handler emits `{tool, params, status: "started"\|"completed"\|"failed", result?, error?, id, at}`. Plus optional `tool-log` for build stdout/stderr streaming, correlated by id.                                                                                                                                                                                                                                                                                                                        |
| 11  | **AAP back-channel (deferred)**                   | When AAP lands, device-use → Deus envelopes use MCP Apps naming: `ui/message` (inject into agent context) and `notifications/message` (surface in IDE chrome). Not built in PR 1.                                                                                                                                                                                                                                                                                                                                                                                            |
| 12  | **Storage format**                                | JSON file: `{storage.workspace}/.device-use/state.json`. Contents: pinned UDID, project path, scheme name, updatedAt. No SQLite. Recent tool-events and logs live in-memory only.                                                                                                                                                                                                                                                                                                                                                                                            |
| 13  | **Multi-instance model**                          | One device-use server per workspace. macOS's CoreSimulator is the underlying daemon; simctl is authoritative for sim state. device-use instances are thin because the heavy state is already shared host-level.                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Simulator conflicts**                           | Not a thing. Two instances can point at the same UDID simultaneously — they're both clients of CoreSimulator. Rare user-coordination issue, not framework-level lockout.                                                                                                                                                                                                                                                                                                                                                                                                     |
| 15  | **Architecture — engine/server/CLI relationship** | **Peer model.** Engine is a shared TS library. CLI and Server both import it directly. They are independent consumers — neither knows nor cares about the other. No auto-start, no magic. CLI works standalone (CI, terminals). Server is launched by AAP or explicit `device-use serve`. Known limitation: CLI actions while server is running don't populate the viewer's activity overlay (the physical tap still shows via MJPEG because sim state is host-level). Acceptable.                                                                                           |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  packages/device-use/                                       │
│                                                             │
│   native/          # Swift simbridge (unchanged)            │
│                                                             │
│   src/engine/      # Shared TS library:                     │
│                    #  - simctl wrapper                      │
│                    #  - simbridge IPC                       │
│                    #  - xcodebuild wrapper (NEW)            │
│                    #  - install / launch / logs             │
│        ▲                                                     │
│        │ imported by                                         │
│        │                                                     │
│   ┌────┴──────────────┐     ┌────────────────────────────┐  │
│   │  src/cli/         │     │  src/server/               │  │
│   │  stateless,       │     │  long-lived Bun process    │  │
│   │  per-command      │     │  TanStack Start on Nitro   │  │
│   │  (today's shape)  │     │  routes: /, /mcp, /ws,     │  │
│   │                   │     │          /health, /api/*   │  │
│   └───────────────────┘     └──────────┬─────────────────┘  │
│                                        │                     │
│                                        │ serves              │
│                                        ▼                     │
│                              src/frontend/                   │
│                              TanStack Start React viewer     │
│                              (WS client of server)           │
│                                                             │
│  CLI and Server are independent peers. They share the       │
│  engine but do not talk to each other.                      │
└─────────────────────────────────────────────────────────────┘

DELETED from today's perth-v2:
- src/sdk/              (fluent builder — replaced by HTTP API + MCP)
- src/cli/stream/       (absorbed into src/server/)

KEPT but refactored:
- src/cli/              (commands stay, shared engine grows)
- src/engine/           (expanded — add xcodebuild, install-launch, logs)
- native/               (Swift simbridge unchanged)
```

### Server responsibilities (single source of truth)

- Spawn + own the `simbridge` stream subprocess
- Expose `/mcp` (MCP HTTP transport) — Claude Code + other MCP clients
- Expose `/ws` — bidirectional events (frontend subscribes, CLI commands visible live)
- Serve `/` — the React viewer
- Persist `state.json` — pinned UDID, project, scheme
- Tail `simctl spawn booted log stream` — logs buffer (in-memory ring)
- Expose HTTP API for the CLI and frontend to call

### Event shape (reused MCP schema)

```typescript
type ToolEvent = {
  type: "tool-event";
  id: string;
  at: number;
  tool: string; // "tap", "build", "snapshot", ...
  params: unknown;
  status: "started" | "completed" | "failed";
  result?: unknown;
  error?: string;
};

type ToolLog = {
  type: "tool-log";
  id: string; // correlates to a ToolEvent.id
  stream: "stdout" | "stderr";
  text: string;
};
```

Emitted by: server (one bus). Consumed by: frontend (viewer overlay + logs drawer), any WS subscriber.

---

## MCP tool inventory (draft)

From `agent-server/deus-tools/simulator.ts` + CLI primitives + new build tools. All move into device-use's server.

**Simulator**

- `list_devices` — enumerate available sims
- `boot` — boot a sim by UDID or name

**App lifecycle**

- `build({project, scheme, destination?})` — xcodebuild
- `install({appPath, udid?})` — install built `.app`
- `launch({bundleId, udid?})` — launch installed app
- `terminate({bundleId, udid?})` — kill running app
- `run({project, scheme})` — composite: build → install → launch (agent convenience)

**UI driving**

- `snapshot({udid?})` — a11y tree with `@ref`s
- `tap({ref | x, y})` — single tap
- `swipe({from, to})` — drag
- `type_text({text})` — keyboard input
- `press_key({key})` — hardware key (home, lock, volume)
- `screenshot({format?})` — PNG/JPEG capture
- `wait_for({label | ref, timeoutMs?})` — wait for element to appear
- `query({label?, role?, get: "count"|"attrs"|"bool"})` — discover elements

**Project introspection (helper)**

- `get_project_info({projectPath})` — list schemes, targets, config
- `list_apps({udid?})` — installed apps on a sim

**Permissions + URLs**

- `grant_permission({bundleId, service})` — grant location / photos / etc.
- `open_url({url, udid?})` — deep link

Total: **~18 tools**. Plus `help` (returns inline usage guide, deferred loading pattern).

---

## Remaining small decisions (locked by implementer, 2026-04-17)

| Topic                | Decision                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto-boot pinned sim | **Yes.** On server start, read `state.json`; if UDID pinned and valid, `simctl boot UDID`. If sim was deleted or empty, show picker in viewer.                               |
| MJPEG defaults       | Keep perth-v2 defaults (30fps, native sim resolution). Don't tune in v1.                                                                                                     |
| WS reconnect         | **Start fresh.** No replay buffer. Frontend re-fetches state via `GET /api/state` on reconnect, resumes listening.                                                           |
| Logs drawer          | 10MB in-memory ring buffer. Manual Clear button. No filtering in v1. Source: `simctl spawn booted log stream` scoped to launched app's PID.                                  |
| Inspector            | **V1 = read-only.** Hover element → highlight on phone + properties sidebar (label, role, frame, attributes). Click → copy `@ref` to clipboard. No editing.                  |
| Dev / prod modes     | `bun run dev` = Vite HMR + `tsx watch` for server. `bun run start` = bundled frontend + compiled server. Standard TanStack Start.                                            |
| Test strategy        | Engine: unit tests (extend existing). Server: HTTP API + WS integration tests. Frontend: component tests only, no e2e. Manual smoke: build→install→launch→tap on a demo app. |
| Package name         | Stay `packages/device-use`. No rename.                                                                                                                                       |
| Build output parsing | V1 = capture raw stdout/stderr, stream via `tool-log`, store last 50 lines on failure for tool result. No structured parsing.                                                |
| Physical devices     | V2. Simulators only in v1.                                                                                                                                                   |
| Stream ownership     | Server owns the long-lived `simbridge --stream` subprocess. CLI never streams (it's stateless).                                                                              |

---

## Implementation plan — phased, single-branch

Estimated ~9-13 focused days. Shipped as one large PR on `zvadaadam/agent-app-previews` (already branched).

### Phase 1 — Scaffold the new server + frontend (~1 day)

- Add TanStack Start to `packages/device-use` (new deps, tsconfig adjustments).
- `src/server/` — minimal Nitro server with `/health` route.
- `src/frontend/` — minimal React app served at `/`.
- `bun run dev` / `bun run build` / `bun run start` wire-up.
- **Exit criterion:** `bun run dev` → open `localhost:3100/` → "device-use v2" heading renders; `GET /health` returns 200.

### Phase 2 — Expand the engine (~1-2 days)

- `src/engine/xcodebuild.ts` — `build({project, scheme, destination})`, streams stdout/stderr via callback.
- `src/engine/app-lifecycle.ts` — `install({appPath, udid})`, `launch({bundleId, udid})`, `terminate({bundleId, udid})`, `listApps({udid})`.
- `src/engine/logs.ts` — spawn `simctl spawn booted log stream`, stream to callback.
- `src/engine/project-info.ts` — `getProjectInfo({projectPath})` runs `xcodebuild -list -json`.
- Unit tests for each new primitive (mock child_process).
- **Exit criterion:** `bun test` passes; engine functions usable from Node REPL without a server.

### Phase 3 — Server API + MCP + event bus (~2 days)

- `src/server/routes/api/` — REST endpoints wrapping each engine primitive.
- `src/server/mcp.ts` — MCP HTTP transport at `/mcp`. All 18 tools defined, handlers call engine directly.
- `src/server/ws.ts` — `/ws` endpoint. Broadcasts `tool-event` + `tool-log` from a central emitter. Every engine-calling handler wraps its work in `emit({status: started})` / `emit({status: completed|failed, result|error})`.
- `src/server/state.ts` — JSON file at `{storage.workspace}/.device-use/state.json`. Read on startup (auto-boot pinned sim), write on mutations.
- `src/server/stream.ts` — owns the long-lived `simbridge --stream` subprocess. Serves MJPEG at `/stream.mjpeg`.
- **Exit criterion:** `curl localhost:3100/api/list-devices` works. `curl localhost:3100/mcp` returns MCP tool list. WebSocket at `/ws` streams events when engine is called.

### Phase 4 — Frontend viewer (~3-5 days)

Adapt from current `apps/web/src/features/simulator/ui/` where useful; don't port the whole thing.

- `src/frontend/components/TopBar/` — sim picker + project/scheme display + ▶ Run button with 3-phase progress.
- `src/frontend/components/DeviceFrame/` — phone bezel + MJPEG `<img>` from `/stream.mjpeg`.
- `src/frontend/components/Inspector/` — right sidebar. Click phone → server call to `snapshot`, render a11y tree, hover → highlight on MJPEG overlay, click → copy `@ref`.
- `src/frontend/components/LogsDrawer/` — bottom drawer with live log tail.
- `src/frontend/components/ActivityOverlay/` — consumes `tool-event` stream. Shows ripple animations on tap/swipe coords, toasts for build status.
- `src/frontend/stores/` — Zustand stores: `sim-store`, `project-store`, `activity-store`. One WS client feeds them.
- **Exit criterion:** Open viewer → pick sim → sim boots → pick project → click Run → see build progress → phone launches app → tap element → see ripple on phone. Fully hand-driven.

### Phase 5 — CLI cleanup (~0.5 day)

- Delete `src/sdk/`.
- Delete `src/cli/stream/`.
- Add `device-use serve --port <n>` command that starts the server.
- All other CLI commands unchanged — they already import engine directly.
- **Exit criterion:** `bunx device-use tap @e1` works standalone (no server). `bunx device-use serve` starts the server.

### Phase 6 — Integration, polish, docs (~1-2 days)

- End-to-end scenarios:
  1. Agent-driven: Claude Code hits `/mcp`, drives a demo app.
  2. Human-driven: open viewer, click Run, tap around.
  3. Mixed: agent drives while user watches overlay; user taps directly while sim state syncs.
- Error UX: no project, sim not booted, build failure (with parsed error pointer), port conflict on stream.
- Update `packages/device-use/README.md`.
- Smoke test against a real iOS project.
- **Exit criterion:** Demo'able end-to-end flow, PR ready to open.

---

## Out of scope for this PR (explicitly)

- AAP protocol itself (`agentic-app.json`, registry, lifecycle in Deus backend). Separate PR.
- Deletion of `apps/web/src/features/simulator/` and `apps/backend/src/services/simulator-context.ts`. Separate PR (after AAP lands).
- `apps/agent-server/agents/deus-tools/simulator.ts` removal. Deleted when AAP PR lands and Deus starts using device-use via MCP instead.
- Physical device support.
- Build output structured parsing.
- Cursor animation (v2).
- Multi-sim side-by-side.
- Remote / headless Mac control.

---

## AAP manifest (when AAP lands — not PR 1)

```json
{
  "$schema": "https://agenticapps.dev/schema/v1.json",
  "protocolVersion": "1",
  "id": "deus.mobile-use",
  "name": "Mobile Use",
  "description": "iOS simulator workbench with agent-drivable build, install, launch, and UI control.",
  "version": "0.1.0",
  "launch": {
    "command": "device-use",
    "args": ["serve", "--port", "{port}"],
    "cwd": "{workspace}",
    "env": { "DEUS_STORAGE": "{storage.workspace}" },
    "ready": { "type": "http", "path": "/health", "timeoutMs": 30000 }
  },
  "ui": { "url": "http://localhost:{port}/" },
  "agent": { "tools": { "type": "mcp-http", "url": "http://localhost:{port}/mcp" } },
  "storage": { "workspace": "{workspace}/.device-use" },
  "lifecycle": { "scope": "workspace", "stopSignal": "SIGTERM", "stopTimeoutMs": 5000 },
  "requires": [
    { "type": "cli", "name": "xcrun", "install": "Install Xcode from the App Store" },
    { "type": "platform", "os": "darwin" }
  ]
}
```

---

## Handoff to next PR — AAP host integration in Deus

device-use is now a complete AAP-shaped app. The next PR is the **Deus side**: the IDE learns to consume `agentic-app.json`, spawn AAP apps, register their MCP servers with Claude Agent SDK, and embed their viewers. This section is a brief for that work.

### What to build in Deus

| Surface               | Where                                               | Notes                                                                                                                                                                                                              |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **App registry**      | `apps/backend/src/services/apps.service.ts` (new)   | Reads `agentic-app.json` from a config path or workspace `deus-apps/`. v1: hardcode `packages/device-use` as the only entry.                                                                                       |
| **App spawner**       | same service                                        | `spawn(launch.command, launch.args)` with template substitution (`{port}`, `{workspace}`, `{storage.workspace}`). Allocate free port via `Bun.serve(0)` then close. Probe `launch.ready` (`http`/`tcp`) until 2xx. |
| **State persistence** | `running_apps` table in `shared/schema.ts`          | `id, app_id, workspace_id, pid, port, url, status, started_at, exit_code, stderr_tail`. Boot-time orphan sweep via `kill -0 pid`.                                                                                  |
| **MCP registration**  | `apps/agent-server/src/app-registrar.ts` (new)      | On `launch_app` success, call SDK's `setMcpServers({ deus_mobile_use: { type: "http", url } })`. On `stop_app`, omit. SDK handles connect/disconnect.                                                              |
| **Lifecycle tools**   | `apps/agent-server/agents/deus-tools/apps.ts` (new) | 4 tools: `list_apps`, `launch_app`, `stop_app`, `app_status`. Each does one RPC to backend.                                                                                                                        |
| **WS resources**      | `shared/events.ts`                                  | Add `apps`, `running_apps` to `QUERY_RESOURCES`. Frontend subscribes via `useQuerySubscription`.                                                                                                                   |
| **Frontend launcher** | `apps/web/src/features/apps/` (new)                 | Sidebar nav entry "Apps" + content-tab launcher with one card per installed app. Status chip (idle/starting/running/crashed) + Open/Launch/Retry button.                                                           |
| **App tab**           | piggyback on `apps/web/src/features/browser/`       | When a launched app emits `status: ready`, open a Browser tab pointing at its `url`. AAP viewer renders inside via `BrowserView` (desktop) or iframe (web).                                                        |

### What to delete (after AAP works)

Net ~2,500 LOC of dead code once Deus consumes device-use via AAP:

- `apps/web/src/features/simulator/` — ~1,664 LOC (replaced by AAP-launched device-use viewer in a Browser tab)
- `apps/backend/src/services/simulator-context.ts` — 793 LOC (replaced by `apps.service.ts`)
- `apps/agent-server/agents/deus-tools/simulator.ts` + `sim-ops.ts` — the 12 simulator tools (now served by device-use's own MCP endpoint)

Suggested order: ship AAP behind a feature flag → soak 1-2 weeks → delete simulator code in a follow-up PR.

### Things device-use learned that should shape the AAP protocol

Real lessons from building the reference impl, worth respecting in the host:

1. **Manifests need `requires` validation before spawn.** xcrun-missing or wrong-OS errors should surface as actionable messages, not cryptic exit codes. We declared `requires: [{type: "cli", name: "xcrun"}, {type: "platform", os: "darwin"}]` in our manifest — Deus should check these before running `launch.command`.

2. **`{port}` substitution is essential.** Apps must accept the host-allocated port — never hard-code 3100. Our launch args do `["serve", "--port", "{port}"]`.

3. **Health probe is non-optional.** Even fast-starting Bun servers take 200-500ms to bind. Without `launch.ready.http`, the host races against the process and connections fail randomly. Our probe path `/health` returns `{ok:true}` instantly once the server is ready.

4. **`{storage.workspace}` env var works.** We pass `DEUS_STORAGE` and the app writes `state.json` there. Survives restarts cleanly. Host should `mkdir -p` the storage dir before spawn.

5. **Process lifetime = `child.on("exit")`, no polling.** Our server exits cleanly on SIGTERM. The host's watchdog should be the native exit event, not a heartbeat. Hung-but-not-exited processes are a user-explicit-stop concern, not framework concern.

6. **Iframe needs an extra-low-latency back-channel for input.** Our `/sim-input` WS proxy passing binary frames bypasses HTTP entirely so taps feel instant. Generic AAP apps may want similar — perhaps the manifest should declare `additionalChannels: [{path: "/sim-input", proto: "ws-binary"}]` that the host transparently proxies. Defer until a second app actually needs it.

7. **External MCP server registration must use `setMcpServers` at runtime.** Verified — SDK's `Query.setMcpServers()` works for dynamic add/remove during a session. No need to restart the session when launching/stopping apps.

8. **The frontend should be free to use any framework.** device-use uses Vite + React + Zustand — none of which Deus cares about. The host only sees `ui.url`. No framework constraint imposed.

### Things deferred from device-use (not blockers)

For Deus AAP host to be aware of, but not handle directly:

- **Wheel→scroll mapping**: device-use UI doesn't intercept wheel. Could be a host-level affordance (intercept wheel in BrowserView, forward to app's `/sim-input` WS as `move` events).
- **CLI-action visibility in `/ws`**: documented; will likely add `--via-server` opt-in flag in a v1.1 of device-use.
- **Multi-sim side-by-side**: not supported — needs a host-level "open two AAP iframes" model, not an app-level one. Defer to AAP v2.

### Open questions to answer before merging the Deus AAP PR

These need a design pass during that PR — not pre-decidable now:

- **Where in the Deus UI does the launcher live?** Sidebar entry vs. content tab vs. command palette. Design doc has a sketch ("Apps" sidebar entry → launcher tab in Browser).
- **What's the per-workspace lifetime?** App stays running across session reloads? Dies on workspace close? Both? (`lifecycle.scope: workspace` already implies workspace-bounded but Deus needs to enforce.)
- **Activity feed from app → Deus chat?** Use `ui/message` envelope (we drafted but didn't implement). When build fails inside device-use, should the failure summary auto-inject into the agent's conversation context?

### Concrete first commit for the Deus PR

Smallest meaningful slice that proves the host machinery works:

1. `shared/schema.ts` — add `running_apps` table
2. `apps/backend/src/services/apps.service.ts` — minimal: read one hardcoded manifest, spawn, probe `/health`, persist row
3. `apps/agent-server/agents/deus-tools/apps.ts` — `list_apps` + `launch_app` only (no stop yet)
4. Smoke test: `device-use` launches via the new path; `/api/state` reachable from Deus's tools

If that ships green, the rest (frontend launcher, lifecycle scope, deletion of legacy simulator code) is mechanical.

---

## Interview rounds (log)

- **R1** Goal framing → user prefers end-to-end big PR with device-use as reference implementation.
- **R2** Agent MCP surface → everything incl. xcodebuild.
- **R3** Product shape → standalone (B).
- **R4** Process model → one Bun process (A).
- **R5** Viewer scope → phone + picker + Run + activity, inspector/logs soft-include.
- **R6** Build flow → one-click ▶ Run (A).
- **R6b** Project/scheme discovery → device-use dumb, agent smart.
- **R7** Event protocol → simplified: reuse MCP tool-call schema, add `tool-log` for streaming.
- **R8** (implicit) Lock event protocol.
- **R9** Storage → JSON file per workspace.
- **R10** MCP Apps reuse → borrow message envelope names, not iframe-content pattern. Multi-instance: one per workspace, macOS is the daemon.
- **R11** Perth-v2 fate → hard refactor in place; keep CLI as first-class.
- **R12** Engine/server/CLI → inversion proposed; pending confirm.
