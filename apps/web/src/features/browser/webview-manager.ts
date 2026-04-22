/**
 * WebviewManager — per-tab <webview> lifecycle outside the React tree.
 *
 * Each tab owns a detached `<div><webview/></div>` pair living directly in
 * document.body. React components render normal in-tree UI; a layout effect
 * hands the webview container a set of bounds and a visibility flag, and
 * WebviewInstance.sync() does the single style assignment that reflects
 * that state. Nothing reads the DOM here — the caller supplies bounds
 * derived from its own ResizeObserver / layout state.
 *
 * Pattern copied from Codex's browser-sidebar-webview: keeping the <webview>
 * out of React's tree means tab switches, workspace switches, and route
 * changes don't destroy the guest page, and the container stacks normally
 * alongside DOM (so dropdowns, overlays, and splitters layer above it).
 */
/* eslint-env browser */

export type Bounds = { x: number; y: number; width: number; height: number };

export interface WebviewState {
  bounds: Bounds | null;
  isVisible: boolean;
}

/** Shared cookie/session partition — mirrored on the <webview> tag below. */
export const WEBVIEW_PARTITION = "persist:browser";

/** z-index reserved for <webview> guests and the overlays that must render
 *  on top of them (focus-mode composer, agent cursor, comment pins). */
export const WEBVIEW_BASE_Z = 0;
export const WEBVIEW_OVERLAY_Z = 20;

// Global CSS override — beats Electron's UA `<webview>` rule
// (`display: inline-flex; width: 300px; height: 300px`) with !important so the
// element fills its container instead of shrink-wrapping to its guest page.
if (typeof document !== "undefined") {
  const STYLE_ID = "deus-browser-webview-layout-override";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      webview {
        display: flex !important;
        width: 100% !important;
        height: 100% !important;
      }
      webview[hidden] { display: none !important; }
    `;
    document.head.append(style);
  }
}

// Module-level flag toggled by `WebviewManager.setPointerEventsEnabled`.
// Read at every `applyVisible` call so a sync triggered mid-drag (by the
// splitter's panel-resize → ResizeObserver → bounds-update chain) doesn't
// clobber the drag's pointer-events:none guard. Without this, every drag
// step would momentarily re-enable pointer events and the drag would
// freeze as soon as the cursor crossed into the webview.
let pointerEventsDisabled = false;

const HIDDEN_STYLE: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  top: "0",
  left: "-10000px",
  width: "1px",
  height: "1px",
  opacity: "0",
  visibility: "hidden",
  pointerEvents: "none",
  zIndex: String(WEBVIEW_BASE_Z),
};

function applyHidden(el: HTMLElement): void {
  Object.assign(el.style, HIDDEN_STYLE);
}

function applyVisible(el: HTMLElement, bounds: Bounds): void {
  Object.assign(el.style, {
    position: "fixed",
    top: `${bounds.y}px`,
    left: `${bounds.x}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    opacity: "1",
    visibility: "visible",
    pointerEvents: pointerEventsDisabled ? "none" : "auto",
    zIndex: String(WEBVIEW_BASE_Z),
  });
}

/** Decide what bounds to actually render:
 *   - hidden: null (apply HIDDEN_STYLE)
 *   - visible + valid bounds: use them
 *   - visible but invalid (null or zero-dim): fall back to cached last-visible
 *     bounds so mid-transition flashes don't reset the container to hidden.
 * Matches Codex's `jb()` resolver verbatim. */
function resolveBounds(state: WebviewState, lastVisible: Bounds | null): Bounds | null {
  if (!state.isVisible) return null;
  if (state.bounds != null && state.bounds.width > 0 && state.bounds.height > 0) {
    return state.bounds;
  }
  return lastVisible;
}

export interface WebviewElement extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  insertCSS(css: string): Promise<string>;
  capturePage(): Promise<{ toDataURL(): string }>;
  getWebContentsId(): number;
  getURL(): string;
  getTitle(): string;
  stop(): void;
}

export class WebviewInstance {
  readonly id: string;
  readonly container: HTMLDivElement;
  readonly webview: WebviewElement;
  private state: WebviewState = { bounds: null, isVisible: false };
  private lastVisibleBounds: Bounds | null = null;
  private isAttached = false;

  constructor(id: string, initialUrl: string) {
    this.id = id;
    this.container = document.createElement("div");
    this.container.dataset.browserTabId = id;
    applyHidden(this.container);
    this.container.style.display = "flex";
    this.container.style.flexDirection = "column";

    this.webview = document.createElement("webview") as WebviewElement;
    this.webview.setAttribute("partition", WEBVIEW_PARTITION);
    this.webview.setAttribute("allowpopups", "");
    this.webview.setAttribute("src", initialUrl || "about:blank");

    this.container.append(this.webview);
    document.body.append(this.container);
  }

  /** Publish new bounds + visibility. Single place that writes style. */
  sync(next: WebviewState): void {
    this.isAttached = true;
    this.state = next;
    const target = resolveBounds(next, this.lastVisibleBounds);
    if (target == null) {
      applyHidden(this.container);
      return;
    }
    this.lastVisibleBounds = target;
    applyVisible(this.container, target);
  }

  /** Hide without forgetting bounds — cheap "component unmounted but tab
   *  stays alive" path. Callers that truly close the tab use dispose(). */
  detach(): void {
    this.isAttached = false;
    this.state = { bounds: null, isVisible: false };
    applyHidden(this.container);
  }

  /** Re-apply last known bounds — called on window focus / visibilitychange
   *  to recover from cases where Chromium drops our layout. */
  resync(): void {
    if (!this.isAttached) return;
    const target = resolveBounds(this.state, this.lastVisibleBounds);
    if (target == null) applyHidden(this.container);
    else applyVisible(this.container, target);
  }

  dispose(): void {
    this.container.remove();
  }
}

class WebviewManagerImpl {
  private instances = new Map<string, WebviewInstance>();
  private globalListenersBound = false;

  /** Temporarily disable pointer events on every live webview container so
   *  the host can receive pointermove events during a panel-splitter drag.
   *
   *  Electron's <webview> is a guest frame with its own Chromium event
   *  handler — mouse events over the webview are consumed by the guest
   *  page, not bubbled to `document`. react-resizable-panels relies on
   *  document-level pointermove listeners during a drag; once the cursor
   *  crosses into the webview, those listeners stop firing and the drag
   *  freezes (feels "stuck"). Toggling pointer-events: none on the
   *  container makes the webview transparent to input, so events reach
   *  the document and the drag completes. Restore on drag end.
   *
   *  The module-level `pointerEventsDisabled` flag is ALSO read by
   *  `applyVisible` so a concurrent sync (triggered mid-drag by the
   *  ResizeObserver chain that tracks panel size → bounds → sync) doesn't
   *  restore pointer-events:auto and re-trap the drag. */
  setPointerEventsEnabled(enabled: boolean): void {
    pointerEventsDisabled = !enabled;
    const value = enabled ? "auto" : "none";
    for (const inst of this.instances.values()) {
      inst.container.style.pointerEvents = value;
    }
  }

  getOrCreate(id: string, initialUrl: string): WebviewInstance {
    let inst = this.instances.get(id);
    if (inst) return inst;
    this.ensureGlobalListeners();
    inst = new WebviewInstance(id, initialUrl);
    this.instances.set(id, inst);
    return inst;
  }

  get(id: string): WebviewInstance | null {
    return this.instances.get(id) ?? null;
  }

  dispose(id: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.dispose();
    this.instances.delete(id);
  }

  disposeAll(): void {
    for (const inst of this.instances.values()) inst.dispose();
    this.instances.clear();
  }

  private ensureGlobalListeners(): void {
    if (this.globalListenersBound) return;
    if (typeof window === "undefined") return;
    this.globalListenersBound = true;
    const resyncAll = () => {
      for (const inst of this.instances.values()) inst.resync();
    };
    window.addEventListener("focus", resyncAll);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resyncAll();
    });
  }
}

export const webviewManager = new WebviewManagerImpl();
