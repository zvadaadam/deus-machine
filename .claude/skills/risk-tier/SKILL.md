---
name: risk-tier
description: Classify changed files by risk tier and compute required checks. Use when preparing a PR, assessing change impact, or deciding what to test. Triggers on "risk tier", "risk assessment", "what tests do I need", "change impact".
allowed-tools: Bash(git *)
argument-hint: "[branch]"
---

Analyze the current changes and classify them by risk tier. Output what checks are required before merge.

## Risk tier definitions

### Tier 1 — Critical (database, core infra, agent communication)

Paths:

- `backend/src/lib/schema.ts` — database schema, all indexes and triggers
- `backend/src/lib/database.ts` — database connection and initialization
- `agent-server/db/schema.ts` — agent-server's schema mirror
- `agent-server/db/index.ts` — agent-server database access
- `src-tauri/src/main.rs` — app initialization and lifecycle
- `src-tauri/src/lib.rs` — module exports
- `src-tauri/src/socket*.rs` — agent-server socket relay
- `src-tauri/src/process*.rs` — process lifecycle management
- `agent-server/index.ts` — agent-server entry point
- `agent-server/rpc-connection.ts` — JSON-RPC communication
- `agent-server/protocol.ts` — shared message types

Required checks:

- `bun run typecheck`
- `bun run test` (all backend + agent-server tests)
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `bun run build:agent-server` (verify agent-server builds)
- Manual smoke test of app startup
- Code review by senior developer

### Tier 2 — High (business logic, data flow, git operations)

Paths:

- `backend/src/routes/**` — REST API endpoints
- `backend/src/services/**` — business logic services
- `backend/src/middleware/**` — request middleware
- `agent-server/agents/**` — agent handlers (Claude, Codex)
- `agent-server/frontend-client.ts` — frontend notifications
- `src-tauri/src/git.rs` — git operations (libgit2)
- `src-tauri/src/commands/**` — Tauri IPC command handlers
- `src/platform/**` — platform abstraction layer (Tauri IPC, socket)
- `src/features/*/api/**` — feature query hooks and services

Required checks:

- `bun run typecheck`
- `bun run test:backend`
- `bun run test:agent-server`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- Code review

### Tier 3 — Medium (UI features, state management)

Paths:

- `src/features/*/ui/**` — feature UI components
- `src/features/*/store/**` — Zustand stores
- `src/shared/**` — shared components
- `src/global.css` — global styles and design tokens
- `src/app/**` — app shell, routing, providers

Required checks:

- `bun run typecheck`
- `bun run format:check`
- Visual verification in browser

### Tier 4 — Low (docs, config, tests, static assets)

Paths:

- `src/components/ui/**` — Shadcn base components (low risk but high usage)
- `*.md` — documentation
- `*.json` — config files (except schema/db)
- `**/*.test.*` — test files
- `**/*.stories.*` — storybook stories
- `.github/**` — CI workflows
- `.claude/**` — Claude Code configuration

Required checks:

- `bun run typecheck` (if .ts/.tsx)
- `bun run format:check`

## Process

1. **Gather changes**: Run `git diff --name-only $ARGUMENTS` (default: compare against main branch using `git diff --name-only main...HEAD`)
2. **Classify each file**: Map every changed file to its risk tier
3. **Compute highest tier**: The overall PR risk is the highest tier among all changed files
4. **List required checks**: Output the union of all required checks for the highest tier
5. **Flag cross-boundary changes**: Warn if changes span both Rust and Node.js, or both backend and agent-server — these need extra attention

## Output format

```
## Risk Assessment

Overall risk: Tier X — [Critical|High|Medium|Low]

### Changed files by tier

**Tier 1 (Critical):**
- path/to/file.ts — reason

**Tier 2 (High):**
- path/to/file.ts — reason

**Tier 3 (Medium):**
- path/to/file.ts — reason

**Tier 4 (Low):**
- path/to/file.ts — reason

### Required checks before merge

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] ...

### Warnings

- Cross-boundary changes detected: [details]
- Schema changes require both backend and agent-server schema sync
```

$ARGUMENTS
