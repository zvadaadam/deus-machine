# Code Reviewer Memory

## Key Architecture Patterns (Confirmed)

- `react-resizable-panels` uses percentage values for `collapsedSize`/`minSize` — pixel↔percent
  conversion via `panelGroupContainerRef` (excludes sidecar strip from container width math)
- `workspaceLayoutStore` uses `version: 7` migrations — increment version when adding persisted fields
- `cn()` uses `twMerge` internally — arbitrary `animate-[...]` classes conflict-resolve correctly
  (last wins), so conditional breathing override pattern with `cn()` works as intended
- `data-slot="resizable-panel"` is the CSS hook for the flex-grow transition in global.css

## Animation Patterns

- `strip-breathe` + `strip-settle` keyframes live in `global.css` (multi-component reuse)
- Single-component animations should use Framer Motion inline, NOT global.css keyframes
- `[animation-fill-mode:backwards]` survives twMerge when animate-[] class is replaced — benign
  but semantically imprecise on infinite animations

## Common Pitfalls Seen

- `useLayoutEffect` SSR warning: hook uses `typeof window` guard for SSR safety in `useState`
  initializer but `useLayoutEffect` itself has no SSR guard. Acceptable for Tauri desktop-only app.
- `safeCollapsedSize = Math.min(collapsedSizePct, MIN_PANEL_SIZE - 0.1)` guard pattern — ensures
  collapsedSize is always strictly less than minSize (react-resizable-panels requirement)
- Initial estimate `window.innerWidth * 0.65` in useState initializer is a rough heuristic —
  corrected synchronously by useLayoutEffect before paint

## CSS Architecture

- `transition: flex-grow` on `[data-slot="resizable-panel"]` — flex-grow IS animatable per CSS spec
- `window-resizing` class disables ALL layout transitions during native window resize
- `[data-resize-handle-active]` sibling/parent selector disables panel transitions during drag

## Distribution / CI Patterns

- `sed -i ''` is macOS/BSD syntax. On ubuntu-latest (GNU sed), use `sed -i "..."` (no empty-string arg). Scripts that use `sed -i ''` WILL fail in CI.
- Tauri updater `pubkey` must be set to the minisign public key string — empty string `""` disables signature verification entirely (security regression, also may break tauri-plugin-updater at runtime).
- `minimumSystemVersion` for arm64-only builds should be `"11.0"` — Apple Silicon Macs shipped with macOS 11.0; `"10.13"` is only valid for x86_64 Intel targets.
- `tauri-action@v0` needs `includeUpdaterJson: true` (or it defaults true when updater is configured) — verify latest.json is uploaded as a release asset alongside the DMG.
- `workflow_dispatch` without a branch filter can tag + push from any branch; restrict by adding `branches: [main]` under `on.workflow_dispatch` or add a guard step.
- The app spawns system `node` binary (not bundled) — hardened runtime notarization may need `com.apple.security.cs.disable-library-validation` in Entitlements.plist if node's dylibs fail team-ID checks.

## Icon Component Patterns (New)

- `AppIcon` registry pattern: static `APP_ICON_MAP` record maps appId → icon component function
- Category grouping uses `Set` for O(1) lookups in `getAppCategory()` and `groupAppsByCategory()`
- JetBrains family uses shared diamond shape with brand color prop — DRY approach for similar products
- SVG icons: 16x16 viewBox, use stroke + fill, no animations, all white inner shapes on colored rect backgrounds
- Icon components are pure (no state/hooks) — candidates for React.memo if used in frequently-rendering lists
