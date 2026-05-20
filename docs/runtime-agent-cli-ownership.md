# Runtime and Agent CLI Ownership

This note records the current ownership boundaries for Deus runtime packaging and
agent CLI discovery. It is based on the source paths below, not on generated
`dist/runtime` output.

## Production Ownership

- `scripts/runtime/build.ts` is the release staging entrypoint for runtime
  payloads. It composes backend/agent-server bundles, native `deus-runtime`
  compilation, bundled Claude/Codex/agent-browser CLI staging, and GitHub CLI
  staging.
- `scripts/runtime/stage.ts` owns common runtime bundle staging and the top-level
  runtime manifest shape.
- `scripts/runtime/native-runtime.ts` owns native `deus-runtime` builds and
  their manifest.
- `scripts/runtime/agent-clis.ts` owns production Claude/Codex/agent-browser
  binary staging, static inspection, hashing, and the full `agent-clis.json`
  matrix. `scripts/runtime/prepare-dev-agent-clis.ts` is only a dev preflight:
  it may copy the host runtime key but must not rewrite the full packaging
  manifest.
- `scripts/prepare-gh-cli.mjs` owns GitHub CLI staging. Runtime validation checks
  it from `scripts/runtime/validate.ts`.
- `apps/runtime/index.ts` owns the compiled runtime executable command surface:
  `backend`, `agent-server`, `device-use`, and `self-test`. It also owns runtime
  env normalization for native runtime children.
- `shared/runtime.ts` owns shared runtime contracts that production and tests can
  depend on without importing packaging scripts: app ids, data filenames, staged
  runtime paths, runtime dependency list, and deterministic packaged system PATH
  entries.
- `shared/lib/cli-path.ts` owns runtime CLI path resolution at app runtime. It
  finds explicit bundled bin dirs, packaged resources, or dev-staged host bins,
  and intentionally refuses PATH fallback in packaged runtime mode.
- `apps/agent-server/agents/environment/cli-discovery.ts` owns agent-server CLI
  discovery behavior. It verifies explicit override paths, accepts bundled
  runtime binaries without re-running version checks, and reports usable paths to
  Claude/Codex harnesses.
- `apps/backend/src/runtime/agent-process.ts` owns backend-managed agent-server
  launch. In packaged runtime mode it launches `deus-runtime agent-server` and
  scrubs inherited runtime/dev env.
- `apps/desktop/main/runtime-env.ts` and `apps/desktop/main/backend-process.ts`
  own Electron main-process packaged runtime env and backend launch. Packaged
  desktop launches `deus-runtime backend`; development launches the built backend
  CJS bundle with host-staged CLIs.
- `apps/backend/src/services/aap/lifecycle.ts` owns AAP child process spawning.
  It routes packaged `device-use` launches through `deus-runtime device-use` so
  app manifests do not depend on Bun or global PATH.
- `scripts/prepare-device-use.mjs`, `electron-builder.yml`,
  `scripts/runtime/electron-builder-before-pack.cjs`, and
  `scripts/runtime/lib/device-use-payloads.cjs` own device-use package payload
  readiness and macOS helper assertions.

## Verification Ownership

- `scripts/runtime/validate.ts` is the static staging gate before packaging. It
  validates runtime manifests, native runtime binaries, staged agent CLIs, staged
  GitHub CLI payloads, and freshness of staged bundles.
- `scripts/runtime/smoke/` contains runtime smoke harnesses and smoke-only
  helpers. These scripts verify the production contract from the outside; they
  are not production ownership layers.
- Packaged runtime smoke must not load host native addons to prepare backend
  state. It creates temporary repos/workspaces through the packaged backend HTTP
  API so SQLite stays inside the runtime under test and does not depend on
  whether `better-sqlite3` was last rebuilt for Node or Electron.
- `scripts/prune-pencil-cli-binaries.cjs` is a packaging verifier/pruner for
  Electron app contents and native runtime payloads.

## Cleanup Boundaries

- Keep production payload staging under `scripts/runtime/`. Agent-server should
  discover and use CLIs, not stage or hash release binaries.
- Keep shared runtime contracts in `shared/runtime.ts` or `shared/lib/cli-path.ts`
  when they are consumed by production code across desktop, backend, runtime, and
  agent-server.
- Keep smoke-only helpers in `scripts/runtime/smoke/lib/`. Do not move them into
  production modules just to reduce lines.
- Keep script-local assertion copies, such as the smoke harness packaged PATH
  and env denylist, when they intentionally verify the production contract from
  the outside. Production runtime constants that are consumed by multiple app
  layers belong in `shared/runtime.ts`; Node-only smoke harnesses stay plain CJS
  so release checks do not need a TypeScript loader or a prior app build.
- Keep public package script names stable. Internal script file paths are not an
  API; CI and docs should call `bun run smoke:*` where practical.
- Do not reason from `dist/runtime` or `dist-electron` layout alone. Those are
  generated artifacts; source ownership lives in `shared/`, `apps/`, and
  `scripts/runtime/`.

## Script Map

| Path                                                | Class                 | Responsibility                                                                                                                            |
| --------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/runtime/build.ts`                          | build/stage           | Canonical runtime payload entrypoint for release and packaging.                                                                           |
| `scripts/runtime/stage.ts`                          | stage                 | Common backend and agent-server runtime bundle staging.                                                                                   |
| `scripts/runtime/native-runtime.ts`                 | build/validate        | Native `deus-runtime` binary build, manifest, architecture, signature, and optional runnable validation.                                  |
| `scripts/runtime/agent-clis.ts`                     | stage/validate        | Full bundled Claude/Codex/agent-browser CLI matrix, hashes, and manifest validation.                                                      |
| `scripts/runtime/prepare-agent-clis.ts`             | stage wrapper         | CLI wrapper for the production agent CLI matrix.                                                                                          |
| `scripts/runtime/prepare-dev-agent-clis.ts`         | dev-only stage        | Host-runtime-key agent CLI preflight for local dev; does not write the full packaging manifest.                                           |
| `scripts/runtime/validate.ts`                       | validate              | Static package-boundary gate for staged runtime, agent CLIs, native runtime, GitHub CLI, and freshness.                                   |
| `scripts/runtime/electron-builder-before-pack.cjs`  | package/validate      | Electron builder boundary guard for runtime staging, Electron output freshness, packaged main contract, and device-use payload readiness. |
| `scripts/runtime/package-mac-dir.cjs`               | package/smoke support | Local macOS `.app` directory package command for smoke verification without producing release DMGs.                                       |
| `scripts/runtime/dev.ts`                            | dev-only              | Development backend/frontend startup orchestration.                                                                                       |
| `scripts/runtime/rebuild-node-native.cjs`           | dev/test support      | Rebuilds Node ABI native modules before backend/dev tests.                                                                                |
| `scripts/runtime/unsupported-packaged-platform.cjs` | package guard         | Explicit unsupported-platform package command failure.                                                                                    |
| `scripts/runtime/gh-cli-contract.json`              | package contract      | Expected GitHub CLI version, archive hashes, and target matrix.                                                                           |
| `scripts/runtime/lib/device-use-payloads.cjs`       | package/smoke helper  | Shared device-use payload and simulator helper contract used by packaging guards and smokes.                                              |
| `scripts/runtime/smoke/*.cjs`                       | smoke                 | Source, native runtime, packaged resource, packaged app, packaged desktop, packaged runtime, and DMG smoke harnesses.                     |
| `scripts/runtime/smoke/lib/smoke-helpers.cjs`       | smoke helper          | Smoke-only process, runtime env, readiness, and packaged resource assertions.                                                             |
| `scripts/runtime/smoke/runtime-rpc.cjs`             | smoke helper          | Agent-server JSON-RPC assertions used by source/native/packaged smokes.                                                                   |
| `scripts/runtime/smoke/run-version-check.cjs`       | smoke helper          | Isolated executable version probe used by native runtime validation and packaged app smoke.                                               |
| `scripts/prepare-device-use.mjs`                    | build/stage           | Builds and stages `packages/device-use` bundles, frontend payload, skill, and native helpers.                                             |
| `scripts/prepare-gh-cli.mjs`                        | stage                 | Stages GitHub CLI binaries and manifest for packaged runtime bins.                                                                        |
| `scripts/prune-pencil-cli-binaries.cjs`             | package/validate      | Prunes duplicate package payloads and verifies packaged app/native runtime contents after pack.                                           |

## Structural Deferrals

- `apps/runtime/index.ts` remains a single runtime executable entrypoint for
  now. It owns argument parsing, environment normalization, self-test
  inspection, and command dispatch in one place; splitting before another
  command grows would add indirection without reducing release risk. The future
  split point is `apps/runtime/commands/` if `backend`, `agent-server`,
  `device-use`, or `self-test` need independent tests or materially larger
  command-specific logic.
- `scripts/runtime/agent-clis.ts` remains one module because target metadata,
  staging, manifest writing, and validation share one release matrix. The future
  split point is a small target catalog plus separate `stage-agent-clis` and
  `validate-agent-clis` modules if another bundled agent family or platform
  makes the file hard to review.
- Production build/stage/validate commands stay directly under
  `scripts/runtime/`; smoke harnesses live under `scripts/runtime/smoke/` so the
  package path and verification path are visually separate.

## Applied Cleanup

- Dev agent CLI preflight stages only the host runtime key and leaves the full
  `agent-clis.json` manifest unchanged. The full manifest remains owned by
  `bun run build:runtime`.
- Device-use packaged payload constants are shared by packaging guards and
  packaged app smoke checks via `scripts/runtime/lib/device-use-payloads.cjs`.
- Runtime smoke harnesses moved under `scripts/runtime/smoke/`; public
  `bun run smoke:*` commands remain the supported entrypoints.
- Desktop CLI lookup now reuses `shared/runtime.ts` packaged PATH entries and
  the packaged runtime env denylist from `apps/desktop/main/runtime-env.ts`
  instead of carrying a production-local copy.
- Packaged `device-use` runtime invocations force bundled helper paths, while
  source runtime invocations may still honor explicit helper overrides.
- AAP prefetch skips missing path-form entrypoints as optional prefetch work
  instead of logging an alarming startup failure for unbuilt optional apps.
- Packaged runtime smoke seeds AAP state through backend HTTP routes instead of
  host `better-sqlite3`, removing Node/Electron native ABI ordering from the
  smoke harness.
