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
