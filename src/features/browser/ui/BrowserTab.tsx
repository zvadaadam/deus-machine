/**
 * BrowserTab — native Tauri webview for one browser tab.
 *
 * Architecture: Renders a placeholder <div> and measures its bounds via
 * ResizeObserver. Tells Rust to create/position a native WKWebView there.
 * Unlike iframes, native webviews bypass X-Frame-Options so any URL loads.
 *
 * All tabs use absolute positioning (inset-0) so bounds are always measurable.
 * The native webview floats above the DOM; overlays only show when webview is hidden.
 *
 * Communication: Tauri events (browser:page-load, browser:title-changed,
 * browser:url-change, browser:console) replace iframe onLoad/postMessage.
 *
 * Console capture: An initialization_script on the Rust side intercepts
 * console.log/warn/error/debug and buffers them. This tab component
 * periodically drains the buffer (every 1.5s) via drain_browser_console,
 * which flushes logs through the title-channel bridge.
 *
 * SPA navigation: pushState/replaceState patches in the init script fire
 * browser:url-change events so the URL bar stays current.
 */

import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, Globe } from "lucide-react";
import { invoke, listen } from "@/platform/tauri";
import type { BrowserTabState, BrowserTabHandle, ConsoleLog, ElementSelectedEvent } from "../types";
import { deriveTitleFromUrl } from "../types";
import {
  INSPECT_MODE_SETUP,
  INSPECT_MODE_ENABLE,
  INSPECT_MODE_DISABLE,
} from "../automation/inspect-mode";
import { VISUAL_EFFECTS_SETUP } from "../automation/visual-effects";

/** How often to drain console logs from the webview (ms) */
const CONSOLE_DRAIN_INTERVAL_MS = 1500;

interface BrowserTabProps {
  tab: BrowserTabState;
  devBrowserStatus: { running: boolean; port: number | null; error: string | null };
  /** Update tab state in the parent — (tabId, updates) */
  onUpdateTab: (tabId: string, updates: Partial<BrowserTabState>) => void;
  /** Add a log line to the tab's console — (tabId, level, message) */
  onAddLog: (tabId: string, level: ConsoleLog["level"], message: string) => void;
  /** Whether this tab is the active (visible) tab */
  visible: boolean;
  /** Callback when user selects an element in inspect mode */
  onElementSelected?: (tabId: string, event: ElementSelectedEvent) => void;
  /** Which Tauri window to create child webviews in. Defaults to "main". */
  windowLabel?: string;
}

export const BrowserTab = forwardRef<BrowserTabHandle, BrowserTabProps>(function BrowserTab(
  {
    tab,
    devBrowserStatus: _devBrowserStatus,
    onUpdateTab,
    onAddLog,
    visible,
    onElementSelected,
    windowLabel,
  },
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

  // --- Create webview (lazy, on first navigation) ---

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
      try {
        await invoke("create_browser_webview", {
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
          invoke("close_browser_webview", { label: webviewLabel }).catch(() => {});
          return;
        }

        setWebviewReady(true);

        // Start hidden — will show after first page load completes
        invoke("hide_browser_webview", { label: webviewLabel }).catch(() => {});

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
  useEffect(() => {
    const label = webviewLabel;
    return () => {
      if (webviewCreatedRef.current) {
        invoke("close_browser_webview", { label }).catch(() => {});
        webviewCreatedRef.current = false;
      }
    };
  }, [webviewLabel]);

  // --- Auto-navigate hydrated tabs (restored from workspace persistence) ---
  // When a tab mounts with a persisted URL but no webview, auto-create it.
  // This handles workspace-switch where old webviews are destroyed and new
  // BrowserTab components mount with pre-filled URLs from the layout store.
  useEffect(() => {
    if (!visible || webviewCreatedRef.current || !tab.currentUrl) return;
    // Schedule async to avoid cascading renders from setState in effect
    const timer = setTimeout(() => {
      onUpdateTab(tabId, { loading: true });
      createWebviewIfNeeded(tab.currentUrl);
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, tab.currentUrl, tabId, createWebviewIfNeeded, onUpdateTab]);

  // --- Show/hide webview based on visibility + load state ---
  // Native webviews render ABOVE the DOM, so we hide them to reveal overlays.
  // Show only when: visible, loaded, and no initial error.
  useEffect(() => {
    if (!webviewReady) return;

    if (visible && hasLoaded) {
      // Sync bounds before showing (layout may have changed while hidden)
      const el = placeholderRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        invoke("set_browser_webview_bounds", {
          label: webviewLabel,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })
          .then(() => invoke("show_browser_webview", { label: webviewLabel }))
          .catch(() => {});
      } else {
        invoke("show_browser_webview", { label: webviewLabel }).catch(() => {});
      }
    } else {
      invoke("hide_browser_webview", { label: webviewLabel }).catch(() => {});
    }
  }, [visible, webviewReady, hasLoaded, webviewLabel]);

  // --- Sync bounds with ResizeObserver (only when visible & loaded) ---
  useEffect(() => {
    if (!visible || !webviewReady || !hasLoaded) return;

    const el = placeholderRef.current;
    if (!el) return;

    const syncBounds = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        invoke("set_browser_webview_bounds", {
          label: webviewLabel,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }).catch(() => {});
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
  }, [visible, webviewReady, hasLoaded, webviewLabel]);

  // --- Tauri event listeners (page load, title, SPA nav, console) ---
  useEffect(() => {
    let unlistenLoad: (() => void) | null = null;
    let unlistenTitle: (() => void) | null = null;
    let unlistenUrlChange: (() => void) | null = null;
    let unlistenConsole: (() => void) | null = null;
    let unlistenElementSelected: (() => void) | null = null;
    let unlistenSelectionMode: (() => void) | null = null;

    // Page load events
    listen<{ label: string; url: string; event: string }>(
      "browser:page-load",
      (evt: { payload: { label: string; url: string; event: string } }) => {
        const { label, url, event: eventType } = evt.payload;
        if (label !== webviewLabel) return;

        if (eventType === "started") {
          // Clear any pending completion animation
          if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
          setCompletingLoad(false);
          // Reset injection flag — new page context destroys window.__hiveVisuals
          automationInjectedRef.current = false;
          setHasLoaded(false);
          onUpdateTab(tabId, { loading: true });
        } else if (eventType === "finished") {
          setHasLoaded(true);
          // Trigger completion animation (bar fills to 100% → fades)
          setCompletingLoad(true);
          completingTimerRef.current = setTimeout(() => setCompletingLoad(false), 500);
          onUpdateTab(tabId, { loading: false, currentUrl: url, error: null });
          onAddLog(tabId, "info", `Page loaded: ${url}`);
        }
      }
    ).then((unsub: () => void) => {
      unlistenLoad = unsub;
    });

    // Title change events (regular, non-hive title changes)
    listen<{ label: string; title: string }>(
      "browser:title-changed",
      (evt: { payload: { label: string; title: string } }) => {
        const { label, title } = evt.payload;
        if (label !== webviewLabel) return;
        onUpdateTab(tabId, { title });
      }
    ).then((unsub: () => void) => {
      unlistenTitle = unsub;
    });

    // SPA navigation events (pushState/replaceState detected by init script)
    listen<{ label: string; url: string }>(
      "browser:url-change",
      (evt: { payload: { label: string; url: string } }) => {
        const { label, url } = evt.payload;
        if (label !== webviewLabel) return;
        // Update URL bar and current URL, derive new title
        onUpdateTab(tabId, {
          url,
          currentUrl: url,
          title: deriveTitleFromUrl(url),
        });
      }
    ).then((unsub: () => void) => {
      unlistenUrlChange = unsub;
    });

    // Console drain events (buffered logs flushed via title channel)
    listen<{ label: string; logs: string }>(
      "browser:console",
      (evt: { payload: { label: string; logs: string } }) => {
        const { label, logs: logsJson } = evt.payload;
        if (label !== webviewLabel) return;
        try {
          const logs: Array<{ l: string; m: string; t: number }> = JSON.parse(logsJson);
          for (const log of logs) {
            const level = (
              log.l === "warn"
                ? "warn"
                : log.l === "error"
                  ? "error"
                  : log.l === "debug"
                    ? "debug"
                    : "info"
            ) as ConsoleLog["level"];
            onAddLog(tabId, level, log.m);
          }
        } catch {
          // Invalid JSON from title channel — silently ignore
        }
      }
    ).then((unsub: () => void) => {
      unlistenConsole = unsub;
    });

    // Inspect mode: element selected (click or drag-select)
    listen<{ label: string; data: string }>(
      "browser:element-selected",
      (evt: { payload: { label: string; data: string } }) => {
        const { label, data } = evt.payload;
        if (label !== webviewLabel) return;
        try {
          const parsed = JSON.parse(data) as ElementSelectedEvent;
          onElementSelected?.(tabId, parsed);
          onAddLog(
            tabId,
            "info",
            parsed.type === "area-selected"
              ? `Area selected: ${parsed.bounds?.width}×${parsed.bounds?.height}`
              : `Element selected: ${parsed.element?.tagName}${parsed.reactComponent ? ` (${parsed.reactComponent.name})` : ""}`
          );
        } catch {
          // Invalid JSON — silently ignore
        }
      }
    ).then((unsub: () => void) => {
      unlistenElementSelected = unsub;
    });

    // Inspect mode: selection mode state change (enabled/disabled via Escape)
    listen<{ label: string; data: string }>(
      "browser:selection-mode",
      (evt: { payload: { label: string; data: string } }) => {
        const { label, data } = evt.payload;
        if (label !== webviewLabel) return;
        try {
          const parsed = JSON.parse(data) as { active: boolean };
          onUpdateTab(tabId, { selectorActive: parsed.active });
        } catch {
          // Invalid JSON — silently ignore
        }
      }
    ).then((unsub: () => void) => {
      unlistenSelectionMode = unsub;
    });

    return () => {
      unlistenLoad?.();
      unlistenTitle?.();
      unlistenUrlChange?.();
      unlistenConsole?.();
      unlistenElementSelected?.();
      unlistenSelectionMode?.();
    };
  }, [webviewLabel, tabId, onUpdateTab, onAddLog, onElementSelected]);

  // --- Periodic console drain (only when visible and webview ready) ---
  useEffect(() => {
    if (!visible || !webviewReady || !hasLoaded) return;

    const interval = setInterval(() => {
      invoke("drain_browser_console", { label: webviewLabel }).catch(() => {});
    }, CONSOLE_DRAIN_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [visible, webviewReady, hasLoaded, webviewLabel]);

  // --- Auto-inject visual effects on first page load ---
  // Visual effects (AI cursor + ripple) are lightweight and always useful
  // because the sidecar may operate the browser at any time.
  // Inspect mode is NOT auto-injected — it's only enabled on user action.
  useEffect(() => {
    if (!hasLoaded || automationInjectedRef.current) return;

    // Inject both scripts so they're ready for AI operations and inspect mode
    Promise.all([
      invoke("eval_browser_webview", { label: webviewLabel, js: VISUAL_EFFECTS_SETUP }),
      invoke("eval_browser_webview", { label: webviewLabel, js: INSPECT_MODE_SETUP }),
    ])
      .then(() => {
        automationInjectedRef.current = true;
        onUpdateTab(tabId, { injected: true });
      })
      .catch(() => {});
  }, [hasLoaded, webviewLabel, tabId, onUpdateTab]);

  // --- Imperative methods exposed to parent ---

  const navigateToUrl = useCallback(
    async (url: string) => {
      if (!webviewCreatedRef.current) {
        // First navigation — create webview with this URL
        await createWebviewIfNeeded(url);
      } else {
        // Webview exists — navigate it
        try {
          await invoke("navigate_browser_webview", { label: webviewLabel, url });
        } catch (err) {
          onAddLog(tabId, "error", `Navigation failed: ${err}`);
        }
      }
    },
    [webviewLabel, tabId, createWebviewIfNeeded, onAddLog]
  );

  const reload = useCallback(() => {
    if (!webviewCreatedRef.current) return;
    invoke("reload_browser_webview", { label: webviewLabel }).catch((err) => {
      onAddLog(tabId, "error", `Reload failed: ${err}`);
    });
  }, [webviewLabel, tabId, onAddLog]);

  const injectAutomation = useCallback(async () => {
    if (!webviewCreatedRef.current) return;
    if (automationInjectedRef.current) {
      onAddLog(tabId, "info", "Automation already injected");
      return;
    }

    try {
      // Inject inspect mode + visual effects via native eval (no HTTP fetch needed)
      await invoke("eval_browser_webview", { label: webviewLabel, js: INSPECT_MODE_SETUP });
      await invoke("eval_browser_webview", { label: webviewLabel, js: VISUAL_EFFECTS_SETUP });
      automationInjectedRef.current = true;
      onUpdateTab(tabId, { injected: true });
      onAddLog(tabId, "info", "Automation scripts injected (inspect mode + visual effects)");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onAddLog(tabId, "error", `Injection failed: ${errorMsg}`);
    }
  }, [tabId, webviewLabel, onUpdateTab, onAddLog]);

  const toggleElementSelector = useCallback(async () => {
    if (!webviewCreatedRef.current) return;

    // Auto-inject if not yet injected
    if (!automationInjectedRef.current) {
      await injectAutomation();
    }

    const js = tab.selectorActive ? INSPECT_MODE_DISABLE : INSPECT_MODE_ENABLE;
    invoke("eval_browser_webview", { label: webviewLabel, js }).catch(() => {});
    onUpdateTab(tabId, { selectorActive: !tab.selectorActive });
    onAddLog(
      tabId,
      "info",
      tab.selectorActive ? "Inspect mode deactivated" : "Inspect mode activated"
    );
  }, [webviewLabel, tabId, tab.selectorActive, injectAutomation, onUpdateTab, onAddLog]);

  useImperativeHandle(
    ref,
    () => ({ navigateToUrl, reload, injectAutomation, toggleElementSelector }),
    [navigateToUrl, reload, injectAutomation, toggleElementSelector]
  );

  return (
    // All tabs use absolute positioning so bounds are always measurable
    // (native webview show/hide controls visibility, not CSS display)
    <div className="absolute inset-0">
      {/* Placeholder div — native webview is positioned to overlay this area */}
      <div ref={placeholderRef} className="relative h-full w-full">
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

        {/* Empty state: no URL entered yet — minimal, engineer-friendly */}
        {visible && !webviewReady && !tab.currentUrl && (
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

        {/* Error overlay: only if initial load failed */}
        {visible && tab.error && !hasLoaded && (
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
    </div>
  );
});
