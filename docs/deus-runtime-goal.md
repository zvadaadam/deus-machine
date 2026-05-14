# Deus Runtime `/goal` Handoff

Paste this into `/goal` from `/Users/zvada/conductor/workspaces/deus-machine/whitehorse`.

```text
Implement the native packaged runtime described by this file. Turn packaged macOS Deus into a Conductor-style runtime: the app starts backend and agent-server through one bundled executable, `Resources/bin/deus-runtime`, and resolves bundled native CLIs from `Resources/bin`: `codex`, `claude`, `gh`, `rg`. Packaged runtime must not depend on global Node, Bun, Homebrew, inherited shell PATH, Electron-as-Node, or global CLI discovery.

Inspiration/reference:
- Conductor bundle: `/Applications/Conductor.app/Contents/Resources/bin`. Inspect with `file`, `otool -L`, `codesign -dv`, `strings`. Use as shape inspiration, not code to copy; it ships `conductor-runtime` plus shims and native CLIs.
- OpenCode local clone: `.context/reference-opencode`; upstream `https://github.com/anomalyco/opencode`. Use desktop server/sidecar readiness, health, timeout, bounded stop, and smoke patterns.
- T3Code local clone: `.context/reference-t3code`; upstream `https://github.com/pingdotgg/t3code`. Use backend manager, staged artifact build, and desktop smoke patterns.

Start with `scripts/runtime/*`, `shared/lib/cli-path.ts`, `apps/agent-server/agents/environment/cli-discovery.ts`, `electron-builder.yml`, `apps/desktop/main/backend-process.ts`, and `apps/backend/src/runtime/agent-process.ts`.

Scope:
- macOS packaged runtime first; preserve dev and web mode; be explicit for unstaged Linux/Windows packaged runtime.
- Build `deus-runtime` with `bun build --compile`, with `--version`/self-test and a manifest proving arch and packaged executables.
- Make `deus-runtime agent-server` print `LISTEN_URL`; make `deus-runtime backend` print `[BACKEND_PORT]` and own agent-server startup cleanly.
- Migrate packaged Electron/backend spawning to `deus-runtime`.
- Package `deus-runtime`, `codex`, `claude`, `gh`, `rg` into `Resources/bin` and validate app bundle contents.
- Keep explicit developer/user CLI override paths, but packaged defaults must be bundled binaries only.
- Delete obsolete packaged Electron-as-Node/global discovery fallback after proof.
- Do not redesign UI, change provider features, remote access, DB schema, or keep two permanent runtime stacks.

Work in small reviewable commits with focused verification notes. Verify incrementally with the smallest relevant checks, then periodically run:
`bun run build:runtime`
`bun run validate:runtime`
`bun run prepare:agent-clis`
`bun run prepare:gh-cli`
`bun run typecheck`
`bun run typecheck:backend`
`bun run typecheck:agent-server`

Direct smokes before done:
- `dist/runtime/electron/bin/<runtime-key>/deus-runtime --version`
- `deus-runtime agent-server` reaches `LISTEN_URL`
- `deus-runtime backend` reaches `[BACKEND_PORT]` with temp data dir
- `bun run package:mac` or narrow electron-builder command exercising hooks; inspect `.app/Contents/Resources/bin` for executable `deus-runtime`, `codex`, `claude`, `gh`, `rg`
- CUA packaged Electron smoke if available; confirm no `ENOENT`, global CLI, or Electron-as-Node errors.

Done: packaged macOS Deus launches backend and agent-server via bundled `deus-runtime`, resolves Codex/Claude from bundled binaries by default, passes runtime/package/typecheck/CUA verification, and old packaged Electron-as-Node/global CLI discovery code is removed.
```

## Exploration Notes

- Conductor 0.52.3 has a very small resource shape: `/Applications/Conductor.app/Contents/Resources/bin/{conductor-runtime,codex,claude,gh,watchexec,...}`. `internal`, `sidecar`, and `logger` are shell shims that exec `conductor-runtime <subcommand>`.
- Conductor's runtime binary is a signed arm64 Mach-O. `strings` shows Bun runtime internals, so the likely pattern is `bun build --compile` with command dispatch inside the executable.
- OpenCode's desktop app does not use a single compiled Bun runtime, but its sidecar protocol is useful: command messages, ready/error messages, migration progress, health checks, startup timeout, and bounded stop.
- T3Code still uses Electron-as-Node for backend startup, so it is not the target shape, but it has useful staged artifact building and smoke-test discipline.
- Local Bun supports `bun build --compile --outfile=<path> <entrypoint>`, plus `--compile-executable-path` for choosing a Bun executable during cross-compilation.

## Local References

These clones are intentionally in `.context` so they do not get committed:

- `/Users/zvada/conductor/workspaces/deus-machine/whitehorse/.context/reference-opencode`
- `/Users/zvada/conductor/workspaces/deus-machine/whitehorse/.context/reference-t3code`
- `/Users/zvada/conductor/workspaces/deus-machine/whitehorse/.context/deus-runtime-goal.md`
