# prelaunch-hardening Notes

Append-only audit trail for the prelaunch-hardening mega-goal.

## Proposed additions

## 2026-05-18 15:51 CEST - Sub-goal 01 implementation pass

- Replaced the replayed schema migration array with an explicit pre-launch reset policy in `shared/schema.ts`.
- Added backend startup validation for required table/column shape after `SCHEMA_SQL`; stale local DBs now fail fast with a reset hint instead of silently replaying migration baggage.
- Removed migration replay from backend persistence tests and the backend CLI.
- Documented the local DB reset path in `DEVELOPMENT.md`.
- Updated the schema unit tests to assert the pre-launch policy, no `ALTER TABLE`/`DROP COLUMN` in `SCHEMA_SQL`, and required final columns.
- Fixed a macOS `/var` versus `/private/var` realpath-sensitive backend runtime test while running the full backend suite.
- Verification so far: `bun install --frozen-lockfile` passed; `bun run typecheck:backend` passed; targeted backend schema/persistence/runtime tests passed; `bun run test:backend` passed with 48 files and 640 tests; `bun run typecheck` passed.

## 2026-05-18 15:56 CEST - Sub-goal 01 closure

- Review pass found one stale-DB edge case: an old table shape could make `SCHEMA_SQL` fail while creating indexes before the required-column validator ran.
- Fixed that path by wrapping schema initialization failures in the same pre-launch reset hint and by clearing the cached SQLite handle after failed startup.
- Added `apps/backend/test/unit/lib/database.test.ts` to prove fresh DB bootstrap and stale pre-launch DB reset behavior.
- Final verification: `bun run typecheck` passed; targeted database/schema/persistence tests passed with 17 tests; `bun run test:backend` passed with 49 files and 642 tests; Prettier check passed for touched files; stale migration symbol scan passed with no matches.
- Review status: clean after the stale-DB fix.
- Roadmap: checked sub-goal 01 only.

## 2026-05-18 16:01 CEST - Sub-goal 02 closure

- Baseline `bun run lint` failed before the change: the old gate only targeted `apps`, excluded `apps/backend`, `apps/agent-server`, and `shared`, and still had 3 React compiler-rule errors plus warning debt.
- Reworked `eslint.config.mjs` into environment-specific flat-config sections:
  - TypeScript coverage for `apps`, `packages`, `shared`, `scripts`, and `test`.
  - React/browser rules only for `apps/web` and `apps/landing`.
  - Worker globals for `apps/cloud-relay`.
  - Vitest globals for tests.
  - JS/CJS script/config coverage with Node globals and CJS source type where needed.
- Updated `package.json` `lint` and `lint:fix` to scan `apps packages shared scripts test` with TS, TSX, JS, CJS, and MJS extensions.
- Ignored generated output paths rather than whole source applications; removed obsolete `/* eslint-env browser */` comments that flat config warns about.
- Existing debt is now surfaced as warnings instead of being hidden by directory-level ignores. Current widened lint result: 0 errors, 430 warnings.
- Final verification: `bun run lint` passed; `bun run typecheck` passed; `bun run test:backend` passed with 49 files and 642 tests; `bun run test:agent-server` passed with 26 files and 421 tests, with 1 skipped file / 14 skipped tests; Prettier check passed for touched static-gate files.
- Review status: clean.
- Roadmap: checked sub-goal 02.

## 2026-05-18 16:14 CEST - Sub-goal 03 closure

- Replaced the frontend `navigator.platform` simulator gate with a backend-reported `simulatorCapabilities` q:request resource.
- Backend capability now checks the actual backend execution side: macOS platform, Xcode `simctl` availability, and whether the current WS connection is relay-tunneled.
- Local desktop/local web on a capable Mac report the existing `localhost` stream transport; relay clients report an unavailable stream instead of receiving a useless localhost URL.
- `sim:start` now receives connection context and rejects unavailable simulator capability before spawning a stream.
- The simulator tab and persistent panel now require the experimental setting plus backend stream capability; the Experimental settings row shows the backend unavailable reason and prevents enabling simulator when unavailable.
- Removed the obsolete `nativeSimulator` frontend capability and verified no `nativeSimulator` / `isMacPlatform` simulator gate references remain.
- Added focused coverage for capability resolution, relay command rejection, and content tab gating.
- While running the full root test script, fixed stale tests that targeted removed/old frontend APIs: deleted the removed chat-insert store test, updated workspace-store tests to the current selected-id store, and moved subagent message-list tests to the current parts renderer contract.
- Final verification: `bun run typecheck` passed; `bun run lint` passed with the known 430 warnings and 0 errors; `bun run test` passed, covering backend (51 files / 647 tests), agent-server (26 files / 421 tests, plus 1 skipped file / 14 skipped tests), and root web/runtime tests (28 files / 210 tests).
- Review status: clean.
- Roadmap: checked sub-goal 03.

## 2026-05-18 16:17 CEST - Sub-goal 04 closure

- Picked `apps/backend/src/services/query-engine.ts` from the audit's high-risk large-module list because it mixed subscription state, one-shot request delegation, command dispatch, mutations, query snapshots, and invalidation.
- Extracted request-only dispatch into `apps/backend/src/services/query-request-dispatcher.ts`, keeping existing Hono route delegation and `ts-pattern` exhaustive matching intact.
- Left `query-engine.ts` responsible for protocol framing, connection context, subscriptions, commands, mutations, and invalidation; request transport context is now passed into the extracted dispatcher.
- Added `apps/backend/test/unit/services/query-request-dispatcher.test.ts` to prove relay connection context reaches the simulator capability request after the split.
- Query-engine size after extraction: 717 lines; extracted request dispatcher: 102 lines.
- Final verification: focused dispatcher/simulator tests passed with 6 tests; `bun run typecheck` passed; `bun run lint` passed with the known 430 warnings and 0 errors; `bun run test` passed, covering backend (52 files / 648 tests), agent-server (26 files / 421 tests, plus 1 skipped file / 14 skipped tests), and root web/runtime tests (28 files / 210 tests).
- Review status: clean.
- Roadmap: checked sub-goal 04.

## 2026-05-18 16:17 CEST - Sub-goal 05 final ship gate

- Re-read `ROADMAP.md`, `NOTES.md`, and every sub-goal file (`01` through `05`) against the current worktree.
- Confirmed sub-goals 01-04 are checked and have current verification evidence matching each `Done =` line.
- Final verification evidence is current:
  - `bun run typecheck` passed.
  - `bun run lint` passed with the known widened-gate debt: 430 warnings, 0 errors.
  - `bun run test` passed: backend 52 files / 648 tests; agent-server 26 files / 421 tests with 1 skipped file / 14 skipped tests; root web/runtime 28 files / 210 tests.
  - `git diff --check` passed.
  - Stale migration symbol scan passed with no matches.
  - Simulator frontend platform-gate scan passed for app/shared/test code; the only `nativeSimulator` / `isMacPlatform` mention is this audit trail.
- Deferred work explicitly logged:
  - Existing lint debt remains warning-level by design after sub-goal 02 widened coverage; the gate now exposes it instead of hiding whole applications.
  - Relay simulator streaming remains unavailable by design until a proxied stream/frame path is built; sub-goal 03 makes this an explicit backend capability result instead of returning client-local localhost URLs.
  - Post-launch versioned migrations remain deferred until external users depend on persisted local data; pre-launch stale DBs use the documented reset path.
- Review status: clean.
- Roadmap: checked sub-goal 05.

## 2026-05-18 17:22 CEST - Deslop pass

- Reduced schema stale-DB validation from a duplicated all-column manifest to only the known pre-launch compatibility breakpoints.
- Flattened simulator capabilities from nested stream transport metadata to the single availability answer the UI and commands need today.
- Simplified simulator tab gating from a generic runtime gate string to a direct `requiresSimulator` flag.
- Verification after cleanup: `bun run typecheck` passed; targeted backend tests passed with 5 files / 11 tests; content-tab test passed with 1 file / 2 tests; `bun run lint` passed with the known 430 warnings and 0 errors.
