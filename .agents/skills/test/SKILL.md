---
name: test
description: Run the right tests for what you changed. Auto-detects which test suites to run based on changed files. Use after making changes to verify nothing broke.
argument-hint: "[all|backend|agent-server|rust|--watch]"
---

Run the appropriate tests for the current changes.

## Context

Changed files:
!`git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null`

## Auto-detection rules

Based on what files changed, run the right test suite:

| Files changed                | Command                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `backend/**`                 | `bun run test:backend`                                  |
| `agent-server/**`            | `bun run test:agent-server:unit`                        |
| `src-tauri/**`               | `cargo test --manifest-path src-tauri/Cargo.toml --lib` |
| `src/**` (frontend)          | `bun run typecheck` (no unit tests for frontend yet)    |
| `package.json` or `bun.lock` | `bun install --frozen-lockfile` first                   |
| Multiple layers              | Run each relevant suite                                 |
| Can't determine              | Run `bun run test` (all)                                |

## Explicit overrides

If the user specified an argument, use it instead of auto-detection:

- `all` → `bun run test` + `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `backend` → `bun run test:backend`
- `agent-server` → `bun run test:agent-server:unit`
- `rust` → `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `e2e` → `bun run test:agent-server:e2e`
- `--watch` → append `:watch` to the relevant command

## Process

1. Detect which files changed
2. Map to the right test suites
3. Run them sequentially
4. Report results clearly: pass count, fail count, and any failure details
5. If tests fail, show the relevant error output and suggest a fix

$ARGUMENTS
