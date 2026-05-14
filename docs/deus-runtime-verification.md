# Deus Runtime Verification Notes

The packaged macOS runtime is validated in two layers:

- Static/local checks prove the staged and packaged files are present, fresh, signed, and wired into Electron.
- Direct runtime checks prove the Mach-O executables launch and the packaged desktop reaches backend and agent-server readiness.

## Local Static Checks

These checks do not require executing newly staged or packaged Mach-O binaries:

```bash
bun run validate:runtime
bun run prepare:agent-clis
bun run prepare:gh-cli
bun run typecheck
bun run typecheck:backend
bun run typecheck:agent-server
bun run smoke:runtime-resources
node scripts/runtime/smoke-packaged-app.cjs --app dist-electron/mac-arm64/Deus.app
```

They verify:

- `dist/runtime/electron/bin/<runtime-key>/deus-runtime` exists for Darwin arm64/x64 and matches `deus-runtime.json`.
- `codex`, `claude`, `gh`, and `rg` exist for Darwin arm64/x64 and match their manifests.
- Packaged `Resources/bin` contains executable `deus-runtime`, `codex`, `claude`, `gh`, and `rg`.
- Packaged app.asar contains the `deus-runtime` launch contract and no obsolete packaged backend path plumbing.
- Native binaries have the expected architecture, code signature, page size, entitlements, and system dylib dependencies.

PR CI also runs the root desktop/runtime unit suite:

```bash
bun run test:simulator
```

That suite covers the packaged Electron backend spawn contract, packaged CLI lookup behavior, and electron-builder runtime guardrails.

## Direct Runtime Checks

These checks execute newly staged or packaged Mach-O binaries and are required before considering the runtime fully verified:

```bash
bun run smoke:runtime-native
bun run smoke:packaged-runtime -- --app <Deus.app>
bun run smoke:packaged-desktop -- --app <Deus.app>
```

They verify:

- `deus-runtime --version` returns the runtime version and runtime key.
- `deus-runtime agent-server` reaches `LISTEN_URL`.
- `deus-runtime backend` reaches `[BACKEND_PORT]` with an isolated data directory.
- The agent-server reports initialized `claude` and `codex-sdk` agents.
- Backend `/api/workspaces` is served from the runtime process.
- Packaged logs do not contain `spawn codex ENOENT`, `spawn claude ENOENT`, `ELECTRON_RUN_AS_NODE`, global CLI fallback, or other runtime contract failures.

## Known Local Host Blocker

On this macOS workstation, direct execution of newly created or copied Mach-O files can hang before user code runs. The observed failure mode is a timeout at `_dyld_start`; it affects staged `deus-runtime`, packaged `deus-runtime`, freshly copied agent CLIs, copied Bun/Node binaries, Electron helper binaries, Vitest startup, and local Electron packaging helpers.

Because of that host policy, a local run can truthfully complete the static checks above but cannot prove direct runtime or packaged desktop launch. Direct runtime and packaged desktop verification must run on a notarized artifact or a macOS host that allows the staged/copied Mach-O binaries to execute.

The release workflow runs the required direct checks on macOS after packaging and notarization:

- `bun run smoke:runtime-native`
- `node scripts/runtime/smoke-packaged-runtime.cjs --app "$copied_app" --require-gatekeeper`
- `node scripts/runtime/smoke-packaged-desktop.cjs --app "$copied_app" --require-gatekeeper`
