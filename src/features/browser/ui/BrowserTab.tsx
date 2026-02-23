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
 * Communication channels (each concern gets its own reliable path):
 *   - Tauri events: page-load, title-changed, url-change (push from Rust KVO)
 *   - Completion handler: console drain + inspect event drain (pull from React)
 *
 * Console & inspect events are both drained via eval_browser_webview_with_result
 * (WKWebView's native evaluateJavaScript:completionHandler:). We do NOT use the
 * title-channel (document.title) for inspect events — it has a race condition
 * with BROWSER_INIT_SCRIPT's SPA nav detection (two independent writers on
 * document.title causes WKWebView KVO to silently coalesce/drop messages).
 *
 * SPA navigation: pushState/replaceState patches in the init script fire
 * browser:url-change events so the URL bar stays current.
 */

import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { match } from "ts-pattern";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, Globe } from "lucide-react";
import { invoke, listen } from "@/platform/tauri";
import type { BrowserTabState, BrowserTabHandle, ConsoleLog, ElementSelectedEvent } from "../types";
import { deriveTitleFromUrl } from "../types";
import {
  INSPECT_MODE_SETUP,
  INSPECT_MODE_ENABLE,
  INSPECT_MODE_DISABLE,
  INSPECT_MODE_DRAIN_EVENTS,
  INSPECT_MODE_VERIFY,
} from "../automation/inspect-mode";
import { VISUAL_EFFECTS_SETUP } from "../automation/visual-effects";
import { BROWSER_UTILS_SETUP } from "../automation/browser-utils";

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
  // Stable ref for onElementSelected callback (used by the inspect drain loop)
  const onElementSelectedRef = useRef(onElementSelected);
  onElementSelectedRef.current = onElementSelected;

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
    let aborted = false;
    const unsubs: Array<() => void> = [];

    /** Register a Tauri listener with race-safe cleanup */
    function safeListen<T>(event: string, handler: (evt: { payload: T }) => void) {
      listen<T>(event, handler).then((unsub) => {
        if (aborted) { unsub(); return; }
        unsubs.push(unsub);
      }).catch((err) => {
        if (!aborted) {
          console.warn(`[BrowserTab] listen(${event}) failed`, err);
        }
      });
    }

    // Page load events
    safeListen<{ label: string; url: string; event: string }>(
      "browser:page-load",
      (evt) => {
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
    );

    // Title change events (regular, non-hive title changes)
    safeListen<{ label: string; title: string }>(
      "browser:title-changed",
      (evt) => {
        const { label, title } = evt.payload;
        if (label !== webviewLabel) return;
        onUpdateTab(tabId, { title });
      }
    );

    // SPA navigation events (pushState/replaceState detected by init script)
    safeListen<{ label: string; url: string }>(
      "browser:url-change",
      (evt) => {
        const { label, url } = evt.payload;
        if (label !== webviewLabel) return;
        // Update URL bar and current URL, derive new title
        onUpdateTab(tabId, {
          url,
          currentUrl: url,
          title: deriveTitleFromUrl(url),
        });
      }
    );

    // Console logs are drained via eval_browser_webview_with_result in the
    // "Periodic console drain" effect below.
    //
    // Inspect mode events are delivered SOLELY via buffer + drain polling
    // (eval_browser_webview_with_result every 200ms). We intentionally do NOT
    // use the title-channel for inspect events — it has two independent writers
    // (BROWSER_INIT_SCRIPT's SPA nav + inspect script) racing on document.title,
    // causing silent message loss via WKWebView's title-change coalescing.

    return () => {
      aborted = true;
      unsubs.forEach((fn) => fn());
    };
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

    const CONSOLE_DRAIN_JS = `(function(){
      var b = window.__HIVE_LOGS__ || [];
      window.__HIVE_LOGS__ = [];
      return JSON.stringify(b);
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
        const result = await invoke<string>("eval_browser_webview_with_result", {
          label: webviewLabel,
          js: CONSOLE_DRAIN_JS,
          timeoutMs: 2000,
        });
        // Reset on success
        consoleDrainFails = 0;

        if (!result || result === "[]" || result === "undefined") return;

        let logs: Array<{ l: string; m: string; t: number }>;
        try {
          logs = JSON.parse(result);
        } catch (parseErr) {
          console.error("[BrowserTab] console drain: JSON.parse failed", parseErr, "raw:", result.slice(0, 200));
          return;
        }
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
            err instanceof Error ? err.message : String(err)
          );
        }
      } finally {
        inFlight = false;
      }
    }, CONSOLE_DRAIN_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [visible, webviewReady, hasLoaded, webviewLabel, tabId, onAddLog]);

  // --- Periodic inspect event drain (only when selector is active) ---
  // Drains buffered events from the inject script via
  // eval_browser_webview_with_result (native completion handler).
  // This is the sole delivery path for inspect events — we do not use
  // the title-channel for inspect events (see file-level comment).
  useEffect(() => {
    if (!visible || !webviewReady || !hasLoaded || !tab.selectorActive) return;
    // Poll at 200ms — fast enough for responsive feel after click,
    // cheap because eval_browser_webview_with_result returns immediately
    // when the buffer is empty ("[]").
    const INSPECT_DRAIN_MS = 200;

    // Track consecutive failures to avoid log spam (log first 3, then every 50th)
    let failCount = 0;
    // Guard against overlapping async drains — if invoke() takes longer than
    // the interval, skip until the previous call completes.
    let inFlight = false;

    const interval = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await invoke<string>("eval_browser_webview_with_result", {
          label: webviewLabel,
          js: INSPECT_MODE_DRAIN_EVENTS,
          timeoutMs: 2000,
        });
        // Reset fail counter on success
        failCount = 0;

        if (!result || result === "[]" || result === "undefined") return;

        let events: Array<{ type: string; data: Record<string, unknown> }>;
        try {
          events = JSON.parse(result);
        } catch (parseErr) {
          // JSON parse failure — log the raw result for debugging
          console.error("[BrowserTab] inspect drain: JSON.parse failed", parseErr, "raw result:", result.slice(0, 200));
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
          console.warn(
            `[BrowserTab] inspect drain failed (${failCount}x):`,
            err instanceof Error ? err.message : String(err)
          );
        }
      } finally {
        inFlight = false;
      }
    }, INSPECT_DRAIN_MS);

    return () => clearInterval(interval);
  }, [visible, webviewReady, hasLoaded, tab.selectorActive, webviewLabel, tabId, onUpdateTab, onAddLog]);

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

  // Inject browser utils, visual effects, and inspect mode into the WKWebView.
  // Uses fire-and-forget eval for dispatch + eval_with_result for verification
  // (fire-and-forget can't detect JS runtime errors in the IIFE).
  const injectAutomation = useCallback(async () => {
    if (!webviewCreatedRef.current) return;
    if (automationInjectedRef.current) {
      onAddLog(tabId, "info", "Automation already injected");
      return;
    }

    try {
      // Inject browser utils, visual effects, and inspect mode via native eval
      await invoke("eval_browser_webview", { label: webviewLabel, js: BROWSER_UTILS_SETUP });
      await invoke("eval_browser_webview", { label: webviewLabel, js: INSPECT_MODE_SETUP });
      await invoke("eval_browser_webview", { label: webviewLabel, js: VISUAL_EFFECTS_SETUP });

      // Wait a tick for the IIFEs to execute, then verify inspect mode
      await new Promise((r) => setTimeout(r, 100));
      try {
        const verifyResult = await invoke<string>("eval_browser_webview_with_result", {
          label: webviewLabel,
          js: INSPECT_MODE_VERIFY,
          timeoutMs: 3000,
        });
        const status = JSON.parse(verifyResult);
        if (!status.hiveInspect || !status.hasDrainEvents) {
          onAddLog(tabId, "error",
            `Inspect mode setup incomplete: ${JSON.stringify(status)}`
          );
          return; // Don't mark as injected
        }
      } catch (verifyErr) {
        onAddLog(tabId, "warn",
          `Inspect verification failed: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`
        );
        return;
      }

      automationInjectedRef.current = true;
      onUpdateTab(tabId, { injected: true, injectionFailed: false });
      onAddLog(tabId, "info", "Automation scripts injected successfully");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onAddLog(tabId, "error", `Injection failed: ${errorMsg}`);
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
      await invoke<string>("eval_browser_webview_with_result", {
        label: webviewLabel,
        js,
        timeoutMs: 3000,
      });
      onAddLog(tabId, "info",
        enabling ? "Inspect mode activated" : "Inspect mode deactivated"
      );
      onUpdateTab(tabId, { selectorActive: enabling });
    } catch (err) {
      onAddLog(tabId, "error",
        `Inspect mode toggle failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
