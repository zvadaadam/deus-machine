export interface ConsoleLog {
  timestamp: Date;
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

/** CDP device emulation state for a browser tab */
export interface ViewportState {
  width: number;
  height: number;
  deviceScaleFactor: number;
  /** Whether to enable touch emulation + mobile UA. Preserved from device
   *  preset metadata — width heuristics misclassify tablets (820px). */
  mobile?: boolean;
}

/** Lightweight tab state persisted in the workspace layout store.
 *  Only what's needed to restore a tab — webviews are destroyed/recreated. */
export interface PersistedBrowserTab {
  id: string;
  url: string; // last loaded URL
  title: string; // display title
  viewport?: ViewportState | null;
  /** Persisted so AAP `apps:stopped` can still match an app-owned tab after a
   *  workspace reload; see BrowserTabState.openedAt for the full rationale. */
  openedAt?: string;
}

export interface BrowserTabState {
  id: string;
  /** Unique label for the native Electron BrowserView instance */
  webviewLabel: string;
  /** Display title: auto-derived from URL domain, overridden by native title events */
  title: string;
  /** Value in URL input bar */
  url: string;
  /** Currently loaded URL in the webview */
  currentUrl: string;
  /** Navigation history stack */
  history: string[];
  /** Current position in history */
  historyIndex: number;
  /** Whether the native BrowserView is loading */
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
  /** CDP device emulation — null means responsive (no emulation) */
  viewport: ViewportState | null;
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
  injectAutomation: () => Promise<void>;
  toggleElementSelector: () => void;
}

/** Extract a readable title from a URL (domain or localhost:port) */
export function deriveTitleFromUrl(url: string): string {
  if (!url) return "New Tab";
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost") {
      return `localhost${parsed.port ? ":" + parsed.port : ""}`;
    }
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "New Tab";
  }
}

/** Create a fresh browser tab with default state.
 *  When workspaceId is provided, scopes the webview label to prevent
 *  collisions across workspaces. */
export function createBrowserTab(workspaceId?: string | null): BrowserTabState {
  const rand = Math.random().toString(36).slice(2, 6);
  const id = workspaceId
    ? `ws-${workspaceId.slice(0, 8)}-tab-${Date.now()}-${rand}`
    : `browser-tab-${Date.now()}-${rand}`;
  return {
    id,
    webviewLabel: id,
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
    viewport: null,
  };
}

/** Hydrate a PersistedBrowserTab into a full BrowserTabState with
 *  ephemeral defaults (loading, history, consoleLogs, etc.) */
export function hydratePersistedTab(persisted: PersistedBrowserTab): BrowserTabState {
  // Use persisted.id as a stable webview label — same tab always maps to the
  // same native view. This enables view parking: parked views can be recalled
  // by label without creating a new native WebContentsView.
  return {
    id: persisted.id,
    webviewLabel: persisted.id,
    title: persisted.title || deriveTitleFromUrl(persisted.url),
    url: persisted.url,
    currentUrl: persisted.url,
    history: persisted.url ? [persisted.url] : [],
    historyIndex: persisted.url ? 0 : -1,
    loading: false,
    error: null,
    injected: false,
    injectionFailed: false,
    selectorActive: false,
    devtoolsOpen: false,
    consoleLogs: [],
    viewport: persisted.viewport ?? null,
    openedAt: persisted.openedAt,
  };
}
