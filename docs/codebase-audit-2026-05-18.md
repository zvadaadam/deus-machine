# Codebase Audit - 2026-05-18

## Scope And Method

Objective: inspect the codebase in depth, identify unnecessarily complex, hard-to-maintain, bug-prone, or anti-pattern code, and propose three concrete fixes.

Coverage evidence:

- Enumerated source files with `rg --files`, excluding generated/build folders. The repository contains roughly 923 TypeScript/TSX files under `apps`, `packages`, and `shared`, totaling about 143k lines.
- Reviewed the project rules in `AGENTS.md`. The referenced `.claude/skills/deus-code-style/` directory is not present in this checkout.
- Read root config and contracts: `package.json`, `eslint.config.mjs`, `tsconfig*.json`, `shared/events.ts`, `shared/schema.ts`, and key shared types.
- Scanned the full source tree for high-risk patterns: destructive migrations, lint exclusions, `any`, `eslint-disable`, polling/timers, WebSocket/query protocol usage, platform gates, raw HTML injection, hardcoded colors, shell/process operations, and large files.
- Focus-read representative high-risk modules in each major area:
  - Web: browser panel, simulator panel/streaming, markdown/file rendering, query protocol, platform capabilities.
  - Backend: database bootstrap, query engine, simulator context, agent commands, route delegation.
  - Agent server: RPC connection, event broadcaster, harness adapters.
  - Desktop: preload/main native IPC surface.
  - Packages: device-use, pencil, screen-studio via broad scans and selected reads.
  - Tests: migration tests, persistence tests, RPC/event broadcaster tests.

## Fix 1 - Make Pre-Launch Schema Evolution Explicit

Finding:

Before the pre-launch cleanup, `shared/schema.ts` defined a replayed migration array that ran after `SCHEMA_SQL` on every backend startup. The array included destructive schema operations:

- renaming the old session harness column
- dropping the old session model column

Evidence:

- `shared/schema.ts:20` started the migration array.
- `shared/schema.ts:46` renames `sessions.agent_type`.
- `shared/schema.ts:49` drops `sessions.model`.
- `apps/backend/src/lib/database.ts:40-55` executed `SCHEMA_SQL`, then replayed every migration on every startup and swallowed only expected duplicate/missing-column errors.
- `apps/backend/test/unit/shared/schema.test.ts` encoded missing-column migration failures as acceptable.

Why this is risky:

- For a launched product, this would conflict with the repo rule in `AGENTS.md`: deprecated columns should be renamed with a `DEPRECATED_` prefix, never dropped.
- For this pre-launch product, the larger risk is policy confusion: the code looked like a post-launch migration system while the team actually wants direct schema updates and local DB resets.
- Replaying an unordered plain array forever makes migrations harder to reason about. A future migration can accidentally depend on a previous swallowed failure.
- The current tests encode the destructive behavior as acceptable rather than preventing it.

Proposed fix:

1. Treat `SCHEMA_SQL` as the pre-launch source of truth.
2. Remove replayed migration baggage and fail fast when a stale local DB does not match the current schema.
3. Document the reset path: delete `deus.db` or point `DATABASE_PATH` at a fresh file.
4. Defer versioned, non-destructive migrations until launch or until external testers depend on preserved local data.

Expected impact:

- Lower startup migration risk.
- A schema policy that matches the product stage.
- A clean handoff point for introducing real migrations later.

## Fix 2 - Restore Lint And Static Quality Coverage For Backend, Agent-Server, Shared, And Packages

Finding:

The lint configuration and lint script leave a large part of the codebase outside ESLint coverage.

Evidence:

- `package.json` has `lint: "eslint apps --ext .ts,.tsx"`.
- `eslint.config.mjs:7` explicitly ignores `apps/backend`, `apps/agent-server`, and `shared`.
- Static file counts from this checkout:
  - `apps`, `packages`, and `shared`: about 923 TS/TSX files / 143k lines.
  - `apps/backend`, `apps/agent-server`, `shared`, and `packages`: about 418 TS/TSX files / 79k lines.
- These skipped areas contain the highest-risk code: SQLite writes, process spawning, JSON-RPC, agent harnesses, WebSocket transport, and shared protocol/schema contracts.
- Root `tsconfig.web.json` also disables `noUnusedLocals` and `noUnusedParameters`, so typecheck is not compensating for dead-code and unused-symbol drift in the frontend.

Why this is risky:

- Backend and agent-server changes can introduce unused state, unsafe `any`, missing hook-like cleanup patterns in tests/utilities, or accidental promise handling issues without any lint signal.
- Shared contracts are the exact place where drift is most expensive because frontend, backend, and agent-server all depend on them.
- The repo already has many targeted tests, but tests do not replace static checks for broad maintainability patterns.

Proposed fix:

1. Split ESLint config by environment instead of ignoring whole applications:
   - Browser/React config for `apps/web` and `apps/landing`.
   - Node config for `apps/backend`, `apps/agent-server`, `apps/desktop/main`, `apps/cli`, scripts, and packages.
   - Shared config for `shared/**/*`.
2. Update `lint` to cover `apps packages shared scripts test`, with scoped rule overrides where necessary.
3. Start with warning-level gates for existing debt, but make new hard failures for:
   - `no-floating-promises` or a local equivalent for async side effects.
   - `no-explicit-any` in production source except documented adapter boundaries.
   - unused vars/imports in shared/backend/agent-server.
4. Add a CI or local check that verifies the lint target set includes `shared`, `apps/backend`, and `apps/agent-server`.

Expected impact:

- Makes quality gates match the architectural risk of the repo.
- Reduces shared-contract drift.
- Prevents new technical debt while allowing staged cleanup of existing warnings.

## Fix 3 - Make Simulator Availability A Backend Capability, Not A Browser Platform Guess

Finding:

Simulator UI availability is currently derived from the frontend browser platform, while the actual simulator capability depends on the backend host and streaming transport.

Evidence:

- `apps/web/src/platform/capabilities.ts:22-36` sets `nativeSimulator` from `navigator.platform` matching Mac.
- `apps/web/src/app/layouts/ContentView.tsx:85-93` mounts `SimulatorPanel` whenever `capabilities.nativeSimulator` is true.
- `apps/web/src/features/simulator/api/simulator.service.ts:1-9` says simulator commands work identically in desktop and web/relay mode through q:command.
- `apps/backend/src/services/simulator-context.ts:7-9` says it works in relay/web mode, but immediately has `TODO(relay-streaming): Add MJPEG frame proxy for web/relay mode`.
- `apps/backend/src/services/simulator-context.ts:651` emits a direct `http://localhost:${port}/stream.mjpeg` URL.
- `apps/web/src/features/simulator/ui/SimulatorStreamViewer.tsx:17-24` documents that relay/web mode cannot directly access that MJPEG URL and needs q:event frame proxying.
- `apps/web/src/features/simulator/ui/SimulatorStreamViewer.tsx:272-308` loads `streamUrl` directly into an offscreen `Image`.

Why this is risky:

- A plain web client running on macOS can show simulator UI even when the backend host/relay path cannot provide a usable local MJPEG stream.
- A remote web client connected to a Mac backend can receive `http://localhost:<port>/stream.mjpeg`, but that localhost points at the client machine, not the backend machine.
- The comments and capability model disagree, making future work likely to preserve the wrong assumption.

Proposed fix:

1. Add a backend capability resource or include capabilities in the existing settings/status snapshot:
   - `simulator.available`
   - `simulator.reason`
   - `simulator.streamingMode: "direct-mjpeg" | "ws-frames" | "unavailable"`
   - host OS and required binary/Xcode checks.
2. Gate the simulator tab and panel from that backend capability, not `navigator.platform`.
3. Either implement the relay frame proxy described in `SimulatorStreamViewer.tsx`, or explicitly mark relay streaming unavailable until it exists.
4. Update comments in `simulator.service.ts` and `simulator-context.ts` so they describe the actual supported transports.
5. Add tests for:
   - Mac desktop/local backend shows simulator with direct MJPEG.
   - Mac web client without direct backend stream does not show the panel or shows a clear unavailable state.
   - Relay mode does not emit unusable client-local `localhost` stream URLs unless a proxy path is active.

Expected impact:

- Prevents a user-visible broken simulator tab in web/relay contexts.
- Makes the capability model honest and easier to extend.
- Removes a class of platform-condition bugs caused by checking the client platform instead of the service host.

## Secondary Observations

- Several modules are large enough to slow maintenance: `BrowserPanel.tsx` (~1268 lines), `simulator-context.ts` (~1154 lines), `HomeView.tsx` (~1080 lines), `SimulatorPanel.tsx` (~985 lines), and `query-engine.ts` (~777 lines). These are not automatically bugs, but they are good candidates for follow-up extraction once the three higher-leverage fixes above are addressed.
- Raw HTML insertion exists in markdown/file rendering paths, but the reviewed code generally routes generated highlighter HTML through known highlighters or a sanitizer. I would not prioritize this over the three findings above without a targeted security review.
- The dependency install is absent in this checkout, so I could not run the configured lint binary. That does not affect the config finding; it does mean this report relies on source inspection and static shell scans rather than live ESLint output.

## Suggested Order

1. Fix migrations first because they can affect real user data.
2. Expand lint/static coverage next so future backend/shared fixes are cheaper and safer.
3. Correct simulator capability/transport semantics before investing further in simulator UI.
