export interface ConsoleLog {
  timestamp: Date;
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

/** The guest-side blank page Electron's <webview> loads before any real
 *  navigation. It's an implementation detail of the embedder, not a
 *  user-facing URL — never show it in the URL bar, tab title, or history. */
export const BLANK_URL = "about:blank";

/** True for URLs that should be treated as "no page loaded yet" in the UI —
 *  empty string or the webview's initial `about:blank`. */
export function isBlankUrl(url: string | null | undefined): boolean {
  return !url || url === BLANK_URL;
}

/** Window-level DOM event that asks the browser URL input to focus + select.
 *  One channel, many triggers: Cmd+L from the guest preload and the "new tab"
 *  button both fire it; the BrowserPanel's single listener handles them all. */
export const FOCUS_URL_BAR_EVENT = "deus:browser:focus-url-bar";

/** Mobile preview dimensions — a single fixed iPhone-class viewport used when
 *  a tab toggles on mobile view. Not configurable by the user; the goal is
 *  "do my mobile breakpoints fire?", not "pixel-match iPhone 14 Pro". */
export const MOBILE_PREVIEW_WIDTH = 390;
export const MOBILE_PREVIEW_HEIGHT = 852;
export const MOBILE_PREVIEW_DPR = 3;

/** Lightweight tab state persisted in the workspace layout store.
 *  Only what's needed to restore a tab — webviews are destroyed/recreated. */
export interface PersistedBrowserTab {
  id: string;
  url: string; // last loaded URL
  title: string; // display title
  /** Tab is in mobile preview mode (narrow centered frame + mobile CDP). */
  isMobileView?: boolean;
  /** Persisted so AAP `apps:stopped` can still match an app-owned tab after a
   *  workspace reload; see BrowserTabState.openedAt for the full rationale. */
  openedAt?: string;
}

export interface BrowserTabState {
  id: string;
  /** Display title: auto-derived from URL domain, overridden by webview title events */
  title: string;
  /** Value in URL input bar */
  url: string;
  /** Currently loaded URL in the webview */
  currentUrl: string;
  /** Navigation history stack */
  history: string[];
  /** Current position in history */
  historyIndex: number;
  /** Whether the guest page is loading (derived from <webview> did-start /
   *  did-stop-loading events) */
  loading: boolean;
  /** Error message if page load failed */
  error: string | null;
  /** Whether automation script has been injected */
  injected: boolean;
  /** Whether automation injection failed (shown as error indicator) */
  injectionFailed: boolean;
  /** Whether element selector mode is active */
  selectorActive: boolean;
  /** Whether DevTools inspector is docked (stolen NSView in main window) */
  devtoolsOpen: boolean;
  /** Console logs for this tab */
  consoleLogs: ConsoleLog[];
  /** Mobile preview mode: narrow centered frame + CDP mobile emulation (UA,
   *  touch, DPR). When false, the webview fills the panel and no emulation
   *  is applied — the page sees the panel's actual pixel dimensions. */
  isMobileView: boolean;
  /** The URL the tab was originally opened for, or undefined for tabs opened
   *  without a target (e.g. the "New Tab" button). Immutable once set —
   *  navigation and load failures never overwrite it. Used to match tabs
   *  against AAP lifecycle events: when an app stops, Electron may have
   *  already transitioned the view to `chrome-error://chromewebdata/`, so
   *  `url` / `currentUrl` are unreliable for origin matching. `openedAt`
   *  is the invariant source of truth for "this tab was spawned by app X". */
  openedAt?: string;
}

/** Data emitted when user selects an element in inspect mode */
export interface ElementSelectedEvent {
  type: "element-selected" | "area-selected";
  ref?: string;
  selectionKey?: string;
  /** "local" = own dev server (localhost), "external" = any other website */
  context?: "local" | "external";
  element?: {
    tagName: string;
    id?: string;
    className?: string;
    innerText?: string;
    path: string;
    rect: { top: number; left: number; width: number; height: number };
    /** Context-aware CSS: var() tokens for local, visual props for external */
    styles: Record<string, string>;
    /** Serialized React props — primitives only (variant, size, disabled, etc.) */
    props?: Record<string, string>;
    /** Whitelisted HTML attributes (data-testid, href, type, role, aria-label, etc.) */
    attributes?: Record<string, string>;
    /** Shallow innerHTML capped at 500 chars — shows element structure */
    innerHTML?: string;
  };
  reactComponent?: {
    name: string;
    fileName: string | null;
    lineNumber: number | null;
  };
  bounds?: { x: number; y: number; width: number; height: number };
  url: string;
  timestamp: number;
}

/** Imperative methods exposed by BrowserTab via forwardRef */
export interface BrowserTabHandle {
  navigateToUrl: (url: string) => void;
  /** Native session history back — preserves scroll/form state */
  goBack: () => void;
  /** Native session history forward — preserves scroll/form state */
  goForward: () => void;
  reload: () => void;
  /** Inject inspect-mode + visual-effects scripts. Returns true on success. */
  injectAutomation: () => Promise<boolean>;
  toggleElementSelector: () => void;
  /** Capture the current page — or a sub-rect of it — as a PNG data URL.
   *  `rect` is in webview-local pixels (same coord space Electron's
   *  `webContents.capturePage` uses). Returns null on failure. */
  captureScreenshot?: (rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<string | null>;
  /** Hide or restore the inspect-mode visuals (blue hover border, element
   *  label, custom cursor). Used to capture a clean screenshot of the
   *  selected element without the inspector painting on top. No-op when
   *  inspect mode isn't active or automation hasn't been injected. */
  setInspectOverlaysVisible?: (visible: boolean) => Promise<void>;
  /** Release the pinned selection border. When `expectedSelectionKey` is
   *  provided, the guest only clears if that same click selection is still
   *  pinned, preventing stale async cleanup from wiping out a newer one. */
  clearInspectSelection?: (expectedSelectionKey?: string) => Promise<void>;
  /** Current screen-space bounds of the webview's page area (accounts for
   *  mobile-view centering + DevTools docking). Returns null if the tab
   *  hasn't been measured yet. Read once at click time — the InspectPrompt
   *  overlay uses it to translate guest-viewport rects into host coords. */
  getWebviewBounds?: () => { x: number; y: number; width: number; height: number } | null;
  /** Open devtools in the tab-owning web contents. */
  openDevtools?: () => Promise<void>;
  /** Close devtools. */
  closeDevtools?: () => Promise<void>;
}

/** Extract a readable title from a URL (domain or localhost:port) */
export function deriveTitleFromUrl(url: string): string {
  if (isBlankUrl(url)) return "New Tab";
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost") {
      return `localhost${parsed.port ? ":" + parsed.port : ""}`;
    }
    // about:* and other non-http URLs parse but have empty hostnames — fall
    // back to "New Tab" rather than showing a blank title.
    if (!parsed.hostname) return "New Tab";
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "New Tab";
  }
}

/** Create a fresh browser tab with default state. Tab IDs are scoped to a
 *  workspace so they don't collide across workspaces in the WebviewManager
 *  (which keys <webview> instances by tab id). */
export function createBrowserTab(workspaceId?: string | null): BrowserTabState {
  const rand = Math.random().toString(36).slice(2, 6);
  const id = workspaceId
    ? `ws-${workspaceId.slice(0, 8)}-tab-${Date.now()}-${rand}`
    : `browser-tab-${Date.now()}-${rand}`;
  return {
    id,
    title: "New Tab",
    url: "",
    currentUrl: "",
    history: [],
    historyIndex: -1,
    loading: false,
    error: null,
    injected: false,
    injectionFailed: false,
    selectorActive: false,
    devtoolsOpen: false,
    consoleLogs: [],
    isMobileView: false,
  };
}

/** Hydrate a PersistedBrowserTab into a full BrowserTabState with
 *  ephemeral defaults (loading, history, consoleLogs, etc.). Blank URLs
 *  from legacy persistence are scrubbed here so they never re-surface in
 *  the URL bar or history on reload. */
export function hydratePersistedTab(persisted: PersistedBrowserTab): BrowserTabState {
  const storedUrl = isBlankUrl(persisted.url) ? "" : persisted.url;
  return {
    id: persisted.id,
    title:
      persisted.title && !isBlankUrl(persisted.title)
        ? persisted.title
        : deriveTitleFromUrl(storedUrl),
    url: storedUrl,
    currentUrl: storedUrl,
    history: storedUrl ? [storedUrl] : [],
    historyIndex: storedUrl ? 0 : -1,
    loading: false,
    error: null,
    injected: false,
    injectionFailed: false,
    selectorActive: false,
    devtoolsOpen: false,
    consoleLogs: [],
    isMobileView: persisted.isMobileView ?? false,
    openedAt: persisted.openedAt,
  };
}
