# Deus Runtime Completion Audit

Status: complete for the `bun-runtime` branch runtime implementation. The runtime code head
`1cbe37db947fe0cbef64e8d44d4ca7977f0cc7b0` passed the macOS runtime CI gate on
2026-05-14, including direct native runtime execution, packaged app bundle
validation, packaged runtime execution, and packaged Electron desktop startup.

This is not a notarized-release signoff. Release verification should still run
the notarized DMG/Gatekeeper checks before shipping public artifacts.

## Verified Head

- Branch: `bun-runtime`
- Runtime code commit: `1cbe37db947fe0cbef64e8d44d4ca7977f0cc7b0`
- GitHub Actions run: `25871120854`
- Workflow: `Tests`
- Result: success
- URL: https://github.com/zvadaadam/deus-machine/actions/runs/25871120854

## Objective Mapping

| Requirement | Current artifact/evidence | Status |
| --- | --- | --- |
| Packaged macOS app starts backend through `Resources/bin/deus-runtime` | `apps/desktop/main/backend-process.ts` resolves packaged runtime to `process.resourcesPath/bin/deus-runtime` and spawns it with `["backend"]`. CI `smoke-packaged-desktop` reached backend readiness from the packaged app. | Verified |
| Backend starts agent-server through the same runtime | `apps/backend/src/runtime/agent-process.ts` uses `DEUS_RUNTIME_EXECUTABLE` with `["agent-server"]`; packaged backend refuses the old Electron-as-Node fallback when the runtime executable is absent. CI packaged desktop logs include backend-relayed `LISTEN_URL`. | Verified |
| `deus-runtime` is a real Bun-compiled native executable | `apps/runtime/index.ts` implements dispatch; `scripts/runtime/native-runtime.ts` builds Darwin arm64/x64 with `bun build --compile`; CI validated Mach-O architecture, signatures, entitlements, page size, and dylibs. | Verified |
| `deus-runtime --version` works | CI native smoke printed `deus-runtime 0.3.6 darwin-arm64`; packaged runtime smoke printed the same from `Deus.app/Contents/Resources/bin/deus-runtime`. | Verified |
| `deus-runtime agent-server` reaches `LISTEN_URL` | CI native and packaged runtime smokes waited for `LISTEN_URL`, then asserted initialized agents over JSON-RPC. | Verified |
| `deus-runtime backend` reaches `[BACKEND_PORT]` and owns agent-server startup | CI native and packaged runtime smokes waited for `[BACKEND_PORT]`, asserted agent-server readiness, and hit the backend DB route. | Verified |
| Bundle `deus-runtime`, `codex`, `claude`, `gh`, and `rg` into `Resources/bin` | `electron-builder.yml` lists the binaries under macOS `extraResources`; CI package smoke verified all five in `Deus.app/Contents/Resources/bin` and ran binary version checks. | Verified |
| Use bundled native agent CLIs by default | `shared/lib/cli-path.ts` and `apps/agent-server/agents/environment/cli-discovery.ts` resolve packaged defaults from the bundled bin directory. CI logs include `BUNDLED_CLI_PATH` for packaged `claude` and `codex`. | Verified |
| Preserve explicit developer/user overrides | `cli-discovery.ts` still checks configured override paths before bundled candidates and verifies custom overrides with version flags; unit and runtime CI passed. | Verified |
| Remove packaged global/shell CLI discovery fallback | `cli-discovery.ts` no longer accepts bare packaged commands; packaged env setup uses `Resources/bin` plus system paths only; CI greps found no `global CLI`, `spawn codex ENOENT`, or `spawn claude ENOENT` fallback logs. | Verified |
| Remove obsolete packaged Electron-as-Node backend path plumbing | `backend-process.ts` uses `process.execPath` only for dev. CI bundle guards reject stale `resources/backend`, `AGENT_SERVER_ENTRY`, and `ELECTRON_RUN_AS_NODE` packaged paths. | Verified |
| Preserve dev and web mode | Dev path remains Electron-as-Node/source-entry based, while packaged mode switches to `deus-runtime`; web/dev scripts remain unchanged. Typecheck and backend/agent-server tests passed in CI. | Verified |
| Keep Linux/Windows packaged behavior explicit | `package:linux` and `package:win` route to `scripts/runtime/unsupported-packaged-platform.cjs` and fail with explicit unsupported-platform messages. | Verified |
| CUA or packaged Electron smoke | No separate CUA harness exists in this repo. The available packaged desktop smoke launches packaged Electron, waits for runtime readiness, verifies bundled CLI paths, asserts initialized agents, hits the backend DB route, and rejects fallback log patterns. | Verified by automated packaged desktop smoke |

## CI Evidence

Latest successful macOS runtime CI job included these successful steps:

- `bun run build:runtime`
- `bun run validate:runtime`
- `bun run smoke:runtime-source`
- `bun run smoke:desktop-main-runtime`
- `bun run smoke:runtime-native -- --skip-validate`
- `bun run smoke:runtime-resources`
- `bun run package:mac:dir -- --arch "$MAC_BUILDER_ARCH"`
- `node scripts/runtime/smoke-packaged-app.cjs`
- `node scripts/runtime/smoke-packaged-runtime.cjs`
- `node scripts/runtime/smoke-packaged-desktop.cjs`

Important log evidence from run `25871120854`:

- Native runtime version: `deus-runtime 0.3.6 darwin-arm64`
- Packaged runtime version: `deus-runtime 0.3.6 darwin-arm64`
- Packaged binary versions: `gh version 2.92.0`, `codex-cli 0.130.0`,
  `Claude CLI: 2.1.131 (Claude Code)`, `ripgrep 15.1.0`
- Packaged `Resources/bin` contained executable `deus-runtime`, `codex`,
  `claude`, `gh`, `rg`, and `agent-browser`
- Native and packaged runtime smokes resolved bundled `claude` and `codex`,
  initialized agents, and served the backend DB route
- Packaged desktop smoke reached Electron app readiness, backend startup,
  agent-server `LISTEN_URL`, bundled CLI path logs, initialized agents, and the
  backend DB route
- A forbidden-pattern sweep found no `spawn codex ENOENT`,
  `spawn claude ENOENT`, `ELECTRON_RUN_AS_NODE`, `global CLI fallback`,
  `gh_not_installed`, `Cannot find module`, or packaged runtime failure strings

## Reference Checks

- Conductor bundle shape was inspected from
  `/Applications/Conductor.app/Contents/Resources/bin`: native runtime plus
  bundled CLIs, system dylibs only, Developer ID signing, and hardened runtime.
- OpenCode desktop sidecar readiness patterns were inspected in
  `.context/reference-opencode/packages/desktop/src/main/server.ts`, including
  ready messages, health checks, bounded startup timeout, and bounded stop.
- T3Code staged desktop artifact patterns were inspected in
  `.context/reference-t3code/scripts/build-desktop-artifact.ts`, including
  staged server/desktop artifact assembly and smoke-oriented process output
  collection.

## Local Host Notes

This workstation still cannot reliably execute newly generated or copied Mach-O
binaries because local launch policy stalls before user code at `_dyld_start`.
Local direct staged runtime and copied packaged app execution can therefore time
out here even when the same checks pass on GitHub's macOS runner.

Local checks that passed before relying on CI:

- `bun run build:runtime`
- `bun run validate:runtime`
- `bun run prepare:agent-clis`
- `bun run prepare:gh-cli`
- `bun run smoke:runtime-source`
- `bun run smoke:runtime-resources`
- `bun run smoke:desktop-main-runtime`
- `bun run typecheck`
- `bun run typecheck:backend`
- `bun run typecheck:agent-server`
- `bun run package:linux` and `bun run package:win` both fail explicitly as
  unsupported packaged targets

## Release Follow-Up

Before public distribution, run the release/notarization path and require:

```bash
bun run package:mac
node scripts/runtime/smoke-packaged-app.cjs --app <Deus.app> --require-gatekeeper
node scripts/runtime/smoke-packaged-runtime.cjs --app <Deus.app> --require-gatekeeper
node scripts/runtime/smoke-packaged-desktop.cjs --app <Deus.app> --require-gatekeeper
```

Those release checks should prove the notarized artifact passes Gatekeeper and
still launches backend and agent-server through bundled `Resources/bin/deus-runtime`.
