# AGENTS.md

Notes for Claude / agents working on this codebase.

## What this package is

**device-use v2** — a standalone iOS Simulator workbench. Ships:

- A Bun server (`src/server/`) hosting a React viewer at `/`, an MCP HTTP endpoint at `/mcp`, a WebSocket event bus at `/ws`, a REST API under `/api/`, and an MJPEG passthrough at `/stream.mjpeg`.
- A React SPA (`src/frontend/`) — phone frame + sim picker + project/scheme + ▶ Run + inspector + logs drawer.
- A stateless CLI (`src/cli/`) — per-command, imports engine directly, works without the server.
- A Swift engine (`native/simbridge`) — HID + accessibility + MJPEG via private CoreSimulator frameworks.

**CLI and server are peers**: both import `src/engine/` directly. Neither depends on the other.

## Layout

```
packages/device-use/
├── native/              Swift simbridge — don't rewrite without good reason
├── src/
│   ├── engine/          Pure primitives (tests injectable executors/spawners)
│   ├── cli/             Stateless CLI: commands + registry + args parser
│   ├── server/          Bun.serve + Hono: tools, state, stream, mcp, ws
│   └── frontend/        Vite + React SPA served at /
├── scripts/             Build + compile + smoke tests
├── test/                Unit + integration tests (outside src/)
├── agentic-app.json     AAP manifest — consumed by host IDEs
└── skills/              Claude skill gets copied via `device-use install`
```

## Adding a tool

Tools are the one surface the agent sees. Every tool is defined once in `src/server/tools.ts` and routed through `invokeTool` (`src/server/invoker.ts`) which emits `tool-event` frames to anyone listening on `/ws`.

1. Define a tool in `src/server/tools.ts` using the `tool({ name, description, schema, handler })` factory. Schema is Zod; handler takes `(ctx: Context, params: z.infer<schema>)`.
2. Append it to the `TOOLS` array.
3. Add an integration test in `test/server.test.ts` — exercise via `invokeTool(ctx, "your_tool", params)` against a mock `CommandExecutor`.

The same tool is automatically visible via REST (`POST /api/tools/<name>`), MCP (`tools/call`), and the WS invoke frame. No separate wiring.

## Adding a CLI command

CLI is independent — doesn't route through the server.

1. Create `src/cli/commands/foo.ts` exporting `fooCommand: CommandDefinition<Params>`.
2. Import + register in `src/cli/index.ts`.
3. Document in `skills/device-use/SKILL.md` (copied to `~/.claude/skills/` by `device-use install`).

## Event shape (`/ws`)

Every tool invocation emits:

```ts
{ type: "tool-event", id, at, tool, params, status: "started"|"completed"|"failed", result?, error? }
```

Long-running tools (`build`, `stream_logs`) additionally emit:

```ts
{ type: "tool-log", id, stream: "stdout"|"stderr", text }
```

The `id` correlates across lifecycle events. We reuse this exact shape for MCP tool calls — no parallel schema.

## Build pipeline

- `bun run build:native` → `native/.build/release/simbridge`
- `bun run build:ts` → `dist/cli.js` + `dist/engine.js`
- `bun run build:frontend` → `dist/frontend/` (static SPA)
- `bun run build` → all of the above
- `bun run compile` → single compiled `bin/device-use` + copied `bin/simbridge`

## simbridge path resolution

`src/engine/simbridge.ts → findBridgePath()` looks up in order:

1. `$DEVICE_USE_SIMBRIDGE` override
2. Sibling of `process.execPath` (compiled binary case)
3. Relative to `import.meta.url` (source / bundled case)

## Hard rules

- **Never bypass `invokeTool`.** If you're adding a code path that touches the engine from MCP/REST/WS, it goes through the invoker so events fire.
- **Never persist state outside `state.json`.** If you need a new persisted field, add it to `PersistedState` in `src/server/state.ts`.
- **`src/frontend/` must only talk HTTP/WS.** No engine imports from the browser.
- **Tests live in `test/`** — never colocate inside `src/`.
- **Stateless CLI stays stateless.** Per-command, no long-lived subprocess (except `serve`, which IS the long-lived subprocess and spawns the server).
