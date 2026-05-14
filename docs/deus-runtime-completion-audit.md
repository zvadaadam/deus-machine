# Deus Runtime Completion Audit

Status: implementation is staged, but the overall goal is not complete until direct runtime and packaged desktop smokes pass on a macOS host that can execute generated/copied Mach-O binaries, preferably the notarized release artifact.

## Objective Mapping

| Requirement | Current artifact/evidence | Status |
| --- | --- | --- |
| Packaged macOS app starts backend through `Resources/bin/deus-runtime` | `apps/desktop/main/backend-process.ts` resolves packaged runtime to `process.resourcesPath/bin/deus-runtime` and spawns it with `["backend"]`. `scripts/runtime/smoke-desktop-main-runtime.cjs` bundles current main source and asserts this contract. | Static/source verified |
| Backend starts agent-server through the same runtime | `apps/backend/src/runtime/agent-process.ts` uses `DEUS_RUNTIME_EXECUTABLE` with `["agent-server"]`; packaged backend refuses the old Electron-as-Node fallback when the runtime executable is absent. | Static/source verified |
| `deus-runtime` is a real Bun-compiled native executable | `apps/runtime/index.ts` implements command dispatch; `scripts/runtime/native-runtime.ts` builds Darwin arm64/x64 with `bun build --compile`; `dist/runtime/electron/bin/deus-runtime.json` records arch, hash, `file`, and `otool` output. | Static verified |
| `deus-runtime --version` works | Implemented in `apps/runtime/index.ts`; `scripts/runtime/smoke-native-runtime.cjs` and packaged smokes execute it directly. | Requires direct Mach-O execution |
| `deus-runtime agent-server` reaches `LISTEN_URL` | Implemented by importing `apps/agent-server/index`; `scripts/runtime/smoke-source-runtime.cjs`, `scripts/runtime/smoke-native-runtime.cjs`, and `scripts/runtime/smoke-packaged-runtime.cjs` wait for `LISTEN_URL`. | Source verified; native/package direct smoke required |
| `deus-runtime backend` reaches `[BACKEND_PORT]` and owns agent-server startup | Implemented by importing `apps/backend/src/server`; source/native/package smokes wait for `[BACKEND_PORT]`, backend DB route, and agent-server readiness. | Source verified; native/package direct smoke required |
| Bundle `deus-runtime`, `codex`, `claude`, `gh`, and `rg` into `Resources/bin` | `electron-builder.yml` lists all five binaries under `mac.extraResources` and `mac.binaries`; `scripts/prune-pencil-cli-binaries.cjs` verifies packaged `Resources/bin`; `scripts/runtime/smoke-packaged-app.cjs` statically inspects the app bundle. | Packaging hook/static verified |
| Use bundled native agent CLIs by default | `shared/lib/cli-path.ts` resolves packaged/runtime defaults only from `DEUS_BUNDLED_BIN_DIR` or `Resources/bin`; `apps/agent-server/agents/environment/cli-discovery.ts` accepts bundled `codex`/`claude` without shell lookup and emits `BUNDLED_CLI_PATH`. | Static/source verified |
| Preserve explicit developer/user overrides | `cli-discovery.ts` still checks configured env override paths before bundled candidates and verifies custom overrides with the version flag. | Static/source verified |
| Remove packaged global/shell CLI discovery fallback | `cli-discovery.ts` no longer accepts bare commands; `env-builder.ts` skips login-shell capture under `DEUS_PACKAGED`/`DEUS_RUNTIME`; packaged PATH is `Resources/bin` plus system paths only. | Static/source verified |
| Remove obsolete packaged Electron-as-Node backend path plumbing | `backend-process.ts` only uses `process.execPath` for dev; packaged path uses `deus-runtime`. `electron-builder-before-pack.cjs` and `smoke-packaged-app.cjs` reject obsolete `resources/backend` and `runtime.nodePath` snippets. | Static/package guard verified |
| Keep Linux/Windows packaged behavior explicit | `package:linux` and `package:win` route to `scripts/runtime/unsupported-packaged-platform.cjs`; `electron-builder-before-pack.cjs` rejects non-Darwin packaged runtime builds. | Static verified |
| CUA packaged desktop verification | `docs/deus-runtime-verification.md` records the local `_dyld_start` host-policy blocker. `scripts/runtime/smoke-packaged-desktop.cjs` is the automated packaged desktop readiness check. | Blocked locally; required on executable host |

## Latest Guardrail Slices

- Release verification statically runs `scripts/runtime/smoke-packaged-app.cjs --require-gatekeeper` over every produced `.app` before upload; direct packaged runtime/desktop smokes still run on the host-arch app copied from the notarized DMG.
- Release verification also mounts every produced DMG and runs `scripts/runtime/smoke-packaged-dmgs.cjs --require-gatekeeper`, so static bundle inspection covers release artifacts, not only unpacked app directories.
- Static packaged app smoke rejects unexpected `Resources/bin` entries; only `deus-runtime`, `codex`, `claude`, `gh`, `rg`, and their manifests are allowed.
- Native and packaged runtime direct smokes now verify `self-test` layout, including `binDir`, `resourcesPath`, and native-module `NODE_PATH`.
- Packaged Electron main and native `deus-runtime` force `NODE_ENV=production`; direct runtime smokes assert the self-test reports production mode.
- Runtime-managed agent-server spawns scrub backend-only auth, database, data-dir, and listen-port env while preserving desktop runtime context.
- Packaged Electron main now also scrubs stale backend-only auth, database, data-dir, bundled-bin, and listen-port env before spawning `deus-runtime backend`; smoke launchers apply the same cleanup so verification cannot accidentally inherit an obsolete runtime context.
- `electron-builder` beforePack and `smoke-packaged-app` now reject packaged Electron main output that lacks the packaged runtime env scrub denylist, so stale app bundles cannot silently omit the stricter backend/runtime env cleanup.
- `electron-builder` beforePack and `smoke-packaged-app` also reject packaged Electron main output that lacks bundled CLI lookup and terminal command guards for `codex`, `claude`, `gh`, and `rg`.
- Staged and packaged `--version` verification helpers scrub stale backend/runtime env before launching `deus-runtime`, `codex`, `claude`, `gh`, or `rg`, so afterPack and runnable-validation checks cannot inherit obsolete Electron-as-Node, `NODE_PATH`, bundled-bin, data-dir, auth, or port settings.
- Desktop CLI lookup/auth and backend `gh` service child processes now scrub stale runtime-only env while still resolving packaged `gh` through bundled `Resources/bin`.
- `b72f4d96 test: smoke current desktop runtime contract` verifies current Electron main source by bundling it to a temporary output and checking the packaged `deus-runtime` launch contract.
- `fa6cfca7 test: tighten packaged main runtime guard` makes the before-pack and app.asar smoke checks share the stricter packaged main runtime contract assertion.
- `87f66d88 docs: record runtime resign diagnostic` records that ad-hoc re-signing a temporary runtime copy does not bypass this host's provenance/Gatekeeper launch blocker.

## Local Evidence

Previously inspected state at the start of this audit:

- `git status --short --branch` reports a clean `bun-runtime` worktree before this audit refresh.
- `dist/runtime/electron/bin` contains Darwin arm64/x64 staged `deus-runtime`, `codex`, `claude`, `gh`, and `rg`.
- `dist/runtime/electron/bin/deus-runtime.json`, `agent-clis.json`, and `gh-cli.json` contain project-relative paths, hashes, sizes, and architecture metadata.
- No lingering workspace `deus-runtime`, Electron, Vitest, or packaging processes were alive during this audit.

Recorded branch checks:

- `bun run build:runtime`
- `bun run validate:runtime`
- `bun run smoke:runtime-source`
- `bun run smoke:runtime-resources`
- `bun run smoke:desktop-main-runtime`
- `bun run typecheck`
- `bun run typecheck:backend`
- `bun run typecheck:agent-server`

Recent focused checks:

- `bun run smoke:runtime-source` passed after the source-smoke env scrub and backend/desktop env-denylist hardening, including stale `DEUS_BUNDLED_BIN_DIR` cleanup.
- `bun run smoke:desktop-main-runtime` passed after tightening the beforePack/app.asar packaged-main env scrub assertion.
- `node --check scripts/runtime/electron-builder-before-pack.cjs` passed.
- A direct Node probe of `assertPackagedMainRuntimeContract` accepted output with the packaged env scrub denylist and rejected stale output without it.
- `bun run prepare:agent-clis` passed standalone and refreshed staged Darwin `codex`/`claude` payloads.
- `bun run prepare:gh-cli` passed standalone and refreshed staged Darwin `gh` payloads after checksum and signature verification.
- `bun run build` still hangs after starting `electron-vite build`; a 30s wrapper killed it before any build output beyond the command banner.
- `node --check scripts/prune-pencil-cli-binaries.cjs && node --check scripts/runtime/run-version-check.cjs` passed after version-check env cleanup.
- A dirty-env probe of `scripts/runtime/run-version-check.cjs /usr/bin/env` passed and confirmed backend/runtime env vars are stripped from the version-check child process.
- `bun run build:runtime`, `bun run validate:runtime`, and `bun run smoke:runtime-resources` passed after version-check env cleanup.
- `DEUS_VERIFY_RUNTIME_RUNNABLE=1 bun run validate:runtime` still failed at direct `deus-runtime --version` on this host, but the bounded helper exited with status 124 and printed the same `Unnotarized Developer ID`/`com.apple.provenance` diagnostics.
- `bun run smoke:runtime-source`, `bun run smoke:desktop-main-runtime`, `bun run build:runtime`, `bun run validate:runtime`, and `bun run smoke:runtime-resources` passed after desktop/backend `gh` child-env cleanup.
- `bun run smoke:desktop-main-runtime`, `node --check scripts/runtime/electron-builder-before-pack.cjs`, and a direct beforePack packaged-CLI guard probe passed after tightening packaged main bundle assertions.
- `bun run typecheck`, `bun run typecheck:backend`, and `bun run typecheck:agent-server` passed after the env-denylist changes.
- `node --check scripts/runtime/smoke-source-runtime.cjs && node --check scripts/runtime/smoke-native-runtime.cjs && node --check scripts/runtime/smoke-packaged-runtime.cjs && node --check scripts/runtime/smoke-packaged-desktop.cjs` passed.
- Focused Vitest for `test/unit/desktop`, `test/unit/runtime`, and shared runtime/CLI-path tests still hangs before Vitest output and was killed by a 20s wrapper.
- Focused Vitest for `apps/backend/test/unit/runtime/agent-process.test.ts` still hangs before Vitest output and was killed by a 20s wrapper.
- `bun run build:runtime` rebuilt both Darwin native runtime executables again after the backend source change.
- `bun run validate:runtime` passed against the refreshed `dist/runtime`.
- `bun run smoke:runtime-resources` passed for both `darwin-arm64` and `darwin-x64` against the refreshed `dist/runtime`.
- `node scripts/runtime/smoke-native-runtime.cjs --skip-validate` still failed at the required direct `deus-runtime --version` gate on this host: no stdout/stderr before the 45s timeout; `file` showed arm64 Mach-O, `codesign` showed Developer ID Application signing, `spctl` rejected it as `Unnotarized Developer ID`, and `xattr` showed `com.apple.provenance`.
- `node scripts/runtime/smoke-packaged-app.cjs --help`
- Focused Vitest for `test/unit/runtime/electron-builder-before-pack.test.ts` still hangs before any output and was killed by a 20s wrapper.
- Direct `deus-runtime --version` through `scripts/runtime/run-version-check.cjs` still times out before stdout/stderr.

Known local blockers:

- Direct staged or packaged Mach-O execution hangs before user code on this workstation at `_dyld_start`.
- Ad-hoc re-signing a temporary runtime copy and clearing xattrs with normal `xattr` commands did not remove `com.apple.provenance` or make `deus-runtime --version` runnable here.
- `bun run build`/`electron-vite build`, Vitest, packaged app launch, and copied helper binaries hit the same host-policy boundary.
- `beforePack` correctly refuses packaging from stale `out/main/index.js` on this host until `bun run build` can refresh Electron outputs.

## Required Before Done

Run these on a macOS host that can execute generated/copied binaries, or on the notarized release artifact:

```bash
bun run build:runtime
bun run validate:runtime
bun run smoke:runtime-native
bun run package:mac
node scripts/runtime/smoke-packaged-app.cjs --app <Deus.app>
node scripts/runtime/smoke-packaged-runtime.cjs --app <Deus.app> --require-gatekeeper
node scripts/runtime/smoke-packaged-desktop.cjs --app <Deus.app> --require-gatekeeper
```

The direct checks must prove:

- `deus-runtime --version` returns the expected version/runtime key.
- `deus-runtime agent-server` reaches `LISTEN_URL`.
- `deus-runtime backend` reaches `[BACKEND_PORT]` with an isolated data directory.
- Packaged `Resources/bin` contains executable `deus-runtime`, `codex`, `claude`, `gh`, and `rg`.
- Packaged logs contain no `spawn codex ENOENT`, `spawn claude ENOENT`, `ELECTRON_RUN_AS_NODE`, global CLI fallback, or Electron-as-Node runtime errors.
