---
name: cua-desktop-testing
description: Test the Deus Electron desktop app with the cua-driver CLI. Use when validating desktop-only behavior, Electron boot, renderer/backend/agent-server wiring, native window interactions, or packaged app runtime binaries.
---

# CUA Desktop Testing

Use this skill when you need to test Deus as a real macOS Electron app, not just as a web page or backend process.

The goal is to prove the full desktop stack:

```text
Electron main -> backend -> agent-server -> provider/runtime -> DB/events -> renderer
```

## Core Rules

- Use `cua-driver` for native macOS app inspection and interaction.
- Do not use `open`, `open -a`, activation AppleScript, `cliclick`, or foreground-stealing shortcuts.
- Keep the user's frontmost app unchanged unless they explicitly asked to bring Deus forward.
- Always snapshot before element-indexed actions:

```text
list apps/windows -> get_window_state -> act -> get_window_state -> assert
```

- Use Bun for repo scripts: `bun run dev`, `bun run typecheck`, `bun run test:*`.

## Test Scale

### Level 0: CUA Preflight

Confirm the desktop automation layer can see apps and has permissions.

```bash
cua-driver check_permissions '{}'
cua-driver get_config '{}'
cua-driver list_apps '{}'
```

Expected:

- Accessibility and Screen Recording are available.
- `capture_mode` is usually `som`.

### Level 1: Electron Runtime Boot

Start the desktop app from the repo root.

```bash
bun run dev
```

Watch for:

```text
[agent-server] LISTEN_URL=...
[BACKEND_PORT]...
Server ready!
[AgentClient] Handshake complete: ... agents=[claude, codex-sdk, codex-server]
```

This catches Electron rebuilds, native module ABI issues, backend spawn, agent-server spawn, and agent discovery.

### Level 2: Native Window Smoke

Find the Electron process and window.

```bash
cua-driver list_apps '{}'
cua-driver list_windows '{"pid":7467}'
cua-driver get_window_state '{"pid":7467,"window_id":25416}'
```

Use the actual `pid` and `window_id` from your run.

If `list_windows` says the window is not on the current Space, do not force activation. Either ask the user to move it to the current Space or test the lower runtime layer through backend/CDP.

### Level 3: UI Interaction Smoke

Drive visible controls through CUA.

```bash
cua-driver get_window_state '{"pid":7467,"window_id":25416}'
cua-driver click '{"pid":7467,"window_id":25416,"element_index":48}'
cua-driver type_text '{"pid":7467,"window_id":25416,"text":"hello"}'
cua-driver get_window_state '{"pid":7467,"window_id":25416}'
```

Use this for:

- composer input and send
- model picker and menus
- tab switching
- modals and buttons
- visual state checks

After every action, re-snapshot and assert the visible state changed.

### Level 4: Product Flow E2E

Use this when correctness depends on backend or provider state, not only UI state.

Combine:

- CUA for app/window discovery.
- Electron logs for boot and agent events.
- Electron CDP on port `19222` for renderer DOM inspection when useful.
- Backend WebSocket or HTTP for deterministic command/mutation assertions.
- SQLite reads only for test verification, never for product writes.

Typical checks:

- A `q:mutate` or `q:command` is accepted.
- Backend logs show `session.started`, `turn.started`, provider events, and `session.idle`.
- DB state reaches the expected terminal value.
- Renderer shows the expected user-visible result.

This level is appropriate for agent goal flows, packaging/runtime binary bugs, backend-agent protocol changes, and desktop-only regressions.

### Level 5: Packaged App Verification

Use this before release or when runtime binaries are involved.

Check packaged resources:

```bash
/Applications/Deus.app/Contents/Resources/bin/codex --version
/Applications/Deus.app/Contents/Resources/bin/claude --version
```

Then run the same Level 4 feature flow against the packaged app. The packaged app should prefer bundled `Resources/bin/codex` and `Resources/bin/claude`, not global shell installs.

## Electron-Specific Notes

Dev builds expose Chrome DevTools Protocol on port `19222`.

```bash
curl -s http://127.0.0.1:19222/json/list
```

Use CDP when:

- the Electron window is on another Space and CUA cannot snapshot it
- you need renderer DOM/state, not native window semantics
- synthetic UI routing is less reliable than a backend protocol assertion

CUA remains the preferred source for native window truth. CDP is a supplement for renderer internals.

## Backend WebSocket E2E Pattern

When testing a desktop feature that crosses into backend/agent-server, prefer a controlled WebSocket smoke over brittle UI clicks.

1. Start `bun run dev`.
2. Read `[BACKEND_PORT]` from logs.
3. Create any required temp repository/workspace/session rows.
4. Connect to `ws://127.0.0.1:<port>/ws`.
5. Send the relevant `q:mutate` or `q:command`.
6. Wait for terminal DB/log/event state.
7. Clean up test rows and temp files.

This still exercises the live Electron-managed backend and agent-server.

## Failure Triage

- `spawn Electron ENOENT`: some child process tried to use Electron's `process.execPath` as a Node runtime.
- `spawn node ENOENT`: the child process fell back to bare `node` but did not have a usable `PATH`; prefer absolute Node paths or native bundled binaries.
- Missing `codex` or `claude`: verify packaged `Resources/bin/*` first, then package-specific unpacked node_modules fallback, then env/global fallback.
- Empty or sparse AX tree: rerun `get_window_state` once, verify `capture_mode`, and confirm the window is on the current Space.
- UI click seems ignored: re-snapshot, verify the element index belongs to the latest `(pid, window_id)` snapshot, then consider CDP/backend protocol if the issue is not visual.

## Cleanup

Stop dev sessions you started before finishing.

```text
Ctrl-C the bun run dev terminal
ps aux | rg 'papeete-v1|Electron\\.app|agent-server|server\\.cjs'
```

Do not kill unrelated user processes. If cleanup is risky, report the process ids and ask.
