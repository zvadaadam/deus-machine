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
- `LazyMotion` with `domAnimation` wraps the whole app in `ThemeProvider.tsx` — always use `m`
  (compact alias) instead of `motion`. `AgentQuestionOverlay.tsx` + `PlanApprovalOverlay.tsx` use
  `motion` (pre-existing violation).

## Dead Code Pattern (Confirmed)

- When removing a prop from a call site, also check the destructuring site of the hook.
  TypeScript does not error on unused destructured variables — only ESLint's `no-unused-vars` catches this.

## CSS Architecture

- `transition: flex-grow` on `[data-slot="resizable-panel"]` — flex-grow IS animatable per CSS spec
- `window-resizing` class disables ALL layout transitions during native window resize
- `[data-resize-handle-active]` sibling/parent selector disables panel transitions during drag

## Cross-Component Event Bus Pattern

- `window.dispatchEvent(new CustomEvent("insert-to-chat", { detail }))` is the established
  pattern for browser panel → chat input communication.

## XML Attribute Serialization Risk Pattern

- `serializeInspectElement` in `parseInspectTags.ts` embeds user-controlled strings (innerText,
  path, tagName, reactComponent) into XML attributes with NO escaping. A `"` breaks parsing.
  Fix: HTML-escape values before embedding.

## Distribution / CI Patterns

- `sed -i ''` is macOS/BSD syntax — fails on ubuntu-latest (GNU sed needs `sed -i "..."`).
- Tauri updater `pubkey` empty string `""` disables signature verification entirely (security regression).
- `minimumSystemVersion` for arm64-only builds should be `"11.0"` (Apple Silicon ships with 11.0).
- The app spawns system `node` binary — hardened runtime notarization may need
  `com.apple.security.cs.disable-library-validation` in Entitlements.plist.

## Sentry / Observability Patterns (Confirmed)

- **DSN propagation**: Rust `option_env!("SENTRY_DSN_RUST")` bakes frontend DSN at compile time.
  `option_env!("SENTRY_DSN_NODE")` is baked into the binary and forwarded as `SENTRY_DSN` env var
  to child processes (backend + sidecar). Frontend uses `import.meta.env.VITE_SENTRY_DSN`.
- **`option_env!` with empty string**: When `SENTRY_DSN_RUST` is unset, `option_env!` returns `None`,
  and `.unwrap_or("")` passes `""` to `sentry::init`. The sentry-rust crate treats empty DSN as
  disabled — no panic, no-op client. This pattern is correct and safe.
- **Conditional init in Node.js**: `if (process.env.SENTRY_DSN) { Sentry.init(...) }` means when
  DSN is absent, Sentry is never initialized. `Sentry.captureException()` and `Sentry.close()` called
  on an uninitialized client are safe no-ops in `@sentry/node@10`. Correct pattern.
- **Frontend `enabled: !import.meta.env.DEV`**: Sentry is initialized but disabled in dev mode.
  `captureException()` calls in `errorReporting.ts` are no-ops in dev mode as a result. Good behavior.
- **`sendDefaultPii: true`** is set on all layers — intentional (desktop app, known users).
- **Sentry guard lifetime (Rust)**: `_sentry_guard` in `main()` lives until process exit. Dropping
  it earlier would flush pending events prematurely. The single-underscore prefix suppresses the
  unused-variable warning without dropping it.
- **`Sentry.close(2000)` before `process.exit`**: The 2-second flush window is appropriate. Both
  backend and sidecar implement this correctly in their `uncaughtException` handlers.
- **Hardcoded Sentry org/project in vite.config.ts**: `org: "deus-40"` and
  `project: "deus-desktop-frontend"` are hardcoded. These are metadata identifiers (not secrets).
  Leaking them poses minimal risk but couples the open-source repo to internal Sentry project names.
- **CI missing Sentry secrets**: `release.yml` does not pass `SENTRY_DSN_RUST`, `SENTRY_DSN_NODE`,
  `VITE_SENTRY_DSN`, or `SENTRY_AUTH_TOKEN`. Production builds will have Sentry monitoring disabled
  until these are wired into the workflow.
- **Root ErrorBoundary not connected to Sentry**: The outer `<ConditionalErrorBoundary fallback={DashboardError}>`
  at line 126 of App.tsx has NO `onError` prop. React crashes inside MainLayout that are caught by
  that boundary go unreported to Sentry. Only the inner boundary (line 187) calls `reportError`.
- **`@sentry/node` in production dependencies**: `@sentry/node` and `@sentry/vite-plugin` are in
  `dependencies` (not `devDependencies`). `@sentry/vite-plugin` is build-only and should be in
  `devDependencies`. `@sentry/node` is needed at runtime by backend/sidecar, correct in `dependencies`.

## Experimental Feature Toggle Pattern (Confirmed)

- `experimental_*` fields are `boolean | undefined` on `Settings` — `undefined` means ON (backwards-compat)
- `isTabVisible(tab, settings)` is exported from `ContentTabBar.tsx`
- `effectiveRightSideTab` in `MainContent` = `isTabVisible(raw, settings) ? raw : "code"`

## Simulator / Rust Command Patterns (Confirmed)

- `sim_has_xcode_project` is a `fn` (sync) Tauri command — safe ONLY because Pass 1 (filesystem
  scan) dominates. Pattern: split fast probe (`has_xcode_project_fast`) from full build.
- macOS-only Tauri commands: gated via `#[cfg(target_os = "macos")]` in both `commands/mod.rs`
  and `main.rs` invoke_handler lists.
- Three-state probe pattern: `null | true | false`. `null` = loading, suppresses button flicker.

## Simulator State Machine Patterns (Confirmed)

- `dispatch()` = validated transition; `setSession()` = recovery bypass for external observation.
- `handleStop()` dispatches STOP first (optimistic), then awaits IPC — avoids UI stuck in "active".
- `STREAM_READY` requires `current.udid === event.udid` — prevents start/stop race.

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
- `AnimatePresence` inside `.map()` anti-pattern: placing `<AnimatePresence>` as the return value
  of a `.map()` call (one per item) means the entire boundary is recreated when the item's key
  changes. When the condition flips (e.g., `isEditing` changes from item A to item B), the boundary
  for A is torn down in the same commit as its child — `AnimatePresence` never sees the child
  transition and the exit animation does not fire. Fix: single `<AnimatePresence>` outside the
  `.map()`, with stable keys on each animated child element.

## Global queryClient Defaults (Confirmed)

- `refetchOnWindowFocus: false` globally in `queryClient.ts` — critical to prevent typing lag.
  `refetchOnWindowFocus: true` only acceptable for git diff queries (intentional).

## CORS / External Fetch Patterns

- Statuspage.io APIs include `Access-Control-Allow-Origin: *` — works from WKWebView.
  Third-party dependency: if headers are removed, fetches silently fail with CORS error.

## Design Token Completeness

- `bg-accent-green`, `bg-accent-gold`, `bg-accent-red` ARE valid — defined in `@theme`.
- `bg-warning`, `bg-success`, `text-warning` ARE valid — `--color-warning`/`--color-success` in `@theme`.

## Content Panel Redesign Pattern (Confirmed)

- `AllFilesDiffViewer`: `hideHeader?: boolean` prop (default false) for embedding in CodePanelContent.
- Both Changes/Files tabs: content | 1px separator | tree (220px fixed) layout.

## See Also

- `patterns-deep.md` — overflow notes: error classification, chat virtualization, PRStatus, border radius, sidecar resume
- `message-envelope-pattern.md` — session message envelope/flat array patterns
