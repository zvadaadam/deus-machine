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

## Dead Code Pattern (Confirmed)

- When removing a prop from a call site, also check the destructuring site of the hook that
  originally provided the handler. E.g., removing `onReviewPR={handleOpenPR}` from `<PRActions>`
  leaves `handleOpenPR` destructured-but-unused in `MainContent.tsx` (from `useWorkspaceActions`).
  TypeScript does not error on unused destructured variables — only ESLint's `no-unused-vars` rule
  catches this. Always grep for all references after removing a prop.

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

## Simulator State Machine Patterns (Confirmed)

- Three-plane architecture: Component plane (React mount), Display plane (Zustand store keyed by
  workspaceId), Session plane (Rust HashMap). `clearWorkspaceSession` ONLY on explicit Stop — never
  on component unmount or workspace switch.
- `dispatch()` = validated transition (state machine enforces legal paths); `setSession()` = recovery
  bypass for external-state reconciliation (mount probes, auto-reconnect). Clear rule: user actions
  → dispatch, external observation → setSession.
- `handleRetry()` = `dispatch(CLEAR)` then `handleStart()`. CLEAR is synchronous (Zustand), so
  BOOT in handleStart sees idle state immediately. This is safe.
- `handleStop()` dispatches STOP first (immediate store update, disables UI), then awaits
  stopStreaming IPC. The optimistic-update pattern is intentional — avoids UI stuck in "active" if
  the IPC call hangs.
- `onMouseLeave={handleMouseUp}` in SimulatorStreamViewer: fires "ended" at the leave coordinates,
  then `lastCoordsRef` is cleared. Window mouseup listener then skips (coords null). No double-fire.
  BUT: if the user moves out while holding and releases outside, both mouseLeave AND window-mouseup
  fire. mouseLeave fires first (clears lastCoordsRef), then window-mouseup skips (coords null) —
  one "ended" event sent, correct behavior.
- `sim-idle-breathe` and `build-shimmer` keyframes live in global.css — multi-component reuse
  justifies global placement (both used by SimulatorPanel components).
- `STREAM_READY` transition requires `current.udid === event.udid` — prevents a race where user
  clicks Stop during boot then clicks Start again: the first STREAM_READY is rejected because state
  is now idle (STOP → idle deletes entry), not booting. The second start cycle works normally.
- `setSession(workspaceId, { phase: "idle" })` does NOT delete the map entry (unlike dispatch(STOP)
  or clearWorkspaceSession). If called by accident it would leave a stale idle entry — currently not
  used this way but worth knowing.
- ResizablePanelGroup key removal + imperative resize effect: the effect fires on every
  selectedWorkspaceId change. `chatPanelRef.current?.resize()` has a guard — it's a no-op if the
  panel is at the same size. Safe to call redundantly.
- `workspaceGenerationRef` pattern: monotonic counter incremented in the workspace-switch effect.
  Async callbacks compare captured gen against current ref. Prevents stale writes after rapid
  workspace switching.

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
- `bg-warning`, `bg-success`, `text-warning` ARE valid — `--color-warning` and `--color-success`
  defined in `@theme` block (lines 30, 32 of global.css). Safe to use in action button variants.

## PRStatus / GhCliStatus Patterns (Confirmed)

- `PRStatus.pr_url` is optional (`pr_url?: string`). Falling back to `""` on undefined produces
  `href=""` in a Tauri WebView which navigates to `tauri://localhost/` — silent app reload. Always
  guard: use `pr_url ?? null` and skip rendering the anchor when null.
- `PRStatus.pr_state` includes `"closed"` (abandoned PR, not merged). Failing to handle this case
  causes the state machine to fall through to actionable states (Fix CI, Resolve Conflicts) on a
  dead branch — prompting the agent to work on an already-closed PR.
- `ghStatus` being `null`/`undefined` (TanStack Query loading) should be treated as "unknown, do
  not surface action buttons" — not as "gh is available." The guard `if (ghStatus && ...)` silently
  passes null/undefined through to PR state evaluation.
- `derivePRActionState` in `src/features/workspace/lib/prState.ts` is the single source of truth
  for PR state machine. Pure function, no tests exist yet — high-value test target.
- `PRActionState` discriminated union: 11 variants (added `closed` and `error`). `match().exhaustive()`
  used in PRActions.tsx main render. PRLink uses a non-exhaustive if-chain guard (early return for
  `gh_unavailable`, `no_pr`, `error`) — this remains a type-safety gap when new variants are added.
- `prUrl = prStatus.pr_url ?? ""` in `derivePRActionState` (line 75). The `""` fallback still produces
  `href=""` → `tauri://localhost/` reload risk, BUT `PRLink` filters on `!= "gh_unavailable" | "no_pr" | "error"`
  so the only states that render the anchor are states where `pr_url` is always set by the backend (has_pr=true path).
  Risk is low in practice but the type system doesn't enforce it (string, not string & URL).
- `FAILING_CONCLUSIONS` and `PENDING_STATES` sets are defined INSIDE the request handler function
  (inside the `app.get(...)` callback), so they are re-created on every request. Move to module scope.
- `lastError` logic: `runGh` returns only `'unknown'` for non-specific errors, so the check
  `lastError === 'unknown' ? 'network' : null` always maps to `'network'` when set. Correct but
  the conditional is redundant — could just be `lastError ? 'network' : null`.
- CI `hasPending` check has a subtle issue: when `c.conclusion == null` AND `PENDING_STATES.has(c.state)`
  are both truthy, the OR short-circuits at `c.conclusion == null`. This is correct for in-progress checks.
  However, a check with `conclusion === null` and `state` NOT in PENDING_STATES (e.g. a weird state)
  would still mark it pending — acceptable given the unknown = pending safety heuristic.
- `query.state.data` in `usePRStatus` refetchInterval callback is cast to a loose object type instead
  of `PRStatus | null`. Should use `import type { PRStatus }` and cast to `PRStatus | null | undefined`.
- `review_required` and `approved` review statuses are not mapped to PRActionState variants. They both
  fall through to `awaiting_review`. This is intentional (safest default) but `review_required` could
  deserve its own state in a future iteration.

## Border Radius System (10-Token Scale, Confirmed)

- Token scale: 2xs(2px) → xs(4px) → sm(6px) → md(8px) → lg(10px) → xl(12px) → 2xl(16px) → 3xl(20px) → 4xl(24px) → full(9999px)
- Two-layer: @theme defines `--radius-*: calc(var(--radius-*-base) * var(--corner-radius-scale))`. Base values + scale live in :root.
- Squircle @supports block sets `--corner-radius-scale: 1.25` globally (ALL tokens scale).
  The 1-2px inflation on small radii is imperceptible.
- `corner-shape: superellipse(1.5)` applied to .rounded-sm through .rounded-4xl in the @supports block.
  2xs/xs are too small to benefit; full is a pill.
- Elements consuming `var(--radius-*)` directly in CSS (scrollbars, diff components, markdown, sonner toast)
  get the inflated radius without squircle — accepted as imperceptible (1-2.5px delta).
  `corner-shape` cannot apply to `::-webkit-scrollbar-thumb` pseudo-elements anyway.
- Legacy `--radius: 0.5rem` kept in :root for backward compat. `sonner.tsx` migrated to `--radius-md`.
- All UI components fully migrated from `rounded-md` to semantic tokens (rounded-lg/xl/2xl etc.).
- `scroll-area.tsx`: `rounded-[inherit]` is the only remaining arbitrary rounded value — correct and intentional.
- `border-radius: 0` in global.css is the only non-token border-radius — correct and intentional.
- Old `calc(var(--radius) ± Npx)` expressions fully removed from @theme — no orphans remain.
- `border-radius 280ms` transition on `.tauri [data-slot="main-content"]` is a pre-existing violation
  of the "animate only transform/opacity" rule. Not introduced by the radius system changes.
