# AGENTS.md

Notes for agents working on this package.

## What this package is

Deus's iOS Simulator engine. Nothing here runs on its own: the backend and the
agents' simulator tools import the engine, and the backend starts the helpers.

- `src/engine/` — TypeScript the backend imports as `device-use/engine`
  (bundled to `dist/engine.js`, which `bun build --compile` folds into
  deus-runtime). It exports only what Deus calls: `simulatorEnv`,
  `findBridgePath`, `findInspectorPath`, `callSimBridge` (the backend,
  `apps/backend/src/services/simulator-context.ts`) and `createExecutor`,
  `listSimulators`, `takeScreenshot`, `installApp`, `launchApp`, `listApps`,
  `fetchAccessibilityTree`, `buildSnapshot`, `formatTree` (the agents' tools,
  `apps/agent-server/agents/deus-tools/sim-ops.ts`, typed by
  `apps/agent-server/types/device-use-engine.d.ts`). Remove an export when its
  last caller goes.
- `native/` — two helpers built against Apple's private CoreSimulator and
  SimulatorKit frameworks:
  - `simbridge`: one-shot commands (`describe-ui`, `tap`, `type`, `swipe`,
    `key`, `button`) as a JSON argument, and `--stream --udid <udid> --port 0`,
    the long-lived helper the backend starts for the Simulator tab. It captures
    the screen as MJPEG (`/stream.mjpeg`) and takes input on a WebSocket
    (`/ws`, binary frames: `0x03` touch, `0x04` button, `0x05` key), on
    127.0.0.1 only, every request carrying the token from
    `SIMBRIDGE_STREAM_TOKEN` as `?t=`. It prints `{"port": …}` when ready and
    exits when its stdin closes.
  - `siminspector.dylib`: injected into an app on the simulator to answer the
    inspector's questions over a socket.
- `test/` — unit tests of the engine (`bun test`, run in CI). They need no
  simulator.

## Build

`bun run prepare:device-use` (at the repository root, run by `postinstall`)
builds `dist/engine.js` (`scripts/build-ts.ts`) and both helpers
(`scripts/build-native.ts`, universal arm64 + x86_64, so full Xcode is needed),
and copies the helpers to `bin/`. `--force` rebuilds everything. The packaging
scripts take the engine bundle and `bin/` (`scripts/runtime/lib/device-use-payloads.cjs`).

## Helper path resolution

`findBridgePath()` / `findInspectorPath()` (`src/engine/simbridge.ts`) look in
order at `$DEVICE_USE_SIMBRIDGE` / `$DEVICE_USE_SIMINSPECTOR`, the packaged
app's `Resources/simulator`, this package's `bin/`, next to `process.execPath`,
then `native/.build/release/`.

## Hard rules

- Tests live in `test/`, never inside `src/`.
- Input to the simulator goes through `ObjCBridge.m`; keep the Swift side thin.
