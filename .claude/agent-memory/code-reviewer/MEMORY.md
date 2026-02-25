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

## Distribution / CI Patterns

- `sed -i ''` is macOS/BSD syntax. On ubuntu-latest (GNU sed), use `sed -i "..."` (no empty-string arg). Scripts that use `sed -i ''` WILL fail in CI.
- Tauri updater `pubkey` must be set to the minisign public key string — empty string `""` disables signature verification entirely (security regression, also may break tauri-plugin-updater at runtime).
- `minimumSystemVersion` for arm64-only builds should be `"11.0"` — Apple Silicon Macs shipped with macOS 11.0; `"10.13"` is only valid for x86_64 Intel targets.
- `tauri-action@v0` needs `includeUpdaterJson: true` (or it defaults true when updater is configured) — verify latest.json is uploaded as a release asset alongside the DMG.
- `workflow_dispatch` without a branch filter can tag + push from any branch; restrict by adding `branches: [main]` under `on.workflow_dispatch` or add a guard step.
- The app spawns system `node` binary (not bundled) — hardened runtime notarization may need `com.apple.security.cs.disable-library-validation` in Entitlements.plist if node's dylibs fail team-ID checks.

## Experimental Feature Toggle Pattern (Confirmed)

- `experimental_*` fields are `boolean | undefined` on `Settings` — `undefined` means ON (backwards-compat)
- Visibility gate: `settings?.[key] !== false` — explicit `false` hides tab, undefined/true shows it
- `isTabVisible(tab, settings)` is now exported from `ContentTabBar.tsx` (moved from deleted `RightSidecar.tsx`)
- `effectiveRightSideTab` in `MainContent` = `isTabVisible(raw, settings) ? raw : "code"` — store keeps original for re-enable restore
- `saveSetting` in `SettingsPage.tsx` is typed as `(key: string, value: unknown)` but `SettingsSectionProps.saveSetting` requires `(key: keyof Settings, value: Settings[keyof Settings])`. TypeScript accepts this because `string` is wider than `keyof Settings` at the assignment site. Not a runtime bug, but a type-safety gap.
- `useRightPanelSizing` and `RightSidecar.tsx` were deleted in content-panel-redesign branch. The panel is now a fixed 40/60 split (no per-tab resizing). The deleted CSS rule `[data-suppress-transition]` was owned by `useRightPanelSizing` — safe to remove alongside it.

## Simulator / Rust Command Patterns (Confirmed)

- `sim_has_xcode_project` is a `fn` (sync) Tauri command — safe ONLY because Pass 1 (filesystem
  scan) dominates. Pass 2 (`xcodegen generate`) is a blocking subprocess; if triggered it will
  block a Tokio thread. Probe commands must skip any subprocess paths; build commands can use them.
- Pattern for "fast probe vs full build": split into `has_xcode_project_fast` (filesystem only)
  and `find_xcode_project` (filesystem + xcodegen). Probe command uses the fast variant.
- macOS-only Tauri commands: gated via `#[cfg(target_os = "macos")]` in both `commands/mod.rs`
  and `main.rs` invoke_handler lists. Non-macOS rejection from `invoke()` sets probe to `false`
  (button hidden) — this works but emits telemetry noise via `reportError` in `invoke.ts`.
- Three-state probe pattern: `null | true | false` for async IPC probes. `null` = loading,
  suppresses button flicker. `false` = either "not found" or "IPC error" — collapsed intentionally.
- `hasProject === null` during loading: `null` is falsy in JS, so `hasProject ? <Button> : null`
  hides the button while the probe is in flight. Correct UX, no flash of invalid state.

## Icon Component Patterns (New)

- `AppIcon` registry pattern: static `APP_ICON_MAP` record maps appId → icon component function
- Category grouping uses `Set` for O(1) lookups in `getAppCategory()` and `groupAppsByCategory()`
- JetBrains family uses shared diamond shape with brand color prop — DRY approach for similar products
- SVG icons: 16x16 viewBox, use stroke + fill, no animations, all white inner shapes on colored rect backgrounds
- Icon components are pure (no state/hooks) — candidates for React.memo if used in frequently-rendering lists

## Content Panel Redesign Pattern (New)

- **AllFilesDiffViewer redesign**: Added `hideHeader?: boolean` prop (defaults to false) to support
  embedding within CodePanelContent which renders its own tab chrome. Header bar (file count,
  collapse/expand, close buttons) is conditionally hidden with `{!hideHeader && (...)}`.
- **onClose handler**: Changed from required `onClose: () => void` to optional `onClose?: () => void`.
  When `hideHeader=true`, `onClose` is never called (button not rendered). Safe because parent
  CodePanelContent manages close logic via tab switching, not via this callback.
- **Changes view architecture**: Replaces single-file diff viewer (DiffTabContent) with infinite-scroll
  AllFilesDiffViewer. Uses ref-based communication: `diffViewerRef.current?.scrollToFile(path)` to
  scroll/sync when user clicks ChangedFilesTree. AllFilesDiffViewer's scroll-spy updates store's
  selectedFile, keeping tree highlighting in sync bidirectionally.
- **Files view architecture**: Mirrors Changes structure. FileViewer (left) shows text preview of
  selected file, FileBrowserPanel (220px fixed width, right) shows file tree. Both tabs (Changes/Files)
  now have identical split layout: content | 1px separator | tree (220px fixed).
- **selectedFilePath coercion**: `selectedFilePath ?? null` used in both Changes (line 142) and Files
  (line 176) views because hook returns `string | null` and both expect `string | null`. Coercion is
  safe because selectedFilePath is already `string | null | undefined` (hook extracts with `?.path ?? null`),
  and `undefined ?? null` evaluates to `null`. Improves code clarity over `selectedFilePath || null`.
- **absoluteFilePath computation**: Uses `workspace.workspace_path` (base) + relative `selectedFilePath`
  to build full path for FileViewer. Path normalization removes trailing/leading slashes to avoid
  double-slashes. Computed unconditionally (cheap string op), only used when `filterMode === "all"`.
- **cn() still needed**: Tab button styling uses `cn()` for conditional class merging (active vs inactive
  state). Necessary for proper twMerge resolution of variants.

## Framer Motion Patterns (Confirmed)

- `LazyMotion` with `domAnimation` wraps the whole app in `ThemeProvider.tsx` — always use `m`
  (compact alias) instead of `motion`. Using `motion` bypasses lazy loading and pulls in the full
  bundle. Files `AgentQuestionOverlay.tsx` and `PlanApprovalOverlay.tsx` currently use `motion`
  (not `m`) — this is a pre-existing violation, not introduced by new code.
- `useReducedMotion()` is the established pattern for honoring prefers-reduced-motion. Used in
  `RepositoryItem`, `ToolUseBlock`, `ThinkingBlock`, `PastedImageCard`, `PastedTextCard`,
  `CloneRepositoryModal`. New animated components should follow the same pattern.
- `AnimatePresence` exit animation bug: if a component conditionally returns `null` before
  `AnimatePresence` renders, the exit animation never fires. Pattern must be:
  `<AnimatePresence>{condition && <m.div exit={...}>...</m.div>}</AnimatePresence>` — NOT
  `{condition ? <AnimatePresence><m.div>...</m.div></AnimatePresence> : null}`.

## Global queryClient Defaults (Confirmed)

- `refetchOnWindowFocus: false` globally in `queryClient.ts` — explicitly documented as critical
  to prevent typing lag. Overriding to `true` per-query is acceptable only for git diff queries
  (workspace.queries.ts does this intentionally). External status poll queries (ai-status.queries.ts)
  should NOT override to `true` — the Tauri WebView "window focus" fires on every popover open/close,
  causing redundant network requests to external URLs.

## CORS / External Fetch Patterns

- Tauri WebView uses WKWebView on macOS with a custom `tauri://localhost` origin.
  Statuspage.io APIs (`status.claude.com`, `status.openai.com`) include permissive CORS headers
  (`Access-Control-Allow-Origin: *`) so fetches work from the WebView in practice.
  This is a third-party dependency — if those headers are removed, fetches silently fail in
  production with a CORS error. The `retry: 1` + `"none"` fallback in the queries is appropriate
  mitigation, but there is no way to distinguish CORS errors from genuine outages.

## Design Token Completeness

- `bg-accent-green`, `bg-accent-gold`, `bg-accent-red` ARE valid Tailwind tokens — defined in
  `global.css` `@theme` block as `--color-accent-green`, `--color-accent-gold`, `--color-accent-red`.
  Not hardcoded colors; they route through CSS variables to theme values.
