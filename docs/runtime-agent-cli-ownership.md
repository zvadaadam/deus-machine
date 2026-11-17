# Runtime and Agent CLI Ownership

Where the packaged app's runtime and bundled CLIs come from, and what proves
each fact about them. Source paths, not `dist/runtime` or `dist-electron`
output, are the reference.

## What ships

`Resources/bin` holds `deus-runtime` (the backend, compiled by Bun), `gh`,
`codex` (with its package under `codex-runtime/`), `claude`, `rg` and
`agent-browser`. The list is `BUNDLED_BINARIES` in
`scripts/runtime/electron-builder-after-pack.cjs`; `electron-builder.yml`'s
filters copy the same names.

- `scripts/runtime/build.ts` (`bun run build:runtime`) stages everything under
  `dist/runtime`: the backend bundle (`stage.ts`, which the npm CLI ships too),
  `deus-runtime` for each target (`native-runtime.ts`, ad-hoc signed with
  `resources/entitlements.runtime.plist`), Claude Code and Codex as agent-server
  installs them at its pins, agent-browser from the lockfile
  (`agent-clis.ts`), and `gh` (`scripts/prepare-gh-cli.mjs`).
- Codex and Claude Code are version-locked: agent-server's `DEFAULT_PINS` name
  them and its installer checks each against its release table. Bump
  `@zvada/agent-server`, not a version here.
- `gh` is pinned by version and archive sha256 in
  `scripts/runtime/gh-cli-contract.json`.
- `scripts/runtime/prepare-dev-agent-clis.ts` stages the host's CLIs for
  `bun run dev` and `dev:web`.
- `apps/runtime/index.ts` is `deus-runtime`: `backend`, `self-test` and
  `--version`. Its folder is the bundled bin folder, the one above it the app's
  resources. Its `PATH` is that folder, then the system folders; the engine
  adds the login shell's entries after them
  (`apps/agent-server/agents/environment`), so agents and terminals reach the
  person's own tools (`node`, Homebrew) while the bundled CLIs come first.

## What proves it

Each fact is proved once, by the strongest check that can prove it.

| Fact                                                                                                                                                                                                                                          | Check                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Every bundled executable runs, from the packaged app                                                                                                                                                                                          | `smoke:packaged-runtime` runs each `--version` (macOS PR CI, the release's DMG copy, Linux PR CI) |
| The runtime opens a terminal, draws with the canvas, uses SQLite                                                                                                                                                                              | `deus-runtime self-test`, run by `smoke:packaged-runtime`                                         |
| The runtime starts the backend, the engine and its database                                                                                                                                                                                   | `smoke:packaged-runtime`                                                                          |
| The desktop's main process starts the backend and opens a window, from a copy with a fresh home                                                                                                                                               | `smoke:packaged-desktop`                                                                          |
| Every target's executables and canvas are built for it (the x64 app is never launched), Codex is the engine's pin and its aliases resolve inside its package, `deus-runtime` links only system libraries, the simulator helpers are universal | afterPack (`electron-builder-after-pack.cjs`), on the final layout of every target                |
| `deus-runtime` is signed with its entitlements and 4 KB pages                                                                                                                                                                                 | afterSign (`scripts/runtime/electron-builder-after-sign.cjs`)                                     |
| The app is signed, notarized and accepted by Gatekeeper; DMGs are stapled                                                                                                                                                                     | `release.yml`'s "Verify macOS artifacts"                                                          |
| The npm CLI installs and starts                                                                                                                                                                                                               | `smoke:cli-package`                                                                               |

`bun run package:mac:dir -- --arch <arm64|x64>` packages a macOS app directory
the way CI does, through the same hooks.
