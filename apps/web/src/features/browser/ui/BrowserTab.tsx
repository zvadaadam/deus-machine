/**
 * BrowserTab — native Electron BrowserView for one browser tab.
 *
 * Architecture: Renders a placeholder <div> and measures its bounds via
 * ResizeObserver. Tells the main process to create/position a native BrowserView there.
 * Unlike iframes, native BrowserViews bypass X-Frame-Options so any URL loads.
 *
 * All tabs stack via CSS Grid ([grid-area:1/1]) in the parent container.
 * The native BrowserView floats above the DOM; overlays only show when view is hidden.
 *
 * Communication channels (each concern gets its own reliable path):
 *   - IPC events: page-load, title-changed, url-change (push from Electron webContents)
 *   - executeJavaScript: console drain + inspect event drain (pull from React)
 *
 * SPA navigation: pushState/replaceState patches in the init script fire
 * browser:url-change events so the URL bar stays current.
 */

import {
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { match } from "ts-pattern";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, Globe } from "lucide-react";
import { native } from "@/platform";
import { BROWSER_PAGE_LOAD, BROWSER_TITLE_CHANGED, BROWSER_URL_CHANGE } from "@shared/events";
import { getErrorMessage } from "@shared/lib/errors";
import type {
  BrowserTabState,
  BrowserTabHandle,
  ConsoleLog,
  ElementSelectedEvent,
  ViewportState,
} from "../types";
import { deriveTitleFromUrl } from "../types";

/** Build emulation params from viewport state + computed scale */
function emulationParams(vp: ViewportState, scale: number) {
  return {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: vp.deviceScaleFactor,
    mobile: vp.mobile ?? false,
    scale,
  };
}

/** Compute WebContentsView bounds and CDP visual scale.
 *  - Viewport fits in panel → center at 1:1
 *  - Viewport exceeds panel → scale to fit (CDP renders full layout, visually shrunk)
 *  - No emulation → fill panel */
function computeViewBounds(
  panelRect: DOMRect,
  vp: ViewportState | null
): { bounds: { x: number; y: number; width: number; height: number }; scale: number } {
  if (!vp) {
    return {
      bounds: { x: panelRect.x, y: panelRect.y, width: panelRect.width, height: panelRect.height },
      scale: 1,
    };
  }
  const scale = Math.min(panelRect.width / vp.width, panelRect.height / vp.height, 1);
  const scaledW = vp.width * scale;
  const scaledH = vp.height * scale;
  const offsetX = (panelRect.width - scaledW) / 2;
  const offsetY = (panelRect.height - scaledH) / 2;
  return {
    bounds: { x: panelRect.x + offsetX, y: panelRect.y + offsetY, width: scaledW, height: scaledH },
    scale,
  };
}
import {
  INSPECT_MODE_SETUP,
  INSPECT_MODE_ENABLE,
  INSPECT_MODE_DISABLE,
  INSPECT_MODE_DRAIN_EVENTS,
  INSPECT_MODE_VERIFY,
} from "../automation/inspect-mode";
import { VISUAL_EFFECTS_SETUP } from "../automation/visual-effects";

/** How often to drain console logs from the webview (ms) */
const CONSOLE_DRAIN_INTERVAL_MS = 1500;
/** How often to drain inspect-mode events from the webview (ms) */
const INSPECT_DRAIN_INTERVAL_MS = 200;

interface BrowserTabProps {
  tab: BrowserTabState;
  /** Update tab state in the parent — (tabId, updates) */
  onUpdateTab: (tabId: string, updates: Partial<BrowserTabState>) => void;
  /** Add a log line to the tab's console — (tabId, level, message) */
  onAddLog: (tabId: string, level: ConsoleLog["level"], message: string) => void;
  /** Whether this tab is the active (visible) tab */
  visible: boolean;
  /** Callback when user selects an element in inspect mode */
  onElementSelected?: (tabId: string, event: ElementSelectedEvent) => void;
  /** Which Electron window to create child BrowserViews in. Defaults to "main". */
  windowLabel?: string;
}

export const BrowserTab = forwardRef<BrowserTabHandle, BrowserTabProps>(function BrowserTab(
  { tab, onUpdateTab, onAddLog, visible, onElementSelected, windowLabel },
  ref
) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  // Ref = source of truth for imperative callbacks (always fresh)
  const webviewCreatedRef = useRef(false);
  // State = triggers effects when webview is ready
  const [webviewReady, setWebviewReady] = useState(false);
  // Track whether first page load completed (show overlay only during initial load)
  const [hasLoaded, setHasLoaded] = useState(false);
  // Brief "completing" state for loading bar finish animation (fill → fade)
  const [completingLoad, setCompletingLoad] = useState(false);
  const completingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard against unmount during async webview creation
  const mountedRef = useRef(true);
  // Debounce bounds sync to one per animation frame
  const rafRef = useRef(0);
  // Track whether automation scripts (inspect mode + visual effects) have been injected
  const automationInjectedRef = useRef(false);
  // Ref to latest tab state — used in event handlers to read current history
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // Guard: suppress history push during back/forward navigation
  // (did-navigate fires for loadURL too, which would double-push)
  const suppressHistoryPushRef = useRef(false);
  // Stable ref for onElementSelected callback (used by the inspect drain loop)
  const onElementSelectedRef = useRef(onElementSelected);
  onElementSelectedRef.current = onElementSelected;
  // Track previous viewport to detect changes. Initialized to `undefined`
  // (not tab.viewport) so persisted viewports are applied on first mount.
  const prevViewportRef = useRef<ViewportState | null | undefined>(undefined);

  const tabId = tab.id;
  const webviewLabel = tab.webviewLabel;

  // --- Unmount guard ---
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
      if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
    };
  }, []);

  // --- Create webview eagerly on mount ---
  // Always create a native BrowserView, even for empty tabs (about:blank).
  // This ensures every tab has a CDP target that agent-browser can discover
  // and navigate directly — no hidden relay view needed.

  const createWebviewIfNeeded = useCallback(
    async (url: string) => {
      if (webviewCreatedRef.current) return;

      // Set flag SYNCHRONOUSLY before await to prevent the auto-navigate
      // effect from re-firing during the async gap (onUpdateTab triggers
      // re-render → effect re-runs → ref still false → duplicate create).
      webviewCreatedRef.current = true;

      const el = placeholderRef.current;
      if (!el) {
        webviewCreatedRef.current = false;
        return;
      }

      const rect = el.getBoundingClientRect();

      // Try to recall a parked view first (view parking keeps native views
      // alive across workspace switches). If the view exists, just reposition
      // and show it — no page reload, preserves scroll/form/login state.
      try {
        const exists = await native.browserViews.viewExists(webviewLabel);
        if (exists) {
          await native.browserViews.setBounds(webviewLabel, {
            x: rect.x,
            y: rect.y,
            width: Math.max(rect.width, 100),
            height: Math.max(rect.height, 100),
          });
          if (!mountedRef.current) return;
          setWebviewReady(true);
          setHasLoaded(true); // page is already loaded in the parked view
          // Re-sync native metadata for parked views — the page may have
          // navigated (redirects, SPA nav) while parked, so hydrated
          // URL/title could be stale. Fetch current values from the view.
          try {
            const currentUrl = await native.browserViews.evaluateWithResult(
              webviewLabel,
              "window.location.href",
              2000
            );
            const currentTitle = await native.browserViews.evaluateWithResult(
              webviewLabel,
              "document.title",
              2000
            );
            if (currentUrl) {
              onUpdateTab(tabId, {
                loading: false,
                currentUrl,
                url: currentUrl,
                title: currentTitle ?? tab.title,
              });
            } else {
              onUpdateTab(tabId, { loading: false });
            }
          } catch {
            onUpdateTab(tabId, { loading: false });
          }
          onAddLog(tabId, "info", `Recalled parked webview: ${webviewLabel}`);
          return;
        }
      } catch (err) {
        // viewExists failed — fall through to create (log for diagnostics)
        onAddLog(tabId, "warn", `viewExists check failed (will create fresh): ${err}`);
      }

      try {
        await native.browserViews.create({
          label: webviewLabel,
          url,
          x: rect.x,
          y: rect.y,
          width: Math.max(rect.width, 100),
          height: Math.max(rect.height, 100),
          windowLabel: windowLabel ?? "main",
        });

        // Guard: component may have unmounted during await
        if (!mountedRef.current) {
          native.browserViews.close(webviewLabel).catch(() => {});
          return;
        }

        setWebviewReady(true);

        // For about:blank (empty tab), mark as loaded immediately so the
        // view is ready for CDP discovery. For real URLs, wait for page-load.
        if (url === "about:blank") {
          setHasLoaded(true);
        }

        // Start hidden — will show after first page load completes
        native.browserViews.hide(webviewLabel).catch(() => {});

        onAddLog(tabId, "info", `Native webview created: ${webviewLabel}`);
      } catch (err) {
        // Reset flag so "Try Again" can re-attempt creation
        webviewCreatedRef.current = false;
        if (!mountedRef.current) return;
        onUpdateTab(tabId, { error: `Failed to create webview: ${err}`, loading: false });
        onAddLog(tabId, "error", `Webview creation failed: ${err}`);
      }
    },
    [webviewLabel, tabId, onUpdateTab, onAddLog, windowLabel]
  );

  // --- Cleanup on unmount ---
  // Only hides the view — does NOT destroy it. Tab destruction is handled
  // explicitly by closeTab() in BrowserPanel. This enables view parking:
  // when switching workspaces, views are parked (hidden) and recalled later
  // without losing page state.
  useEffect(() => {
    const label = webviewLabel;
    return () => {
      if (webviewCreatedRef.current) {
        native.browserViews.hide(label).catch(() => {});
      }
    };
  }, [webviewLabel]);

  // --- Eagerly create webview on mount ---
  // Create the native BrowserView immediately on mount, even if the panel
  // isn't visible yet. Empty tabs load about:blank so they exist as CDP
  // targets — agent-browser discovers and navigates them directly.
  // The view stays hidden until the panel is visible AND a real URL loads.
  useEffect(() => {
    if (webviewCreatedRef.current) return;
    const url = tab.currentUrl || "about:blank";
    const timer = setTimeout(() => {
      if (tab.currentUrl) {
        onUpdateTab(tabId, { loading: true });
      }
      createWebviewIfNeeded(url);
    }, 0);
    return () => clearTimeout(timer);
    // Only run on mount — webview creation is a one-time operation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Show/hide webview based on visibility + load state ---
  // Native webviews render ABOVE the DOM, so we hide them to reveal overlays.
  // Show only when: visible, loaded, has a real URL, and no initial error.
  // Empty tabs (about:blank) stay hidden so the placeholder UI is visible —
  // the native BrowserView still exists as a CDP target for agent-browser.
  const hasRealUrl = !!tab.currentUrl;
  useEffect(() => {
    if (!webviewReady) return;

    if (visible && hasLoaded && hasRealUrl) {
      // Sync bounds before showing (layout may have changed while hidden)
      const el = placeholderRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        native.browserViews
          .setBounds(webviewLabel, {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          })
          .then(() => native.browserViews.show(webviewLabel))
          .catch(() => {});
      } else {
        native.browserViews.show(webviewLabel).catch(() => {});
      }
    } else {
      native.browserViews.hide(webviewLabel).catch(() => {});
    }
  }, [visible, webviewReady, hasLoaded, hasRealUrl, webviewLabel]);

  // --- Sync bounds with ResizeObserver (only when visible & loaded with real URL) ---
  useEffect(() => {
    if (!visible || !webviewReady || !hasLoaded || !hasRealUrl) return;

    const el = placeholderRef.current;
    if (!el) return;

    // Track last applied scale so we only re-call setEmulation when it changes
    let lastScale = 1;

    const syncBounds = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const { bounds, scale } = computeViewBounds(rect, tabRef.current.viewport);
        native.browserViews.setBounds(webviewLabel, bounds).catch(() => {});

        // Re-apply emulation when scale changes (panel resized while viewport active)
        const vp = tabRef.current.viewport;
        if (vp && Math.abs(scale - lastScale) > 0.01) {
          lastScale = scale;
          native.browserViews
            .setEmulation(webviewLabel, emulationParams(vp, scale))
            .catch(() => {});
        }
      });
    };

    const observer = new ResizeObserver(syncBounds);
    observer.observe(el);

    // Also sync on window resize (catches position-only changes)
    window.addEventListener("resize", syncBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      cancelAnimationFrame(rafRef.current);
    };
  }, [visible, webviewReady, hasLoaded, hasRealUrl, webviewLabel]);

  // --- Re-sync bounds when viewport emulation changes ---
  // When the user picks a device preset or clears emulation, the webview bounds
  // need to update: either center the emulated viewport within the panel or fill
  // the panel. The hide → setBounds → show cycle ensures the native compositor
  // repositions the view (setBounds on an already-visible view can be coalesced).
  useLayoutEffect(() => {
    const prev = prevViewportRef.current;
    prevViewportRef.current = tab.viewport;
    // Skip when nothing changed. On first mount prev is `undefined` — only
    // skip if the tab has no viewport to apply (null === null won't match).
    if (prev !== undefined && prev === tab.viewport) return;
    // First mount with no emulation — nothing to apply
    if (prev === undefined && tab.viewport === null) return;

    if (!visible || !webviewReady || !hasLoaded) {
      // Not ready yet — reset so it retries when deps change
      prevViewportRef.current = undefined;
      return;
    }
    const el = placeholderRef.current;
    if (!el || !webviewCreatedRef.current) return;

    const panelRect = el.getBoundingClientRect();
    if (panelRect.width === 0 || panelRect.height === 0) return;

    // Hide after confirming non-zero bounds (avoids permanently hidden view)
    native.browserViews.hide(webviewLabel).catch(() => {});

    const { bounds, scale } = computeViewBounds(panelRect, tab.viewport);

    // Apply emulation or clear it, then position the view
    const applyEmulation = tab.viewport
      ? native.browserViews.setEmulation(webviewLabel, emulationParams(tab.viewport, scale))
      : native.browserViews.clearEmulation(webviewLabel);

    applyEmulation
      .then(() => native.browserViews.setBounds(webviewLabel, bounds))
      .then(() => native.browserViews.show(webviewLabel))
      .catch(() => {});
  }, [tab.viewport, visible, webviewReady, hasLoaded, webviewLabel]);

  // --- IPC event listeners (page load, title, SPA nav) ---
  useEffect(() => {
    const unlistenFns: Array<() => void> = [];

    // Track whether did-fail-load fired for this navigation cycle.
    // Electron fires events: did-start-loading → did-fail-load → did-stop-loading.
    // Without this flag, "finished" (did-stop-loading) overwrites the error state.
    let didFailForCurrentNav = false;

    // Page load events
    unlistenFns.push(
      native.events.on(BROWSER_PAGE_LOAD, (data) => {
        const { label, url, event: eventType } = data;
        if (label !== webviewLabel) return;

        if (eventType === "started") {
          didFailForCurrentNav = false;
          // Clear any pending completion animation
          if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
          setCompletingLoad(false);
          // Reset injection flag — new page context destroys window.__deusVisuals
          automationInjectedRef.current = false;
          // Don't reset hasLoaded — once the first page has loaded, keep the
          // BrowserView visible. Subsequent navigations (redirects, SPA nav,
          // meta refresh) show the top loading bar, not the full-screen spinner.
          onUpdateTab(tabId, { loading: true });
        } else if (eventType === "finished") {
          // Skip if did-fail-load already fired — don't overwrite error state.
          // Electron always fires did-stop-loading after did-fail-load.
          if (didFailForCurrentNav) return;
          setHasLoaded(true);
          // Trigger completion animation (bar fills to 100% → fades)
          setCompletingLoad(true);
          completingTimerRef.current = setTimeout(() => setCompletingLoad(false), 500);
          onUpdateTab(tabId, { loading: false, currentUrl: url, error: null });
          onAddLog(tabId, "info", `Page loaded: ${url}`);
        } else if (eventType === "failed") {
          didFailForCurrentNav = true;
          // Clear loading bar animation
          if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
          setCompletingLoad(false);
          // Show error overlay instead of infinite spinner
          setHasLoaded(true);
          const errorDesc = data.error?.description ?? "Page failed to load";
          onUpdateTab(tabId, { loading: false, error: errorDesc });
          onAddLog(tabId, "error", `Page failed to load: ${errorDesc}`);
        }
      })
    );

    // Title change events (regular, non-deus title changes)
    unlistenFns.push(
      native.events.on(BROWSER_TITLE_CHANGED, (data) => {
        const { label, title } = data;
        if (label !== webviewLabel) return;
        onUpdateTab(tabId, { title });
      })
    );

    // Navigation events (did-navigate, did-navigate-in-page, pushState/replaceState)
    // Push to history so back/forward buttons work for all navigations.
    unlistenFns.push(
      native.events.on(BROWSER_URL_CHANGE, (data) => {
        const { label, url } = data;
        if (label !== webviewLabel) return;
        // Ignore about:blank — it's the initial empty tab state, not a real navigation
        if (url === "about:blank") return;

        // Suppress history push from programmatic back/forward navigation
        if (suppressHistoryPushRef.current) {
          suppressHistoryPushRef.current = false;
          onUpdateTab(tabId, { url, currentUrl: url, title: deriveTitleFromUrl(url) });
          return;
        }

        const current = tabRef.current;
        // Skip duplicate URLs (e.g. hash-only changes that resolve to same URL)
        if (current.currentUrl === url) {
          onUpdateTab(tabId, { title: deriveTitleFromUrl(url) });
          return;
        }
        // Truncate forward history and append the new URL
        const newHistory = current.history.slice(0, current.historyIndex + 1);
        newHistory.push(url);
        onUpdateTab(tabId, {
          url,
          currentUrl: url,
          title: deriveTitleFromUrl(url),
          history: newHistory,
          historyIndex: newHistory.length - 1,
        });
      })
    );

    // Console logs are drained via eval_browser_webview_with_result in the
    // "Periodic console drain" effect below.
    //
    // Inspect mode events are delivered SOLELY via buffer + drain polling
    // (eval_browser_webview_with_result every 200ms). We intentionally do NOT
    // use the title-channel for inspect events — it has two independent writers
    // (BROWSER_INIT_SCRIPT's SPA nav + inspect script) racing on document.title,
    // causing silent message loss via WKWebView's title-change coalescing.

    return () => unlistenFns.forEach((fn) => fn());
  }, [webviewLabel, tabId, onUpdateTab, onAddLog]);

  // --- Periodic console drain (only when visible and webview ready) ---
  // Uses eval_browser_webview_with_result (native completion handler) instead
  // of the old title-channel approach (drain_browser_console). The title-channel
  // suffers from WKWebView's title-change coalescing — when the 60ms restore
  // window overlaps with another title write (SPA nav, page itself), the
  // \x01CL: message is silently dropped and console logs are lost.
  //
  // The completion-handler path reads the log buffer directly and returns the
  // JSON via WKWebView's evaluateJavaScript callback, which is reliable.
  useEffect(() => {
    if (!visible || !webviewReady || !hasLoaded) return;

    // Drain console logs AND detect agent-initiated viewport changes.
    // Viewport dimensions (innerWidth/innerHeight) are piggybacked onto the
    // existing 1500ms drain to avoid adding a separate polling interval.
    const CONSOLE_DRAIN_JS = `(function(){
      var b = window.__DEUS_LOGS__ || [];
      window.__DEUS_LOGS__ = [];
      return JSON.stringify({logs:b,vw:window.innerWidth,vh:window.innerHeight});
    })()`;

    // Track consecutive failures for diagnostic logging
    let consoleDrainFails = 0;
    // Guard against overlapping async drains — if invoke() takes longer than
    // the interval, skip until the previous call completes.
    let inFlight = false;

    const interval = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await native.browserViews.evaluateWithResult(
          webviewLabel,
          CONSOLE_DRAIN_JS,
          2000
        );
        // Reset on success
        consoleDrainFails = 0;

        if (!result || result === "{}" || result === "undefined") return;

        let parsed: { logs?: Array<{ l: string; m: string; t: number }>; vw?: number; vh?: number };
        try {
          parsed = JSON.parse(result);
        } catch (parseErr) {
          console.error(
            "[BrowserTab] console drain: JSON.parse failed",
            parseErr,
            "raw:",
            result.slice(0, 200)
          );
          return;
        }

        // Detect agent-initiated viewport changes via innerWidth/innerHeight
        const { vw, vh } = parsed;
        const currentVp = tabRef.current.viewport;
        if (vw && vh && currentVp && (vw !== currentVp.width || vh !== currentVp.height)) {
          // Agent changed viewport dimensions — sync dropdown
          onUpdateTab(tabId, {
            viewport: {
              width: vw,
              height: vh,
              deviceScaleFactor: currentVp.deviceScaleFactor,
              mobile: currentVp.mobile,
            },
          });
        }

        const logs = parsed.logs;
        if (!logs || logs.length === 0) return;
        for (const log of logs) {
          const level = match(log.l)
            .with("warn", () => "warn" as const)
            .with("error", () => "error" as const)
            .with("debug", () => "debug" as const)
            .otherwise(() => "info" as const);
          onAddLog(tabId, level, log.m);
        }
      } catch (err) {
        consoleDrainFails++;
        if (consoleDrainFails <= 3 || consoleDrainFails % 50 === 0) {
          console.warn(
            `[BrowserTab] console drain failed (${consoleDrainFails}x):`,
            getErrorMessage(err)
          );
        }
      } finally {
        inFlight = false;
      }
    }, CONSOLE_DRAIN_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [visible, webviewReady, hasLoaded, webviewLabel, tabId, onAddLog, onUpdateTab]);

  // --- Periodic inspect event drain (only when selector is active) ---
  // Drains buffered events from the inject script via
  // eval_browser_webview_with_result (native completion handler).
  // This is the sole delivery path for inspect events — we do not use
  // the title-channel for inspect events (see file-level comment).
  useEffect(() => {
    if (!visible || !webviewReady || !hasLoaded || !tab.selectorActive) return;

    // Flush stale events accumulated while tab was hidden — prevents
    // inserting unintended elements into chat on tab re-activation.
    native.browserViews
      .evaluateWithResult(webviewLabel, INSPECT_MODE_DRAIN_EVENTS, 2000)
      .catch(() => {});

    // Track consecutive failures to avoid log spam (log first 3, then every 50th)
    let failCount = 0;
    // Guard against overlapping async drains — if invoke() takes longer than
    // the interval, skip until the previous call completes.
    let inFlight = false;

    const interval = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await native.browserViews.evaluateWithResult(
          webviewLabel,
          INSPECT_MODE_DRAIN_EVENTS,
          2000
        );
        // Reset fail counter on success
        failCount = 0;

        if (!result || result === "[]" || result === "undefined") return;

        let events: Array<{ type: string; data: Record<string, unknown> }>;
        try {
          events = JSON.parse(result);
        } catch (parseErr) {
          // JSON parse failure — log the raw result for debugging
          console.error(
            "[BrowserTab] inspect drain: JSON.parse failed",
            parseErr,
            "raw result:",
            result.slice(0, 200)
          );
          return;
        }

        for (const evt of events) {
          match(evt.type)
            .with("element-event", () => {
              const parsed = evt.data as unknown as ElementSelectedEvent;
              onElementSelectedRef.current?.(tabId, parsed);
              onAddLog(
                tabId,
                "info",
                parsed.type === "area-selected"
                  ? `Area selected: ${parsed.bounds?.width}\u00d7${parsed.bounds?.height}`
                  : `Element selected: ${parsed.element?.tagName}${parsed.reactComponent ? ` (${parsed.reactComponent.name})` : ""}`
              );
            })
            .with("selection-mode", () => {
              const modeData = evt.data as { active: boolean };
              onUpdateTab(tabId, { selectorActive: modeData.active });
            })
            .otherwise(() => {});
        }
      } catch (err) {
        failCount++;
        if (failCount <= 3 || failCount % 50 === 0) {
          console.warn(`[BrowserTab] inspect drain failed (${failCount}x):`, getErrorMessage(err));
        }
      } finally {
        inFlight = false;
      }
    }, INSPECT_DRAIN_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [
    visible,
    webviewReady,
    hasLoaded,
    tab.selectorActive,
    webviewLabel,
    tabId,
    onUpdateTab,
    onAddLog,
  ]);

  // --- Imperative methods exposed to parent ---

  const navigateToUrl = useCallback(
    async (url: string) => {
      if (!webviewCreatedRef.current) {
        // First navigation — create webview with this URL
        await createWebviewIfNeeded(url);
      } else {
        // Webview exists — navigate it
        try {
          await native.browserViews.navigate(webviewLabel, url);
        } catch (err) {
          onAddLog(tabId, "error", `Navigation failed: ${err}`);
        }
      }
    },
    [webviewLabel, tabId, createWebviewIfNeeded, onAddLog]
  );

  /** Navigate using native goBack/goForward — preserves scroll/form state */
  const goBack = useCallback(() => {
    if (!webviewCreatedRef.current) return;
    suppressHistoryPushRef.current = true;
    native.browserViews.goBack(webviewLabel).catch((err) => {
      suppressHistoryPushRef.current = false;
      onAddLog(tabId, "error", `Go back failed: ${err}`);
    });
  }, [webviewLabel, tabId, onAddLog]);

  const goForward = useCallback(() => {
    if (!webviewCreatedRef.current) return;
    suppressHistoryPushRef.current = true;
    native.browserViews.goForward(webviewLabel).catch((err) => {
      suppressHistoryPushRef.current = false;
      onAddLog(tabId, "error", `Go forward failed: ${err}`);
    });
  }, [webviewLabel, tabId, onAddLog]);

  const reload = useCallback(() => {
    if (!webviewCreatedRef.current) return;
    native.browserViews.reload(webviewLabel).catch((err) => {
      onAddLog(tabId, "error", `Reload failed: ${err}`);
    });
  }, [webviewLabel, tabId, onAddLog]);

  // Inject visual effects and inspect mode into the BrowserView.
  // Uses fire-and-forget eval for dispatch + eval_with_result for verification
  // (fire-and-forget can't detect JS runtime errors in the IIFE).
  const injectAutomation = useCallback(async () => {
    if (!webviewCreatedRef.current) return;
    if (automationInjectedRef.current) {
      onAddLog(tabId, "info", "Automation already injected");
      return;
    }

    try {
      // Inject visual effects and inspect mode via native eval
      await native.browserViews.evaluate(webviewLabel, INSPECT_MODE_SETUP);
      await native.browserViews.evaluate(webviewLabel, VISUAL_EFFECTS_SETUP);

      // Verify inspect mode — evaluate() already waited for the IPC round-trip
      try {
        const verifyResult = await native.browserViews.evaluateWithResult(
          webviewLabel,
          INSPECT_MODE_VERIFY,
          3000
        );
        if (!verifyResult) return;
        const status = JSON.parse(verifyResult);
        if (!status.deusInspect || !status.hasDrainEvents) {
          onAddLog(tabId, "error", `Inspect mode setup incomplete: ${JSON.stringify(status)}`);
          return; // Don't mark as injected
        }
      } catch (verifyErr) {
        onAddLog(tabId, "warn", `Inspect verification failed: ${getErrorMessage(verifyErr)}`);
        return;
      }

      automationInjectedRef.current = true;
      onUpdateTab(tabId, { injected: true, injectionFailed: false });
      onAddLog(tabId, "info", "Automation scripts injected successfully");
    } catch (err) {
      onAddLog(tabId, "error", `Injection failed: ${getErrorMessage(err)}`);
      onUpdateTab(tabId, { injectionFailed: true });
    }
  }, [tabId, webviewLabel, onUpdateTab, onAddLog]);

  // Auto-inject on first page load — single call to injectAutomation().
  useEffect(() => {
    if (!hasLoaded || automationInjectedRef.current) return;
    injectAutomation();
  }, [hasLoaded, injectAutomation]);

  const toggleElementSelector = useCallback(async () => {
    if (!webviewCreatedRef.current) return;

    // Auto-inject if not yet injected
    if (!automationInjectedRef.current) {
      await injectAutomation();
    }

    const enabling = !tab.selectorActive;
    const js = enabling ? INSPECT_MODE_ENABLE : INSPECT_MODE_DISABLE;

    // Use eval_browser_webview_with_result for the toggle so we can detect
    // JS errors. The ENABLE/DISABLE IIFEs don't return a value (undefined),
    // but any thrown error will be reported via the completion handler.
    try {
      await native.browserViews.evaluateWithResult(webviewLabel, js, 3000);
      onAddLog(tabId, "info", enabling ? "Inspect mode activated" : "Inspect mode deactivated");
      onUpdateTab(tabId, { selectorActive: enabling });
    } catch (err) {
      onAddLog(tabId, "error", `Inspect mode toggle failed: ${getErrorMessage(err)}`);
    }
  }, [webviewLabel, tabId, tab.selectorActive, injectAutomation, onUpdateTab, onAddLog]);

  useImperativeHandle(
    ref,
    () => ({
      navigateToUrl,
      goBack,
      goForward,
      reload,
      injectAutomation,
      toggleElementSelector,
    }),
    [navigateToUrl, goBack, goForward, reload, injectAutomation, toggleElementSelector]
  );

  return (
    // Placeholder div — native webview is positioned to overlay this area.
    //
    // All tabs stack in the same grid cell via [grid-area:1/1] (parent is
    // display:grid). This replaced the old `absolute inset-0` wrapper because
    // absolute positioning didn't reliably inherit width constraints from the
    // containing block when parent containers toggled mobile view (w-full ↔
    // w-[390px] + mx-auto). getBoundingClientRect() returned stale full-width
    // values, so the native WKWebView never repositioned. Grid stacking keeps
    // tabs in normal document flow — they inherit the container's width
    // naturally and ResizeObserver fires on actual size changes.
    <div ref={placeholderRef} className="relative [grid-area:1/1]">
      {/* Loading progress bar — NProgress-style, top of viewport.
       * Shows during page loads (indeterminate animation → fills to 92%).
       * On load complete: fills to 100% then fades out.
       * Uses transform: scaleX() for GPU-accelerated animation. */}
      {visible && (tab.loading || completingLoad) && (
        <div
          className="bg-primary absolute inset-x-0 top-0 z-10 h-[2px] origin-left"
          style={{
            animation: tab.loading
              ? "browser-loading 8s cubic-bezier(.19,1,.22,1) forwards"
              : "browser-loading-complete 0.4s ease-out forwards",
          }}
        />
      )}

      {/* Empty state: no URL entered yet — minimal, engineer-friendly.
       * The native BrowserView (about:blank) exists behind this overlay as a
       * CDP target, but we show the placeholder UI until the user navigates. */}
      {visible && !tab.currentUrl && (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <div className="bg-muted/50 flex h-10 w-10 items-center justify-center rounded-xl">
            <Globe
              className="text-muted-foreground/60 h-5 w-5"
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </div>
          <div className="text-center">
            <p className="text-muted-foreground text-sm">
              Paste a URL above or ask the Agent to browse
            </p>
            <p className="text-muted-foreground/40 mt-1 text-xs">
              Supports any website — cookies, auth, and devtools included
            </p>
          </div>
        </div>
      )}

      {/* Loading overlay: only during initial page load (webview hidden) */}
      {visible && tab.loading && !hasLoaded && (
        <div className="vibrancy-bg absolute inset-0 flex items-center justify-center">
          <Loader2 className="text-primary h-8 w-8 animate-spin" />
        </div>
      )}

      {/* Error overlay: shown whenever the page has a load error */}
      {visible && tab.error && (
        <div className="vibrancy-bg absolute inset-0 flex items-center justify-center">
          <div className="max-w-sm p-8 text-center">
            <div className="bg-destructive/10 mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl">
              <AlertCircle className="text-destructive h-5 w-5" />
            </div>
            <h3 className="mb-1 text-sm font-semibold">Unable to Load Page</h3>
            <p className="text-muted-foreground mb-4 text-xs">{tab.error}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onUpdateTab(tabId, { error: null });
                if (tab.currentUrl) navigateToUrl(tab.currentUrl);
              }}
            >
              Try Again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});
