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

- `shared/schema.ts` — database schema, all indexes and triggers (single source of truth)
- `apps/backend/src/lib/database.ts` — database connection and initialization
- `apps/desktop/main/index.ts` — app initialization and lifecycle
- `apps/desktop/main/backend-process.ts` — backend process lifecycle management
- `apps/desktop/main/native-handlers.ts` — Electron IPC command handlers
- `apps/agent-server/index.ts` — agent-server entry point
- `apps/agent-server/rpc-connection.ts` — JSON-RPC communication
- `apps/agent-server/protocol.ts` — shared message types

Required checks:

- `bun run typecheck`
- `bun run test` (all backend + agent-server tests)
- `bun run build:agent-server` (verify agent-server builds)
- Manual smoke test of app startup
- Code review by senior developer

### Tier 2 — High (business logic, data flow, git operations)

Paths:

- `apps/backend/src/routes/**` — REST API endpoints
- `apps/backend/src/services/**` — business logic services
- `apps/backend/src/middleware/**` — request middleware
- `apps/agent-server/agents/**` — agent handlers (Claude, Codex)
- `apps/agent-server/event-broadcaster.ts` — canonical event fan-out to backend
- `apps/desktop/main/browser-views.ts` — BrowserView management
- `apps/web/src/platform/**` — platform abstraction layer (Electron IPC, WebSocket)
- `apps/web/src/features/*/api/**` — feature query hooks and services

Required checks:

- `bun run typecheck`
- `bun run test:backend`
- `bun run test:agent-server`
- Code review

### Tier 3 — Medium (UI features, state management)

Paths:

- `apps/web/src/features/*/ui/**` — feature UI components
- `apps/web/src/features/*/store/**` — Zustand stores
- `apps/web/src/shared/**` — shared components
- `apps/web/src/global.css` — global styles and design tokens
- `apps/web/src/app/**` — app shell, routing, providers

Required checks:

- `bun run typecheck`
- `bun run format:check`
- Visual verification in browser

### Tier 4 — Low (docs, config, tests, static assets)

Paths:

- `apps/web/src/components/ui/**` — Shadcn base components (low risk but high usage)
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
5. **Flag cross-boundary changes**: Warn if changes span both Electron main and Node.js backend, or both backend and agent-server — these need extra attention

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
- Schema changes require backend schema + query invalidation review (shared/schema.ts, query-engine, agent-event-handler)
```

$ARGUMENTS
