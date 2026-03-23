---
name: Mobile Layout Patterns
description: Patterns and anti-patterns confirmed in the mobile web layout implementation (MobileLayout, MobileTabBar, MainContent mobile path)
type: project
---

## Mobile Layout Architecture (PR: mobile web support)

- `useIsMobile()` returns `!!isMobile` where `isMobile` starts as `undefined` (SSR-safe). On initial
  hydration before the effect runs, `!!undefined === false` — the desktop layout flashes for one frame
  before switching to mobile. Not a bug for a desktop Electron app, but visible in web-only mode.

- `MobileLayout` has `key={selectedWorkspace.id}` at its call site in `MainContent.tsx` — React
  remounts the component on workspace switch, resetting `activeTab` to "chat" automatically.

- `MobileTab` type is defined once in MobileTabBar.tsx and imported in MobileLayout.tsx via
  `import type { MobileTab } from "./MobileTabBar"`.

- `WorkspaceHeader` receives `mobile` prop which gates: TaskStrip rendering, Open button, max-width
  truncation values. `onStatusChange` is intentionally omitted in MobileLayout (not a bug — status
  menu is a lower-priority feature for mobile).

- `AllFilesDiffViewer` in MobileLayout passes `hideHeader` prop to suppress the header bar
  (including the close button), avoiding the confusing no-op UX.

- `MobileTabBar` uses `h-12` (48px) container with `pb-[env(safe-area-inset-bottom)]`. When
  `safe-area-inset-bottom` is non-zero (iPhone home indicator), the content inside the 48px bar
  is compressed by the padding. Fix: add the safe-area inset to the height, not just as padding:
  `min-h-12 h-[calc(3rem+env(safe-area-inset-bottom))]`. The viewport meta already has
  `viewport-fit=cover` so the inset value is non-zero on notched devices.

- `MobileTabBar` has proper ARIA semantics: `role="tablist"` on wrapper, `role="tab"` +
  `aria-selected` + `aria-controls` + `id` on each button, roving `tabIndex`. Panels have
  `aria-labelledby` linking back to tab buttons.

- Active tab color: `text-text-secondary` (darker) for active, `text-text-muted` (lighter) for
  inactive. The primary color is NOT used for the active state — differs from the desktop ContentTabBar
  which uses `text-text-secondary` + `bg-bg-raised`. Acceptable but inconsistent.

- The `useMemo` on `fileChanges` (MobileLayout.tsx line 63) correctly memoizes the array reference
  from `fileChangesData?.files` — prevents `AllFilesDiffViewer` from re-rendering on every parent
  render when `fileChangesData` object identity changes.

- Mobile layout uses always-mounted tab panels with CSS `hidden` class (Tailwind `display: none`)
  to preserve `ChatArea` WebSocket connections and state across tab switches. Do NOT switch to
  HTML `hidden` attribute — both produce `display: none` but CSS class is idiomatic in React/Tailwind.

- `drag-region` class is on `WorkspaceHeader`'s root div — harmless on mobile web because
  `useWindowDragZone` guards with `capabilities.nativeWindowChrome` before injecting the CSS.

- Double `setup_status === "failed"` guard: `MainContent` already conditionally passes
  `onRetrySetup` and `onViewSetupLogs` as `undefined` when not failed, and `MobileLayout` re-guards
  them again before passing to `WorkspaceHeader`. The double guard is redundant but not harmful.
  **Why:** MobileLayoutProps declares both as `optional` and the component guards them again — this
  creates confusion about who owns the guard logic.
