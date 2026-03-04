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

## Session/Event Cache Architecture (Fragile Area)
- Three places do incremental fetch+merge: onSettled, catch-up mount, message event handler
- Workspace list cache updated by: onMutate (optimistic), useSessionEvents (invalidate), useGlobalSessionNotifications (setQueriesData)
- session:status-changed listened by BOTH useSessionEvents (per-session) and useGlobalSessionNotifications (global) -- duplication risk
- session detail invalidated on EVERY message event despite status events handling transitions
- Missing rollback: workspace list cache not restored in onError
- Event name mapping (JSON-RPC -> Tauri) hardcoded in socket.rs, no shared constant with frontend
- `notifyBackend` + `FrontendClient.sendStatusChanged` = dual notification path (backend HTTP broadcast + Tauri event)
- ChatTabIcon creates per-tab useSession subscriptions -- could use workspace list data instead

## Review Infrastructure
- Reviews go to `.context/reviews/review-NN.md`
- review-01: 2026-02-21, review-02: 2026-03-03 (session cache/event review)
