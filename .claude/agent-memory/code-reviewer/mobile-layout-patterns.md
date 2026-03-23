---
name: Mobile Layout Patterns
description: Patterns and anti-patterns confirmed in the mobile web layout implementation (MobileLayout, MobileTabBar, MainContent mobile path)
type: project
---

## Mobile Layout Architecture (PR: mobile web support)

- `useIsMobile()` returns `!!isMobile` where `isMobile` starts as `undefined` (SSR-safe). On initial
  hydration before the effect runs, `!!undefined === false` — the desktop layout flashes for one frame
  before switching to mobile. Not a bug for a desktop Electron app, but visible in web-only mode.
  **Mitigation**: The `key` prop on MobileLayout in `MainContent.tsx` is missing — add `key={selectedWorkspace.id}` to reset `activeTab` state on workspace switch.

- `MobileLayout` has no `key` prop at its call site in `MainContent.tsx` (line 277). When the user
  switches workspaces, `activeTab` inside `MobileLayout` is NOT reset — user could be stuck on
  "code" tab when they switch to a new workspace. `ChatArea` inside does get `key={workspace.id}`.
  Fix: add `key={selectedWorkspace.id}` on the `<MobileLayout>` in MainContent.tsx.

- `MobileTab` type is defined twice (once in MobileTabBar.tsx, once in MobileLayout.tsx).
  Should be a shared export from one file.

- `WorkspaceHeader` receives `mobile` prop which gates: TaskStrip rendering, Open button, max-width
  truncation values. `onStatusChange` is intentionally omitted in MobileLayout (not a bug — status
  menu is a lower-priority feature for mobile).

- `AllFilesDiffViewer` in MobileLayout does NOT pass `hideHeader={false}` explicitly, so the
  header (file count + collapse-all + close) IS rendered in the mobile code view. The close button
  calls `onClose` which is `undefined` here — clicking it is a no-op (not a crash, but confusing UX).
  Fix: pass `hideHeader` to suppress the header bar, or pass `onClose={() => setActiveTab("chat")}`.

- `MobileTabBar` uses `h-12` (48px) container with `pb-[env(safe-area-inset-bottom)]`. When
  `safe-area-inset-bottom` is non-zero (iPhone home indicator), the content inside the 48px bar
  is compressed by the padding. Fix: add the safe-area inset to the height, not just as padding:
  `min-h-12 h-[calc(3rem+env(safe-area-inset-bottom))]`. The viewport meta already has
  `viewport-fit=cover` so the inset value is non-zero on notched devices.

- `MobileTabBar` tab buttons have no ARIA semantics. They are plain `<button>` elements with no
  `role="tab"`, `aria-selected`, or `aria-controls`. Should use `role="tablist"` on wrapper and
  `role="tab"` + `aria-selected` on each button.

- Active tab color: `text-text-secondary` (darker) for active, `text-text-muted` (lighter) for
  inactive. The primary color is NOT used for the active state — differs from the desktop ContentTabBar
  which uses `text-text-secondary` + `bg-bg-raised`. Acceptable but inconsistent.

- The `useMemo` on `fileChanges` (MobileLayout.tsx line 63) correctly memoizes the array reference
  from `fileChangesData?.files` — prevents `AllFilesDiffViewer` from re-rendering on every parent
  render when `fileChangesData` object identity changes.

- `handleCollapseChatPanel` in `MobileLayout` is implemented as a tab switch to "code" — this is
  semantically correct for mobile (there's no collapse, just a tab change). The `useCallback` dep
  array is empty, which is correct since `setActiveTab` is stable.

- `drag-region` class is on `WorkspaceHeader`'s root div — harmless on mobile web because
  `useWindowDragZone` guards with `capabilities.nativeWindowChrome` before injecting the CSS.

- Double `setup_status === "failed"` guard: `MainContent` already conditionally passes
  `onRetrySetup` and `onViewSetupLogs` as `undefined` when not failed, and `MobileLayout` re-guards
  them again before passing to `WorkspaceHeader`. The double guard is redundant but not harmful.
  **Why:** MobileLayoutProps declares both as `optional` and the component guards them again — this
  creates confusion about who owns the guard logic.
