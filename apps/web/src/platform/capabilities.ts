/**
 * Platform Capabilities
 *
 * Single source of truth for what features are available in the current
 * runtime environment. Components check capabilities, not platform identity.
 *
 * WHY capabilities instead of `isElectron` checks:
 *   - Decouples features from platform. Adding WebSocket terminals for web
 *     mode? Flip `nativeTerminal` to `true` here, not in 20 components.
 *   - Self-documenting. This file is the inventory of what works where.
 *   - Testable. Mock `capabilities` in tests to simulate any platform.
 *   - No more 5 different ways to check platform scattered across the codebase.
 *
 * RULES:
 *   - Name capabilities after the FEATURE, not the platform.
 *     ✅ `nativeTerminal`  ❌ `isElectron`
 *   - If a feature works in both modes (with different transports), it's `true`.
 *     File mention works via HTTP in both Electron and web → always `true`.
 *   - If a feature is fundamentally impossible in web (folder picker), it's `false`.
 */

const isElectron = typeof window !== "undefined" && "electronAPI" in window;

export const capabilities = {
  /** Native PTY terminal (requires Electron IPC for shell spawning) */
  nativeTerminal: isElectron,

  /** Embedded browser webview (requires Electron BrowserView) */
  nativeBrowser: isElectron,

  /** iOS simulator panel — stream management lives in backend, works in
   *  both desktop and web modes. Desktop connects to MJPEG directly;
   *  web/relay mode shows panel but no live stream until relay proxy is built.
   *  TODO(relay-streaming): change to `true` once MJPEG frame proxy is implemented */
  nativeSimulator: isElectron,

  /** Auto-update check/download/install (requires Electron updater) */
  autoUpdate: isElectron,

  /** Native folder picker dialog (requires Electron dialog API) */
  nativeFolderPicker: isElectron,

  /** Open workspace in external apps — Finder, VS Code, Cursor (requires local `open` command) */
  openInExternalApp: isElectron,

  /** Onboarding flow with transparent window effects (requires Electron window API) */
  nativeOnboarding: isElectron,

  /** Window chrome — drag regions, custom zoom, fullscreen tracking */
  nativeWindowChrome: isElectron,

  /** Show/hide main window on boot (requires Electron BrowserWindow) */
  windowLifecycle: isElectron,

  /** Create secondary windows (detached browser popup) */
  secondaryWindows: isElectron,

  /** OS-level notifications via Electron Notification API.
   *  Web Notifications API could work but needs explicit permission UX. */
  nativeNotifications: isElectron,

  /** Electron IPC event listeners (workspace progress, agent-server requests, etc.).
   *  When false, these events arrive through the WebSocket protocol instead. */
  ipcEventListeners: isElectron,

  /** Direct Electron IPC invoke() for native commands (enter_onboarding_mode,
   *  native:homeDir, etc.) */
  ipcInvoke: isElectron,

  /** Whether we're running inside the Electron desktop app (as opposed to a browser).
   *  Prefer this for high-level desktop vs web branching over implementation-detail
   *  capabilities like `ipcInvoke`. */
  isDesktop: isElectron,
} as const;

export type Capabilities = typeof capabilities;
export type CapabilityName = keyof Capabilities;
