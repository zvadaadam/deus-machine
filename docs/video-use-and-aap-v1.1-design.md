# video-use + AAP v1.1 — design notes

Working doc capturing (a) the investigation of [`heygen-com/hyperframes`](https://github.com/heygen-com/hyperframes) as a candidate second AAP app after `device-use`, and (b) the AAP v1 protocol revisions that investigation surfaced. Companion to `aap-v1-design.html` and `device-use-v2-design.md`. Intended to inform the next PR (or two).

**Status:** design draft — not implemented yet.
**Date:** 2026-04-18.
**Branch context:** sits after `zvadaadam/agent-app-previews` (device-use v2 PR).

---

## 0. TL;DR

1. **`hyperframes` is an unusually good second AAP app.** Apache 2.0, ~30k LOC, monorepo, already has a Hono server with HTTP API + SSE progress + a 12k-LOC React NLE editor. We **wrap, not fork** — `packages/video-use` becomes the AAP-compatible shell that hosts hyperframes.
2. **Reading hyperframes also exposed real holes in AAP v1.** Eight proposed revisions below. Top 3 to ship before the protocol meets external apps: **streaming async tool handles**, **localhost auth token**, **`agent.skills` + `@aap/sdk`**.
3. **Recommended PR sequence:**
   - PR 1 (in flight): device-use v2 standalone.
   - PR 2: AAP v1 backend wiring in Deus + `device-use` registered as the first AAP app.
   - PR 3: AAP v1.1 spec revisions (this doc) + `@aap/sdk` package.
   - PR 4: `packages/video-use` wrapping hyperframes as the second AAP app.

---

## 1. Hyperframes investigation summary

Cloned to `.context/hyperframes/` (gitignored). Confirmed below from source, not just README.

### 1.1 What it actually is

Not "just an SDK." A complete monorepo:

| Package                           | What it is                                                                       | Notes                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@hyperframes/cli`                | `hyperframes` binary, 24 commands                                                | `init`, `preview`, `render`, `lint`, `validate`, `transcribe`, `tts`, `doctor`, `play`, `snapshot`, `upgrade`, … |
| `@hyperframes/core`               | Parsers, lint, runtime, compiler **+ `studio-api` Hono sub-app**                 | ~19k LOC. Adapter pattern.                                                                                       |
| `@hyperframes/studio`             | React NLE editor — timeline, CodeMirror, file tree, property panel, live preview | ~12k LOC, Vite + React 18/19 + Zustand + Tailwind                                                                |
| `@hyperframes/engine`             | Puppeteer + FFmpeg seekable page-to-video                                        | —                                                                                                                |
| `@hyperframes/producer`           | Chrome BeginFrame rendering pipeline                                             | —                                                                                                                |
| `@hyperframes/player`             | Embeddable `<hyperframes-player>` web component                                  | —                                                                                                                |
| `@hyperframes/shader-transitions` | WebGL shader transitions                                                         | optional                                                                                                         |

Stack: bun workspaces, Hono, Vite, React, oxlint/oxfmt, lefthook, Apache 2.0.

### 1.2 The serving model — already AAP-shaped

`packages/cli/src/server/studioServer.ts` is a long-running Hono server that:

- Serves the built studio SPA at `/`
- Mounts `createStudioApi()` at `/api/*` (the same Hono sub-app used by the Vite dev server — adapter pattern)
- Owns a singleton Puppeteer browser for thumbnails
- Streams render progress over **SSE** via `streamSSE` from `hono/streaming`
- Watches project files → broadcasts HMR-style change events
- Has a port registry: `--list`, `--kill-all`, `--force-new`, defaults to port 3002

This is structurally identical to what `device-use` v2 will become.

### 1.3 The HTTP API surface (what we'd wrap as MCP)

Discovered in `packages/core/src/studio-api/routes/`:

```
GET    /api/projects                                — list projects
GET    /api/projects/:id                            — project metadata
GET    /api/resolve-session/:sessionId              — session → project mapping

GET    /api/projects/:id/files/*                    — read file
PUT    /api/projects/:id/files/*                    — write file
POST   /api/projects/:id/files/*                    — create file
DELETE /api/projects/:id/files/*                    — delete file
PATCH  /api/projects/:id/files/*                    — patch file
POST   /api/projects/:id/duplicate-file             — duplicate

GET    /api/projects/:id/preview                    — preview HTML
GET    /api/projects/:id/preview/comp/*             — sub-composition preview
GET    /api/projects/:id/preview/*                  — preview asset

GET    /api/projects/:id/lint                       — lint composition

POST   /api/projects/:id/render                     — start render → returns jobId
GET    /api/render/:jobId/progress                  — SSE: progress, stage, error
GET    /api/render/:jobId/view                      — preview rendered output
GET    /api/render/:jobId/download                  — download MP4
DELETE /api/render/:jobId                           — cancel
GET    /api/projects/:id/renders                    — list renders
GET    /api/projects/:id/renders/file/*             — download specific render
```

### 1.4 Today's "agent integration" model

- **No MCP.** Confirmed: zero `MCP` / `modelcontextprotocol` matches anywhere in the repo.
- Compositions are HTML with `data-*` attributes → Claude can read/write them with file tools.
- Ships **Vercel skills** (`skills/hyperframes`, `skills/hyperframes-cli`, `skills/gsap`, `skills/website-to-hyperframes`, `skills/hyperframes-registry`) — register as slash commands in Claude Code / Cursor via `vercel-labs/skills`.

### 1.5 License

Apache 2.0. Free to vendor, wrap, redistribute. Attribution required.

---

## 2. AAP v1.1 — proposed protocol revisions

Eight revisions surfaced by reading hyperframes. Listed by leverage. Each has: **what we saw**, **what AAP v1 is missing**, **proposed change**.

### 2.1 (★ top priority) Streaming async tool handles

**What we saw.** `POST /render` returns `{ jobId }`. Progress streams via `GET /render/:jobId/progress` (SSE). Same shape would apply to: video render, build, image gen, transcription, simulation, training run, deploy.

**AAP v1 gap.** `tool-log` exists in `device-use-v2-design.md:92-111` but isn't a first-class pattern. There's no convention for "tool returns a handle, progress streams against the handle." Every app will reinvent this.

**Proposed change.** Bless this pattern in the spec.

```ts
// A tool whose result includes `_handle` (reserved key) is implicitly async.
// Host opens a stream under tool-log with correlationId = _handle until
// a terminal tool-event (status: "completed" | "failed") arrives carrying the same _handle.

type AsyncToolResult<T> = T & {
  _handle: string; // opaque, app-defined
  _terminal?: boolean; // omit or false during progress; true on done
};
```

Update event envelopes:

```ts
type ToolLog = {
  type: "tool-log";
  id: string; // correlationId — equals _handle
  stream: "stdout" | "stderr" | "progress";
  text?: string;
  data?: { progress?: number; stage?: string; [k: string]: unknown };
};
```

Implication: the device-use `build` tool we already designed becomes the canonical example.

### 2.2 (★ top priority) Localhost auth token

**What we saw.** Hyperframes's localhost server has **no auth**. Any process on the machine can hit `/api/projects/:id/files/*` and overwrite files. This is fine when only the user runs it; it's a hole the moment AAP becomes a thing third-party apps target.

**AAP v1 gap.** No auth contract.

**Proposed change.** Deus generates a per-launch random token and injects it.

```
env (always injected):
  DEUS_APP_ID         existing
  DEUS_WORKSPACE_ID   existing
  DEUS_SESSION_ID     existing
  DEUS_PORT           existing
  DEUS_APP_TOKEN      NEW — 32-byte random hex
```

Apps **must** require `Authorization: Bearer ${DEUS_APP_TOKEN}` on `/mcp` and `/api/*`. UI tab loads with `?token=…` (also acceptable as cookie).

Ship as middleware in `@aap/sdk` so apps get it for free.

### 2.3 (★ top priority) `agent.skills` field — beyond bootstrap

**What we saw.** Hyperframes ships **real skill markdown files** through `vercel-labs/skills`. They're richer than a one-liner: they teach patterns, conventions, pitfalls, and link to examples.

**AAP v1 gap.** `agent.bootstrap` is a single string; full skill lives behind a `help` tool call. Fine for terse apps, terrible for the ComfyUI-style flagship where the agent genuinely needs domain knowledge.

**Proposed change.** Add `agent.skills` to the manifest:

```json
"agent": {
  "tools": { "type": "mcp-http", "url": "http://localhost:{port}/mcp" },
  "bootstrap": "Call help for usage. Always lint before render.",
  "skills": [
    { "name": "video-use", "path": "./skills/video-use.md" },
    { "name": "video-use-render", "path": "./skills/render-pipeline.md" }
  ]
}
```

Host loads these into the system prompt while the app is running. Compatible with the existing Vercel/Anthropic skill format. Apps that already ship Vercel skills become AAP apps with one extra field.

### 2.4 Files-as-state — bless the pattern

**What we saw.** Hyperframes's source of truth is `data/projects/<id>/index.html`. Agent can edit via MCP **or** by writing the file directly; a file-watcher → WS broadcast pushes updates into the UI.

**AAP v1 gap.** Spec is neutral on storage format. Doesn't acknowledge that "files in workspace + watcher → UI update" is the highest-leverage pattern for agent-editable apps (agent has two paths in: structured MCP tools AND raw file writes).

**Proposed change.** Add a section in the AAP v1 design doc: _Recipe — files as state._

- Store source of truth under `{storage.workspace}` as readable files.
- Run a file-watcher in the app process; broadcast changes over the WS event channel.
- Expose CRUD via MCP for atomic edits, but don't gatekeep — file writes from outside the MCP are valid input.
- Document the trade-offs: agent gets natural editing, but you lose transactional guarantees.

### 2.5 Multi-document lifecycle

**What we saw.** Hyperframes's `studio` lists many projects (`/api/projects`) — navigation happens _inside_ the app. One server, N documents.

**AAP v1 gap.** Lifecycle is one-app-one-thing (`scope: workspace`, `dedupe: by-workspace`). No concept of "the app has N documents inside it; which one is the agent looking at?"

**Proposed change.** Add an optional `agent.contextShape` to the manifest + a convention for active context.

```json
"agent": {
  "contextShape": "document-list",  // "single" | "document-list" | "none"
  "activeContextEndpoint": "/api/active-context"
}
```

When `document-list`, host injects the currently-focused document ID into every tool call as `_context.documentId`. App's `/api/active-context` is a small read endpoint the host polls when the user navigates inside the app's UI (or app pushes via the events channel).

Defer the wire-format detail to v1.2 if needed; reserve the keyword now.

### 2.6 Runtime health, not just initial ready

**What we saw.** Hyperframes has a `doctor` command that probes Chrome + FFmpeg; runtime falls back via `PRODUCER_HEADLESS_SHELL_PATH` env probing.

**AAP v1 gap.** `ready.type` is one-shot at startup. But Chrome crashes. Simulators unboot. FFmpeg gets killed. App is "alive" but "degraded" — host has no signal.

**Proposed change.** Promote `ready` to `health`:

```json
"health": {
  "initial": { "type": "http", "path": "/health", "timeoutMs": 30000 },
  "heartbeatMs": 5000,
  "endpoint": "/health"
}
```

Health response shape:

```ts
type Health = {
  status: "ready" | "degraded" | "unhealthy";
  reasons?: string[]; // human-readable, shown in app sidebar
  resources?: Record<string, "ok" | "missing" | "stale">;
};
```

Host shows green / yellow / red dot accordingly. `unhealthy` for >N polls = host considers app dead and offers restart.

### 2.7 Adapter pattern + `@aap/sdk` helper package

**What we saw.** `StudioApiAdapter` lets the **same Hono sub-app** run under Vite (dev) and under CLI-embedded Hono (prod). The "app's HTTP surface" is independent of "who hosts it."

**AAP v1 gap.** Nothing in v1 prevents this, but there's also no scaffolding. Every app author re-derives auth, MCP transport wiring, health endpoint, file-safe-path utilities, mime type lookup, SSE bridge.

**Proposed change.** Ship `@aap/sdk` (under `packages/aap-sdk`).

```ts
import { createAgenticApp } from "@aap/sdk";

const aap = createAgenticApp({
  manifest,
  tools: {
    render: defineTool({
      input: z.object({ projectId: z.string(), fps: z.number() }),
      handler: async (input, ctx) => {
        const job = await producer.start(input);
        // ctx.emit gets correlated to _handle automatically
        producer.on("progress", (p) => ctx.emit({ progress: p }));
        return { _handle: job.id };
      },
    }),
    // ...
  },
  health: () => ({ status: "ready" }),
  token: process.env.DEUS_APP_TOKEN,
});

// Mount however the host wants:
app.route("/", aap); // standalone Hono / Bun.serve
// OR inside Vite middleware
// OR inside Express via Hono adapter
```

The SDK ships:

- MCP-HTTP transport bridge over Hono
- Auth middleware (Bearer token)
- Async-handle helper (`ctx.emit` ↔ `tool-log` correlation)
- Safe-path / mime / file-watcher utilities (lifted from `core/studio-api/helpers/`)
- Health endpoint scaffolding
- WS event channel with reconnect
- TypeScript-first tool definition with Zod

This is what makes "wrap an existing web app as an AAP app" feasible in a weekend.

### 2.8 Dev/prod loop for AAP authors

**What we saw.** Hyperframes splits `bun run studio` (Vite HMR against mock adapter) from `hyperframes preview` (bundled studio served by CLI). Clean dev/prod separation.

**AAP v1 gap.** Nothing on how an app author iterates locally. If Deus spawns apps via `launch.command`, how do authors get HMR? Reload the whole AAP app process per code change?

**Proposed change.** Add `launch.dev` (alternate command) + a `deus apps dev` workflow.

```json
"launch": {
  "command": "video-use",
  "args": ["serve", "--port", "{port}"],
  "dev": {
    "command": "video-use",
    "args": ["serve", "--port", "{port}", "--dev"]
  }
}
```

Deus picks `dev` when launched from a workspace where the app's source lives. App is responsible for HMR / watcher itself.

### 2.9 Bonus — SSE alongside WS for events

**What we saw.** Hyperframes uses SSE for render progress.

**AAP v1.** Spec says events are WS (`ws://localhost:{port}/deus-events`).

**Suggestion.** Accept either. SSE is simpler (one-way, HTTP, no upgrade handshake, survives proxies, zero deps). Manifest declares which:

```json
"events": { "channel": "sse", "url": "http://localhost:{port}/deus-events" }
"events": { "channel": "ws",  "url": "ws://localhost:{port}/deus-events" }
```

Host SDK normalizes both into the same internal stream.

---

## 3. `packages/video-use` — implementation plan

Scope: thin wrapper around hyperframes that makes it AAP-compatible. **No fork.** Hyperframes packages stay external deps.

### 3.1 Package shape

```
packages/video-use/
  package.json
    deps:
      @hyperframes/cli            # for commands like lint, render, doctor
      @hyperframes/core           # studio-api factory
      @hyperframes/studio         # SPA assets
      @hyperframes/producer       # render pipeline
      @aap/sdk                    # NEW (PR 3)
      hono
      zod
  agentic-app.json                # AAP manifest
  src/
    cli.ts                        # `video-use serve --port N`
    server/
      index.ts                    # boots the long-running server
      mcp.ts                      # MCP tool definitions wrapping studio-api
      events.ts                   # bridges hyperframes SSE → AAP tool-log
      health.ts                   # health endpoint
      auth.ts                     # bearer token middleware
    skills/
      video-use.md                # main skill
      video-use-compositions.md   # composition authoring
      video-use-render.md         # render pipeline + troubleshooting
  README.md
  LICENSE-NOTICE                  # Apache 2.0 attribution for hyperframes
```

### 3.2 The MCP tool list

Wrap hyperframes's existing HTTP API:

| Tool              | Wraps                                        | Async?             |
| ----------------- | -------------------------------------------- | ------------------ |
| `list_projects`   | `GET /api/projects`                          | sync               |
| `get_project`     | `GET /api/projects/:id`                      | sync               |
| `list_files`      | walks project dir                            | sync               |
| `read_file`       | `GET /api/projects/:id/files/*`              | sync               |
| `write_file`      | `PUT /api/projects/:id/files/*`              | sync               |
| `create_file`     | `POST /api/projects/:id/files/*`             | sync               |
| `delete_file`     | `DELETE /api/projects/:id/files/*`           | sync               |
| `duplicate_file`  | `POST /api/projects/:id/duplicate-file`      | sync               |
| `lint`            | `GET /api/projects/:id/lint`                 | sync               |
| `render`          | `POST /api/projects/:id/render` + SSE bridge | **async (handle)** |
| `cancel_render`   | `DELETE /api/render/:jobId`                  | sync               |
| `list_renders`    | `GET /api/projects/:id/renders`              | sync               |
| `download_render` | `GET /api/render/:jobId/download`            | sync               |
| `transcribe`      | shells `hyperframes transcribe`              | **async (handle)** |
| `tts`             | shells `hyperframes tts`                     | **async (handle)** |
| `doctor`          | shells `hyperframes doctor`                  | sync               |
| `help`            | returns embedded skill text                  | sync               |

Total: **~17 tools.** Mirrors device-use's ~18.

### 3.3 The manifest

```json
{
  "$schema": "https://agenticapps.dev/schema/v1.json",
  "protocolVersion": "1.1",
  "id": "deus.video-use",
  "name": "Video Use",
  "description": "HTML-to-video composition workbench. Agent-drivable timeline, lint, render, transcribe.",
  "version": "0.1.0",
  "icon": "./assets/icon.svg",
  "launch": {
    "command": "video-use",
    "args": ["serve", "--port", "{port}"],
    "cwd": "{workspace}",
    "env": { "VIDEO_USE_DATA": "{storage.workspace}/projects" },
    "dev": {
      "command": "video-use",
      "args": ["serve", "--port", "{port}", "--dev"]
    }
  },
  "health": {
    "initial": { "type": "http", "path": "/health", "timeoutMs": 60000 },
    "heartbeatMs": 5000,
    "endpoint": "/health"
  },
  "ui": {
    "url": "http://localhost:{port}/",
    "surface": "browser-tab",
    "preferredSize": { "w": 1280, "h": 800 }
  },
  "agent": {
    "tools": { "type": "mcp-http", "url": "http://localhost:{port}/mcp" },
    "contextShape": "document-list",
    "activeContextEndpoint": "/api/active-context",
    "bootstrap": "Call help for usage. Always lint before render. Renders are async — track via the returned _handle.",
    "skills": [
      { "name": "video-use", "path": "./skills/video-use.md" },
      { "name": "video-use-compositions", "path": "./skills/video-use-compositions.md" },
      { "name": "video-use-render", "path": "./skills/video-use-render.md" }
    ]
  },
  "storage": {
    "workspace": "{workspace}/.deus/apps/{id}",
    "global": "{userData}/apps/{id}"
  },
  "lifecycle": {
    "scope": "workspace",
    "dedupe": "by-workspace",
    "stopSignal": "SIGTERM",
    "stopTimeoutMs": 5000
  },
  "events": {
    "channel": "sse",
    "url": "http://localhost:{port}/deus-events"
  },
  "requires": [
    { "type": "cli", "name": "ffmpeg", "install": "brew install ffmpeg" },
    { "type": "cli", "name": "google-chrome", "install": "Install Chrome from google.com/chrome" }
  ],
  "capabilities": ["filesystem:workspace", "process:spawn", "network:local"]
}
```

### 3.4 Phased implementation (estimated 4–6 days)

Assumes PR 2 (AAP backend) and PR 3 (`@aap/sdk`) have already landed.

**Phase 1 — Scaffold (~0.5 day)**

- Create `packages/video-use/` with package.json, deps, manifest stub.
- `video-use serve --port N` boots a Hono server returning 200 on `/health`.
- Exit criterion: `bun run --filter video-use serve --port 4100` → `curl localhost:4100/health` → 200.

**Phase 2 — Reuse hyperframes server (~1 day)**

- Inside `video-use serve`, instantiate hyperframes's `createStudioServer({ projectDir: VIDEO_USE_DATA })`.
- Mount it at `/`, override `/health` for AAP shape.
- Exit criterion: open `localhost:4100/` → see hyperframes studio loaded with workspace projects.

**Phase 3 — MCP layer via `@aap/sdk` (~2 days)**

- Define all ~17 tools in `src/server/mcp.ts`.
- `render`, `transcribe`, `tts` use the SDK's async-handle helper; bridge hyperframes SSE → `tool-log`.
- Auth middleware via `@aap/sdk`.
- Exit criterion: `curl -H "Authorization: Bearer $TOKEN" localhost:4100/mcp` returns tool list. `tools/call render` streams progress.

**Phase 4 — Skills + active context (~0.5 day)**

- Write three skill markdown files.
- Implement `/api/active-context` (returns currently-focused project ID from a Zustand-style server-side store updated by the studio UI).
- Exit criterion: AAP host loads skills into system prompt. Tool calls include `_context.documentId`.

**Phase 5 — Integration with Deus (~1 day)**

- Register `video-use` in Deus's app registry.
- Verify: launch from sidebar, browser tab opens, Claude can list projects, edit a composition, render, watch progress in chat.
- Exit criterion: end-to-end demo — "Claude, make a 10-second title card video" → composition appears in studio, renders, plays back.

**Phase 6 — Docs + polish (~0.5–1 day)**

- README in `packages/video-use/`.
- Update `aap-v1-design.html` to add video-use as second reference app.
- Apache 2.0 attribution in `LICENSE-NOTICE`.

---

## 4. Open questions / decisions to make before PR

1. **Flagship reframe?** The aap-v1 design doc calls out a ComfyUI-style node graph as the flagship. Hyperframes is arguably stronger because compositions are HTML — Claude's native output medium. Worth re-deciding which app leads the AAP launch story.
2. **SSE or WS for events?** v1 says WS, hyperframes uses SSE. If we accept both per §2.9, ship the SDK with both transports day one or pick one for PR 3 and add the other later?
3. **Skill format compat.** Should `agent.skills` be Vercel-skills-compatible (so apps shipping `vercel-labs/skills` are AAP-compatible with one field), or do we define our own slightly richer format? Probably former.
4. **`contextShape` shape.** Is `document-list` enough, or do we need `tabs`, `cursor-position`, `selection`? Probably reserve the field but only implement `single` and `document-list` in v1.1.
5. **Health response schema.** Is `status: "ready" | "degraded" | "unhealthy"` enough, or do we want HTTP-style codes / metric-style numeric scores?
6. **Port management.** Hyperframes's port registry (`--list`, `--kill-all`) is real prior art. Does Deus want similar `deus apps list/kill` UX, or is the existing app sidebar enough?
7. **Vendor or peerDep hyperframes?** Pinning `@hyperframes/cli@^X` as a runtime dep means we ride their releases. Alternative: vendor a snapshot. Default: peerDep and pin tightly in CI.
8. **Workspace storage scope of projects.** Hyperframes wants `data/projects/<id>/`. Mapped to `{workspace}/.deus/apps/deus.video-use/projects/`. But user might want compositions checked into their repo (`{workspace}/videos/`). Should manifest support `storage.alias` so the user can override without forking?

---

## 5. Cross-references

- `docs/aap-v1-design.html` — original AAP v1 spec
- `docs/device-use-v2-design.md` — first AAP app reference impl (PR 1)
- `.context/hyperframes/` — local clone of the upstream repo (gitignored)
- Upstream: <https://github.com/heygen-com/hyperframes>
- Vercel skills: <https://github.com/vercel-labs/skills>

---

## 6. Changelog

- **2026-04-18** — initial draft, post hyperframes investigation.
