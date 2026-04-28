/**
 * BrowserTab — single tab rendered via Electron's <webview> HTML element.
 *
 * The <webview> lives in document.body (WebviewManager) and is positioned
 * over a placeholder <div> measured by the useWebview hook. Because
 * <webview> stacks normally in the DOM, overlays (loading bar, error card,
 * dropdowns, focus-mode chat bar) layer above it via plain CSS — no native
 * hide/show IPC dance like the old WebContentsView path required.
 */
/* eslint-env browser */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  forwardRef,
} from "react";
import { AlertCircle, Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { match } from "ts-pattern";
import { useWebview } from "../hooks/useWebview";
import { webviewManager, type Bounds } from "../webview-manager";
import { MOBILE_PREVIEW_WIDTH, MOBILE_PREVIEW_HEIGHT, MOBILE_PREVIEW_DPR } from "../types";
import {
  setEmulation,
  clearEmulation,
  openDevtools as openDevtoolsMain,
  closeDevtools as closeDevtoolsMain,
} from "@/platform/native/browser-views";
import type { BrowserTabHandle, BrowserTabState, ConsoleLog, ElementSelectedEvent } from "../types";
import {
  BLANK_URL,
  deriveTitleFromUrl,
  isBlankUrl,
  FOCUS_URL_BAR_EVENT,
  TOGGLE_INSPECT_MODE_EVENT,
} from "../types";
import {
  INSPECT_MODE_SETUP,
  INSPECT_MODE_ENABLE,
  INSPECT_MODE_DISABLE,
  INSPECT_MODE_DRAIN_EVENTS,
  INSPECT_MODE_VERIFY,
  INSPECT_MODE_HIDE_OVERLAYS,
  INSPECT_MODE_SHOW_OVERLAYS,
  buildInspectModeClearSelection,
} from "../automation/inspect-mode";
import { VISUAL_EFFECTS_SETUP } from "../automation/visual-effects";
import { getErrorMessage } from "@shared/lib/errors";

const INSPECT_DRAIN_INTERVAL_MS = 200;

interface BrowserTabProps {
  tab: BrowserTabState;
  onUpdateTab: (tabId: string, updates: Partial<BrowserTabState>) => void;
  onAddLog: (tabId: string, level: ConsoleLog["level"], message: string) => void;
  visible: boolean;
  onElementSelected?: (tabId: string, event: ElementSelectedEvent) => void;
}

/** Electron webview console-message event levels (0=verbose, 1=info, 2=warning, 3=error) */
function levelFromWebviewEvent(level: number): ConsoleLog["level"] {
  if (level >= 3) return "error";
  if (level === 2) return "warn";
  if (level === 0) return "debug";
  return "info";
}

export const BrowserTab = forwardRef<BrowserTabHandle, BrowserTabProps>(function BrowserTab(
  { tab, onUpdateTab, onAddLog, visible, onElementSelected },
  ref
) {
  const tabId = tab.id;
  const initialUrl = tab.currentUrl || BLANK_URL;

  // Panel rect — measured from the outer container. Drives the webview's
  // target bounds (either fill the panel or a centered sub-rect when an
  // emulated viewport is active).
  const panelContainerRef = useRef<HTMLDivElement | null>(null);
  const [panelRect, setPanelRect] = useState<Bounds | null>(null);

  useLayoutEffect(() => {
    const el = panelContainerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setPanelRect({ x: r.x, y: r.y, width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, []);

  // Bounds policy — two modes only:
  //   - Desktop (tab.isMobileView === false): webview fills the panel.
  //   - Mobile: 390-wide centered frame, full panel height. Never scaled;
  //     if the panel is narrower than 390, fall back to panel width.
  //
  // Splitter guard: react-resizable-panels' ResizableHandle has a 0-width
  // visual but a child hit-zone div that extends 6px into each adjacent
  // panel (`w-3 -translate-x-1/2`). The webview is `position: fixed` at
  // the panel's exact rect, which paints over that 6px zone and captures
  // its pointer events. Reserving 6px on each horizontal edge uncovers
  // the hit zone. The visual cost is a thin sliver of panel background.
  const SPLITTER_GUARD = 6;
  // DevTools docks into the bottom 40% of the panel — page shrinks to 60%
  // so both are visible. Matches Chrome's default dock proportion.
  const DEVTOOLS_SPLIT = 0.4;
  const devtoolsOpen = !!tab.devtoolsOpen;
  const { pageBounds: bounds, devtoolsBounds } = ((): {
    pageBounds: Bounds | null;
    devtoolsBounds: Bounds | null;
  } => {
    if (!panelRect) return { pageBounds: null, devtoolsBounds: null };
    const available = Math.max(0, panelRect.width - SPLITTER_GUARD * 2);
    const w = tab.isMobileView ? Math.min(MOBILE_PREVIEW_WIDTH, available) : available;
    const x = panelRect.x + (panelRect.width - w) / 2;
    if (!devtoolsOpen) {
      return {
        pageBounds: { x, y: panelRect.y, width: w, height: panelRect.height },
        devtoolsBounds: null,
      };
    }
    const dtHeight = Math.floor(panelRect.height * DEVTOOLS_SPLIT);
    const pageHeight = panelRect.height - dtHeight;
    return {
      // DevTools docks full-width so the user can see the inspector
      // regardless of whether the page is in mobile-preview mode.
      pageBounds: { x, y: panelRect.y, width: w, height: pageHeight },
      devtoolsBounds: {
        x: panelRect.x + SPLITTER_GUARD,
        y: panelRect.y + pageHeight,
        width: Math.max(0, panelRect.width - SPLITTER_GUARD * 2),
        height: dtHeight,
      },
    };
  })();

  const { getWebview } = useWebview({
    id: tabId,
    initialUrl,
    bounds,
    isVisible: visible,
  });

  // Latest page bounds, read imperatively by consumers (InspectPromptOverlay
  // needs them at click time to translate guest-viewport rects to screen
  // coords). Kept in sync every render without forcing the handle identity
  // to change.
  const pageBoundsRef = useRef<Bounds | null>(null);
  pageBoundsRef.current = bounds;

  // Second <webview> hosts the DevTools UI when docked inside the panel.
  // `about:blank` is fine as the initial URL — Electron's
  // `setDevToolsWebContents` accepts it (what it rejects is a webContents
  // that has loaded real content and is being repurposed).
  const { getWebview: getDevtoolsWebview } = useWebview({
    id: `${tabId}__devtools`,
    initialUrl: "about:blank",
    bounds: devtoolsBounds,
    isVisible: visible && devtoolsOpen,
  });

  // Start false even for hydrated tabs — eagerly setting true from
  // `tab.currentUrl` would trigger the emulation effect before the
  // <webview> guest attaches, causing getWebContentsId() to throw and
  // the emulation to silently not apply. The webview always fires
  // `did-stop-loading` when it finishes loading the initial `src`,
  // which is when we flip hasLoaded → true and the effect re-runs
  // with a valid webContents to attach the debugger to.
  const [hasLoaded, setHasLoaded] = useState<boolean>(false);
  const [completingLoad, setCompletingLoad] = useState(false);
  const completingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest tab — read inside DOM event handlers without rebinding
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // Stable ref for onElementSelected callback (used by the inspect drain loop)
  const onElementSelectedRef = useRef<BrowserTabProps["onElementSelected"]>(onElementSelected);
  onElementSelectedRef.current = onElementSelected;

  // Suppress history push when navigation was triggered by back/forward.
  // `historyNavDeltaRef` tracks direction (-1 back, +1 forward) so we can
  // advance `historyIndex` to match the actual position in the history
  // array — otherwise the NEXT typed navigation would slice history from
  // a stale index and keep dead forward entries alive.
  const suppressHistoryPushRef = useRef(false);
  const historyNavDeltaRef = useRef<-1 | 0 | 1>(0);

  // Monotonic token so rapid mobile-view toggles don't race. The
  // emulation effect captures the token at dispatch time and bails if a
  // later toggle has incremented it — otherwise a slower earlier request
  // could resolve last and leave the webview stuck in the wrong mode.
  const emulationRequestRef = useRef(0);

  // Guard: prevent duplicate automation injection across page loads
  const automationInjectedRef = useRef(false);

  // --- Subscribe to <webview> DOM events ---
  useEffect(() => {
    const wv = getWebview();
    if (!wv) return;

    let didFailForCurrentNav = false;
    // Every fresh <webview> starts by loading `about:blank` from its initial
    // `src`. That's an Electron attachment detail, not something the user
    // should perceive as "a page is loading" — it would flash the loading
    // bar and disable the URL input just as the auto-focus lands. Suppress
    // loading/log/state for that first blank pair; flip on first did-stop.
    let sawInitialBlank = false;

    const onStartLoading = () => {
      didFailForCurrentNav = false;
      if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
      setCompletingLoad(false);
      if (!sawInitialBlank && isBlankUrl(tabRef.current.currentUrl)) return;
      onUpdateTab(tabId, { loading: true });
    };

    const onStopLoading = () => {
      if (didFailForCurrentNav) return;
      const url = wv.getURL();
      if (isBlankUrl(url)) {
        // Initial attach won't have set loading=true (suppressed above), so
        // this is effectively a no-op there. But if we got here via a real
        // round-trip to about:blank (e.g. cookie-clear), unwind loading.
        sawInitialBlank = true;
        onUpdateTab(tabId, { loading: false });
        return;
      }
      sawInitialBlank = true;
      setHasLoaded(true);
      setCompletingLoad(true);
      completingTimerRef.current = setTimeout(() => setCompletingLoad(false), 500);
      onUpdateTab(tabId, { loading: false, currentUrl: url, error: null });
      onAddLog(tabId, "info", `Page loaded: ${url}`);
    };

    const onFailLoad = (event: Event) => {
      const e = event as unknown as {
        errorCode: number;
        errorDescription: string;
        validatedURL: string;
        isMainFrame: boolean;
      };
      // Ignore subframe errors and user-aborted navigations (-3 = ABORTED)
      if (!e.isMainFrame) return;
      if (e.errorCode === -3) return;
      didFailForCurrentNav = true;
      if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
      setCompletingLoad(false);
      setHasLoaded(true);
      const desc = e.errorDescription || "Page failed to load";
      // Persist the target URL the user tried to load — otherwise
      // `tab.currentUrl` still points at the previous page (or is blank
      // for the very first nav) and the "Try Again" button reloads the
      // wrong target. `validatedURL` is Electron's canonical form of the
      // URL the navigation was attempting.
      onUpdateTab(tabId, {
        loading: false,
        error: desc,
        ...(e.validatedURL ? { url: e.validatedURL, currentUrl: e.validatedURL } : {}),
      });
      onAddLog(tabId, "error", `Page failed to load: ${desc}`);
    };

    const onDidNavigate = (event: Event) => {
      const e = event as unknown as { url: string };
      handleNavigated(e.url);
    };
    const onDidNavigateInPage = (event: Event) => {
      const e = event as unknown as { url: string; isMainFrame: boolean };
      if (!e.isMainFrame) return;
      handleNavigated(e.url);
    };

    const handleNavigated = (url: string) => {
      // Guest-side blank loads (initial src, cookie-clear round-trip) must
      // never enter URL bar / history / title — they're an Electron detail.
      if (isBlankUrl(url)) return;
      if (suppressHistoryPushRef.current) {
        suppressHistoryPushRef.current = false;
        const current = tabRef.current;
        const delta = historyNavDeltaRef.current;
        historyNavDeltaRef.current = 0;
        const nextIndex = Math.max(
          0,
          Math.min(current.history.length - 1, current.historyIndex + delta)
        );
        onUpdateTab(tabId, {
          url,
          currentUrl: url,
          title: deriveTitleFromUrl(url),
          historyIndex: nextIndex,
        });
        return;
      }
      const current = tabRef.current;
      if (current.currentUrl === url) {
        onUpdateTab(tabId, { title: deriveTitleFromUrl(url) });
        return;
      }
      const newHistory = current.history.slice(0, current.historyIndex + 1);
      newHistory.push(url);
      onUpdateTab(tabId, {
        url,
        currentUrl: url,
        title: deriveTitleFromUrl(url),
        history: newHistory,
        historyIndex: newHistory.length - 1,
      });
    };

    const onTitleUpdated = (event: Event) => {
      const e = event as unknown as { title: string };
      // about:blank / chrome-error pages emit empty or "about:blank" titles —
      // don't let them clobber the "New Tab" default.
      if (isBlankUrl(e.title)) return;
      onUpdateTab(tabId, { title: e.title });
    };

    const onConsoleMessage = (event: Event) => {
      const e = event as unknown as { level: number; message: string };
      onAddLog(tabId, levelFromWebviewEvent(e.level), e.message);
    };

    // Keyboard shortcuts forwarded from the guest preload via sendToHost.
    // Channel is "shortcut"; args[0] is one of the shell-handled shortcuts.
    const onIpcMessage = (event: Event) => {
      const e = event as unknown as { channel: string; args: unknown[] };
      if (e.channel !== "shortcut") return;
      const shortcut = e.args[0];
      if (shortcut === "reload") {
        wv.reload();
      } else if (shortcut === "focus-url-bar") {
        // Emit a renderer-global event for BrowserPanel to pick up.
        window.dispatchEvent(new CustomEvent(FOCUS_URL_BAR_EVENT));
      } else if (shortcut === "toggle-inspect-mode") {
        window.dispatchEvent(new CustomEvent(TOGGLE_INSPECT_MODE_EVENT));
      }
    };

    wv.addEventListener("did-start-loading", onStartLoading);
    wv.addEventListener("did-stop-loading", onStopLoading);
    wv.addEventListener("did-fail-load", onFailLoad);
    wv.addEventListener("did-navigate", onDidNavigate);
    wv.addEventListener("did-navigate-in-page", onDidNavigateInPage);
    wv.addEventListener("page-title-updated", onTitleUpdated);
    wv.addEventListener("console-message", onConsoleMessage);
    wv.addEventListener("ipc-message", onIpcMessage);

    return () => {
      wv.removeEventListener("did-start-loading", onStartLoading);
      wv.removeEventListener("did-stop-loading", onStopLoading);
      wv.removeEventListener("did-fail-load", onFailLoad);
      wv.removeEventListener("did-navigate", onDidNavigate);
      wv.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
      wv.removeEventListener("page-title-updated", onTitleUpdated);
      wv.removeEventListener("console-message", onConsoleMessage);
      wv.removeEventListener("ipc-message", onIpcMessage);
    };
  }, [tabId, onUpdateTab, onAddLog, getWebview]);

  useEffect(() => {
    return () => {
      if (completingTimerRef.current) clearTimeout(completingTimerRef.current);
    };
  }, []);

  // --- Mobile emulation via CDP ---
  //
  // Desktop mode → no CDP override. The page sees the webview's natural
  // pixel dimensions, which means responsive CSS fires off the panel
  // width the user dragged to — exactly what you'd get sizing a real
  // browser window.
  //
  // Mobile mode → CDP override at 390×852 with mobile UA, touch, DPR 3.
  // Matches the fixed-width frame computed above so the layout viewport
  // exactly equals the rendered viewport.
  useEffect(() => {
    if (!hasLoaded) return;
    const wv = getWebview();
    if (!wv) return;

    const requestId = ++emulationRequestRef.current;
    const isStale = () => requestId !== emulationRequestRef.current;
    (async () => {
      let webContentsId: number;
      try {
        webContentsId = wv.getWebContentsId();
      } catch {
        return;
      }
      if (isStale()) return;

      if (!tab.isMobileView) {
        await clearEmulation(webContentsId);
        return;
      }

      await setEmulation({
        webContentsId,
        width: MOBILE_PREVIEW_WIDTH,
        height: MOBILE_PREVIEW_HEIGHT,
        deviceScaleFactor: MOBILE_PREVIEW_DPR,
        mobile: true,
        scale: 1,
      });
      // If a newer toggle superseded us while the call was in flight,
      // the next effect run will re-apply with the current state — we
      // just need to bail here so we don't log / treat this as the
      // authoritative result.
      if (isStale()) return;
    })();

    return () => {
      // Bump the token so any in-flight promise above sees isStale().
      emulationRequestRef.current++;
    };
  }, [tab.isMobileView, hasLoaded, getWebview]);

  // --- Imperative methods exposed to parent ---

  const navigateToUrl = useCallback(
    (url: string) => {
      const wv = getWebview();
      if (!wv) return;
      wv.loadURL(url).catch((err: unknown) => {
        onAddLog(tabId, "error", `Navigation failed: ${String(err)}`);
      });
    },
    [getWebview, tabId, onAddLog]
  );

  const goBack = useCallback(() => {
    const wv = getWebview();
    if (!wv || !wv.canGoBack()) return;
    suppressHistoryPushRef.current = true;
    historyNavDeltaRef.current = -1;
    wv.goBack();
  }, [getWebview]);

  const goForward = useCallback(() => {
    const wv = getWebview();
    if (!wv || !wv.canGoForward()) return;
    suppressHistoryPushRef.current = true;
    historyNavDeltaRef.current = 1;
    wv.goForward();
  }, [getWebview]);

  const reload = useCallback(() => {
    const wv = getWebview();
    wv?.reload();
  }, [getWebview]);

  const injectAutomation = useCallback(async (): Promise<boolean> => {
    const wv = getWebview();
    if (!wv) return false;
    if (automationInjectedRef.current) return true;
    try {
      await wv.executeJavaScript(INSPECT_MODE_SETUP);
      await wv.executeJavaScript(VISUAL_EFFECTS_SETUP);
      const rawStatus = await wv.executeJavaScript(INSPECT_MODE_VERIFY);
      const status =
        typeof rawStatus === "string" ? (JSON.parse(rawStatus) as Record<string, boolean>) : null;
      if (!status || !status.deusInspect || !status.hasDrainEvents) {
        onAddLog(tabId, "error", `Inspect mode setup incomplete: ${JSON.stringify(status)}`);
        onUpdateTab(tabId, { injectionFailed: true });
        return false;
      }
      automationInjectedRef.current = true;
      onUpdateTab(tabId, { injected: true, injectionFailed: false });
      onAddLog(tabId, "info", "Automation scripts injected");
      return true;
    } catch (err) {
      onAddLog(tabId, "error", `Injection failed: ${getErrorMessage(err)}`);
      onUpdateTab(tabId, { injectionFailed: true });
      return false;
    }
  }, [getWebview, tabId, onUpdateTab, onAddLog]);

  // Keep a ref to the latest injectAutomation so DOM event handlers can
  // call it without re-binding when identity changes.
  const injectAutomationRef = useRef(injectAutomation);
  injectAutomationRef.current = injectAutomation;

  // Trigger injection on EVERY page load (each new page context loses the
  // globals set by the setup IIFEs). Reset happens on did-start-loading;
  // inject fires on did-stop-loading via the DOM listener effect below.
  useEffect(() => {
    const wv = getWebview();
    if (!wv) return;

    const onStart = () => {
      automationInjectedRef.current = false;
      onUpdateTab(tabId, { injected: false, selectorActive: false });
    };
    const onStop = () => {
      // Run after the next frame so the page's scripts have a chance to
      // attach — otherwise `executeJavaScript` can race with inline
      // <script> tags still parsing.
      requestAnimationFrame(() => {
        injectAutomationRef.current();
      });
    };
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    return () => {
      wv.removeEventListener("did-start-loading", onStart);
      wv.removeEventListener("did-stop-loading", onStop);
    };
  }, [getWebview, tabId, onUpdateTab]);

  const setElementSelectorActive = useCallback(
    async (active: boolean) => {
      const wv = getWebview();
      if (!wv) return;
      if (active && !automationInjectedRef.current) {
        const ok = await injectAutomation();
        if (!ok) return;
      }
      if (tabRef.current.selectorActive === active) return;
      try {
        await wv.executeJavaScript(active ? INSPECT_MODE_ENABLE : INSPECT_MODE_DISABLE);
        onAddLog(tabId, "info", active ? "Inspect mode activated" : "Inspect mode deactivated");
        onUpdateTab(tabId, { selectorActive: active });
      } catch (err) {
        onAddLog(tabId, "error", `Inspect mode toggle failed: ${getErrorMessage(err)}`);
      }
    },
    [getWebview, tabId, injectAutomation, onUpdateTab, onAddLog]
  );

  const toggleElementSelector = useCallback(async () => {
    await setElementSelectorActive(!tabRef.current.selectorActive);
  }, [setElementSelectorActive]);

  // Periodic drain of buffered inspect events (only while selector is active).
  useEffect(() => {
    if (!visible || !hasLoaded || !tab.selectorActive) return;
    const wv = getWebview();
    if (!wv) return;

    // Flush stale events left over while selector was disabled / tab hidden.
    wv.executeJavaScript(INSPECT_MODE_DRAIN_EVENTS).catch(() => {});

    let failCount = 0;
    let inFlight = false;

    const interval = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await wv.executeJavaScript(INSPECT_MODE_DRAIN_EVENTS);
        failCount = 0;
        if (typeof result !== "string" || result === "[]") return;
        let events: Array<{ type: string; data: Record<string, unknown> }>;
        try {
          events = JSON.parse(result);
        } catch {
          return;
        }
        for (const evt of events) {
          match(evt.type)
            .with("element-event", () => {
              const parsed = evt.data as unknown as ElementSelectedEvent;
              onElementSelectedRef.current?.(tabId, parsed);
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
          onAddLog(tabId, "warn", `inspect drain failed (${failCount}x): ${getErrorMessage(err)}`);
        }
      } finally {
        inFlight = false;
      }
    }, INSPECT_DRAIN_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [visible, hasLoaded, tab.selectorActive, getWebview, tabId, onUpdateTab, onAddLog]);

  const openDevtools = useCallback(async () => {
    const wv = getWebview();
    if (!wv) return;
    let webContentsId: number;
    try {
      webContentsId = wv.getWebContentsId();
    } catch {
      // Guest not attached yet — fall back to the element method (opens detached).
      wv.openDevTools();
      onUpdateTab(tabId, { devtoolsOpen: true });
      return;
    }
    // Flip state first so the devtools <webview> grows to full size before
    // Electron loads the DevTools bundle into it — otherwise the initial
    // layout happens at the 1×1 hidden bounds and the UI looks wrong until
    // the next resize. rAF lets the layout effect commit new bounds.
    onUpdateTab(tabId, { devtoolsOpen: true });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // Route DevTools UI into the companion <webview>. If the host isn't
    // attached yet, fall back to a detached window so the click still does
    // something useful.
    const dtWv = getDevtoolsWebview();
    let devtoolsWebContentsId: number | undefined;
    if (dtWv) {
      try {
        devtoolsWebContentsId = dtWv.getWebContentsId();
      } catch {
        // host not attached yet — main side will open detached
      }
    }
    const result = await openDevtoolsMain(webContentsId, { devtoolsWebContentsId });
    if (!result.success) {
      onAddLog(tabId, "error", `Open devtools failed: ${result.error ?? "unknown"}`);
      onUpdateTab(tabId, { devtoolsOpen: false });
    }
  }, [getWebview, getDevtoolsWebview, tabId, onUpdateTab, onAddLog]);

  const closeDevtools = useCallback(async () => {
    const wv = getWebview();
    if (!wv) {
      onUpdateTab(tabId, { devtoolsOpen: false });
      return;
    }
    // The companion DevTools <webview> is left alive — `setDevToolsWebContents`
    // on the main side re-attaches onto the same guest when the user reopens
    // DevTools. The browser panel wrapper hides it via `isVisible` below.
    let webContentsId: number;
    try {
      webContentsId = wv.getWebContentsId();
    } catch {
      wv.closeDevTools();
      onUpdateTab(tabId, { devtoolsOpen: false });
      return;
    }
    const result = await closeDevtoolsMain(webContentsId);
    if (!result.success) {
      onAddLog(tabId, "error", `Close devtools failed: ${result.error ?? "unknown"}`);
      return;
    }
    onUpdateTab(tabId, { devtoolsOpen: false });
  }, [getWebview, tabId, onUpdateTab, onAddLog]);

  const captureScreenshot = useCallback(
    async (rect?: {
      x: number;
      y: number;
      width: number;
      height: number;
    }): Promise<string | null> => {
      const wv = getWebview();
      if (!wv) return null;
      try {
        const image = rect ? await wv.capturePage(rect) : await wv.capturePage();
        return image.toDataURL();
      } catch (err) {
        onAddLog(tabId, "error", `Screenshot failed: ${getErrorMessage(err)}`);
        return null;
      }
    },
    [getWebview, tabId, onAddLog]
  );

  const setInspectOverlaysVisible = useCallback(
    async (visible: boolean): Promise<void> => {
      const wv = getWebview();
      if (!wv) return;
      try {
        await wv.executeJavaScript(
          visible ? INSPECT_MODE_SHOW_OVERLAYS : INSPECT_MODE_HIDE_OVERLAYS
        );
      } catch {
        // Best-effort: if the inject script hasn't attached (e.g. mid-nav),
        // just swallow. The screenshot will still capture, just with the
        // inspector chrome visible — acceptable degradation.
      }
    },
    [getWebview]
  );

  const getWebviewBounds = useCallback((): Bounds | null => pageBoundsRef.current, []);

  const clearInspectSelection = useCallback(
    async (expectedSelectionKey?: string): Promise<void> => {
      const wv = getWebview();
      if (!wv) return;
      try {
        await wv.executeJavaScript(buildInspectModeClearSelection(expectedSelectionKey));
      } catch {
        // Same best-effort treatment as setInspectOverlaysVisible — when the
        // inject script isn't live (mid-nav), silent no-op is fine.
      }
    },
    [getWebview]
  );

  useImperativeHandle(
    ref,
    () => ({
      navigateToUrl,
      goBack,
      goForward,
      reload,
      injectAutomation,
      toggleElementSelector,
      setElementSelectorActive,
      captureScreenshot,
      setInspectOverlaysVisible,
      clearInspectSelection,
      getWebviewBounds,
      openDevtools,
      closeDevtools,
    }),
    [
      navigateToUrl,
      goBack,
      goForward,
      reload,
      injectAutomation,
      toggleElementSelector,
      setElementSelectorActive,
      captureScreenshot,
      setInspectOverlaysVisible,
      clearInspectSelection,
      getWebviewBounds,
      openDevtools,
      closeDevtools,
    ]
  );

  // Dispose the webview instance when this tab is closed by the parent.
  // We detect "closed" as unmount while tab.id is no longer in the parent's
  // tab list — since the hook can't know that, we rely on BrowserPanel's
  // closeTab() to call webviewManager.dispose(tabId) explicitly (Phase 5).
  // For now, an unmount that's not a close just detaches (keeps alive).

  // Placeholder DOM: the <webview> container is positioned at the bounds
  // computed above, so this component's tree only needs to render overlays
  // (loading bar, error card, empty state). We use absolute-positioned
  // overlays against the panel container itself.
  return (
    <div
      ref={panelContainerRef}
      className="relative h-full min-h-0 w-full min-w-0 overflow-hidden [grid-area:1/1]"
    >
      {/* Top loading bar */}
      {visible && (tab.loading || completingLoad) && (
        <div
          className="bg-primary pointer-events-none absolute inset-x-0 top-0 z-20 h-[2px] origin-left"
          style={{
            animation: tab.loading
              ? "browser-loading 8s cubic-bezier(.19,1,.22,1) forwards"
              : "browser-loading-complete 0.4s ease-out forwards",
          }}
        />
      )}

      {/* Empty state — shown whenever the tab has no real URL loaded. We no
       *  longer need the hasLoaded gate: currentUrl now stays truly empty
       *  during the initial about:blank load thanks to isBlankUrl() guards
       *  in handleNavigated / onStopLoading. */}
      {visible && isBlankUrl(tab.currentUrl) && !tab.loading && !tab.error && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
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

      {/* Loading overlay during first page load */}
      {visible && tab.loading && !hasLoaded && (
        <div className="vibrancy-bg pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <Loader2 className="text-primary h-8 w-8 animate-spin" />
        </div>
      )}

      {/* Error overlay */}
      {visible && tab.error && (
        <div className="vibrancy-bg absolute inset-0 z-10 flex items-center justify-center">
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

/** Dispose a tab's webview — called when the tab is closed. */
export function disposeBrowserTab(tabId: string): void {
  webviewManager.dispose(tabId);
  webviewManager.dispose(`${tabId}__devtools`);
}
