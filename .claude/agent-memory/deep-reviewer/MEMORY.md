# Deep Reviewer Memory

## Browser Automation Architecture
- Inject scripts live in `src/features/browser/automation/inject/` (TypeScript source)
- Compiled via esbuild to `dist-inject/` (IIFE format, gitignored)
- Consumer files import compiled output via Vite `?raw` imports
- Three independent scripts: `browser-utils` (`__hiveBrowserUtils`), `visual-effects` (`__hiveVisuals`), `inspect-mode` (`__hiveInspect`)
- Title-channel protocol uses `\x01` (SOH) prefix bytes -- verify hex dump, not text grep
- Build command: `bun run build:inject` (runs before dev/build)

## Common Patterns to Watch
- `waitForDomSettle` timer cleanup: ensure all timers are cleared on all exit paths
- Dead parameters: `slowly` in `buildTypeJs` is accepted but never used
- `data-hive-ref` is used for both tree snapshots and inspect mode element refs

## Review Infrastructure
- Reviews go to `.context/reviews/review-NN.md`
- First review was review-01 on 2026-02-21
