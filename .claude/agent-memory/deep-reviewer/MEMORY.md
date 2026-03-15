# Deep Reviewer Memory

## Browser Automation Architecture

- Inject scripts live in `src/features/browser/automation/inject/` (TypeScript source)
- Compiled via esbuild to `dist-inject/` (IIFE format, gitignored)
- Consumer files import compiled output via Vite `?raw` imports
- Three independent scripts: `browser-utils` (`__opendevsBrowserUtils`), `visual-effects` (`__opendevsVisuals`), `inspect-mode` (`__opendevsInspect`)
- Title-channel protocol uses `\x01` (SOH) prefix bytes -- verify hex dump, not text grep
- Build command: `bun run build:inject` (runs before dev/build)

## Common Patterns to Watch

- `waitForDomSettle` timer cleanup: ensure all timers are cleared on all exit paths
- Dead parameters: `slowly` in `buildTypeJs` is accepted but never used
- `data-opendevs-ref` is used for both tree snapshots and inspect mode element refs

## WebSocket Query Protocol Architecture (Post-Migration)

- All data subscriptions (workspaces, stats, sessions, session, messages) now use WS q:subscribe/q:snapshot/q:delta
- HTTP queryFn remains as fallback for initial load before WS connects
- `staleTime: Infinity` on all WS-subscribed queries -- relies on WS for freshness
- `useQuerySubscription` does NOT re-subscribe if WS connects after hook mounts -- latent bug
- Workspace cache updated by: onMutate (optimistic), WS q:snapshot/q:delta, useWorkspaceInitEvents (Tauri event for init progress)
- Session events (session:message, session:error, session:status-changed) as Tauri events are now DEAD -- Rust socket.rs still emits them but no frontend listener exists
- useGlobalSessionNotifications now observes React Query cache, not Tauri events
- query-engine.ts returns camelCase (hasOlder/hasNewer) vs HTTP snake_case (has_older/has_newer) -- field name mismatch bug
- dispatchInvalidation is a complete no-op (every resource branch is empty)
- `sendCommand` and `onEvent` in WS client are exported but never consumed
- `incrementalFetchAndMerge`, `mergeNewerMessages`, `getLastRealSeq` are dead code in messageCache.ts

## Review Infrastructure

- Reviews go to `.context/reviews/review-NN.md`
- review-01: 2026-02-21, review-02: 2026-03-03 (session cache/event review), review-03: 2026-03-15 (WS query protocol migration)
