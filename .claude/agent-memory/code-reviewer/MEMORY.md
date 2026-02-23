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

## Cross-Component Event Bus Pattern

- `window.dispatchEvent(new CustomEvent("insert-to-chat", { detail }))` is the established
  pattern for browser panel → chat input communication (both text and element insertion).
  The listener lives in `MainLayout.tsx` useEffect with no deps (stable ref via `workspaceChatPanelRef`).
- Multi-tab (ChatArea with multiple SessionPanel tabs): only ONE SessionPanel tab is assigned the
  ref at a time (last rendered wins via ref={workspaceChatPanelRef} directly on the component).
  Element insertion always goes to the currently-active chat tab. Acceptable current limitation.

## XML Attribute Serialization Risk Pattern

- `serializeInspectElement` in `parseInspectTags.ts` embeds user-controlled string values (innerText,
  path, tagName, reactComponent) into XML attribute values using double-quote delimiters with NO
  escaping. A `"` in any of these fields breaks `attrRegex = /(\w+)="([^"]*)"/g` parsing and
  corrupts the tag. Real DOM innerText can contain `"` (button labels, link text, etc.).
  Fix pattern: HTML-escape values before embedding in attributes.

## Icon Component Patterns (New)

- `AppIcon` registry pattern: static `APP_ICON_MAP` record maps appId → icon component function
- Category grouping uses `Set` for O(1) lookups in `getAppCategory()` and `groupAppsByCategory()`
- JetBrains family uses shared diamond shape with brand color prop — DRY approach for similar products
- SVG icons: 16x16 viewBox, use stroke + fill, no animations, all white inner shapes on colored rect backgrounds
- Icon components are pure (no state/hooks) — candidates for React.memo if used in frequently-rendering lists
