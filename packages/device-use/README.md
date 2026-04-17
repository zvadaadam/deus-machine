# device-use

Standalone iOS Simulator workbench for humans and agents.

- **Viewer** — open `localhost:3100` to see a live phone screen, boot sims, build + run your Xcode project, inspect the a11y tree.
- **MCP server** — `/mcp` exposes 23 tools (build, install, launch, tap, type, snapshot, …). Any MCP-speaking client (Claude Code, Claude Desktop, Cursor, …) can drive the simulator.
- **CLI** — `device-use list`, `device-use tap @e1`, `device-use serve`, etc. Works standalone, no server required.

Under the hood: a Bun server hosting a React viewer, an HTTP MCP transport, a WebSocket event bus, and a Swift `simbridge` binary that talks to private CoreSimulator + AccessibilityPlatform frameworks.

## Install from source

```bash
bun install
bun run build:native      # Builds the Swift simbridge binary (requires Xcode)
```

## Run the server

```bash
bun run dev               # Hono server on 3100 (proxies to Vite for HMR)
bun run dev:frontend      # Vite dev server on 5173 (second terminal)
# or, from the CLI:
bunx device-use serve --port 3100 --open
```

Open [http://localhost:3100](http://localhost:3100). Pick a simulator, paste a `.xcodeproj`/`.xcworkspace` path, click **▶ Run**.

For production: `bun run build && bun run start`.

## MCP endpoint

Point any MCP client at `http://localhost:3100/mcp`. Example — Claude Desktop's `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "device-use": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Tools available: `list_devices`, `boot`, `set_active_simulator`, `set_active_project`, `get_project_info`, `build`, `install`, `launch_app`, `terminate_app`, `list_apps`, `app_state`, `snapshot`, `tap`, `type_text`, `swipe`, `press_button`, `screenshot`, `wait_for`, `open_url`, `grant_permission`, `stream_logs`, `stop_logs`, `get_state`.

## CLI

```bash
device-use list                      # List simulators
device-use boot "iPhone 17 Pro"      # Boot by name
device-use snapshot -i               # Accessibility tree with @refs
device-use tap @e1                   # Tap by ref
device-use type "hello@example.com"  # Type into focused field
device-use screenshot result.png     # Capture screen
device-use serve --open              # Start server + open viewer
device-use doctor                    # Verify environment
```

Full command list: `device-use help`.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  packages/device-use/                                            │
│                                                                  │
│   native/      — Swift simbridge binary (unchanged)              │
│                                                                  │
│   src/engine/  — TS primitives: simctl + simbridge IPC +         │
│                  xcodebuild + logs. Pure, injectable executors.  │
│       ▲                                                           │
│       │ imported by                                               │
│       │                                                           │
│   ┌───┴────────────┐       ┌────────────────────────────┐        │
│   │  src/cli/      │       │  src/server/               │        │
│   │  per-command,  │       │  long-lived Bun.serve      │        │
│   │  stateless     │       │  /  /mcp  /ws  /health     │        │
│   └────────────────┘       │  /stream.mjpeg  /api/*     │        │
│                            └──────────┬─────────────────┘        │
│                                       │ serves                    │
│                                       ▼                           │
│                            src/frontend/  (Vite + React)          │
│                            TopBar, DeviceFrame, Sidebar,          │
│                            LogsDrawer — WS client of server       │
└──────────────────────────────────────────────────────────────────┘
```

CLI and server share the engine but are independent peers — neither needs the other to work.

## Agentic Apps Protocol

device-use is the reference implementation of an AAP app. The `agentic-app.json` at the package root declares how a host IDE (Deus, any MCP-speaking IDE) should launch and embed it.

## Develop

```bash
bun test                  # 86 unit + integration tests, no real sim needed
bun run typecheck         # tsc --noEmit
bun run build             # simbridge + ts bundles + frontend bundle
bun run compile           # single-file bin/device-use + bin/simbridge
```

Tests live in `test/` — never colocated with `src/`. `packages/device-use/scripts/ws-smoke.ts` is a manual WS sanity check (server must be running).

## License

MIT
