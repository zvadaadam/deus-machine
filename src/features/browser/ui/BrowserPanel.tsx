/**
 * BrowserPanel — multi-tab browser container with per-workspace tab persistence.
 *
 * Layout (top to bottom):
 *   BrowserTabBar (h-9)  — tab row with [Tab 1] [Tab 2] [+]
 *   Navigation Bar (h-9) — < > R [URL bar] inspect cookie devtools
 *   Tab Content (flex-1)  — all tabs rendered hidden/shown (preserves webview state)
 *
 * Persistence: Tab URLs/titles are synced to the workspace layout store
 * (localStorage) on a debounced 300ms timer. Webviews are destroyed on
 * unmount and lazily recreated from persisted URLs on remount.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Terminal,
  MousePointer2,
  X,
  Cookie,
  Check,
  Loader2,
  Trash2,
  Camera,
  Smartphone,
  Monitor,
} from "lucide-react";
import { useBrowser } from "../hooks/useBrowser";
import { BrowserTabBar } from "./BrowserTabBar";
import { BrowserTab } from "./BrowserTab";
import type {
  BrowserTabState,
  BrowserTabHandle,
  ConsoleLog,
  PersistedBrowserTab,
  ElementSelectedEvent,
} from "../types";
import { createBrowserTab, deriveTitleFromUrl, hydratePersistedTab } from "../types";
import { useBrowserRpcHandler } from "../automation/useBrowserRpcHandler";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { chatInsertActions } from "@/shared/stores/chatInsertStore";
import { invoke } from "@/platform/tauri";

const MAX_LOGS = 500;
const PERSIST_DEBOUNCE_MS = 300;

/** Browser info from Rust get_cookie_browsers command */
interface InstalledBrowser {
  name: string;
  keychain_service: string;
  cookie_db_path: string;
  available: boolean;
}

/** Decrypted cookie from Rust sync_browser_cookies command */
interface DecryptedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  http_only: boolean;
  same_site: string;
  expires: number;
}

interface BrowserPanelProps {
  workspaceId: string | null;
  /** Whether the browser panel is the active (visible) right-side tab.
   *  When false, the panel stays mounted (preserving webview instances)
   *  but all native webviews are hidden via Tauri IPC. */
  panelVisible?: boolean;
  onClose?: () => void;
  /** Pop-out callback — shown as a button in the tab bar */
  onDetach?: () => void;
  /** Which Tauri window hosts the child webviews. Defaults to "main". */
  windowLabel?: string;
}

export function BrowserPanel({
  workspaceId,
  panelVisible = true,
  onClose: _onClose,
  onDetach,
  windowLabel,
}: BrowserPanelProps) {
  // --- Initialize tabs from persisted state or create a fresh empty tab ---
  const [tabs, setTabs] = useState<BrowserTabState[]>(() => {
    if (workspaceId) {
      const layout = workspaceLayoutActions.getLayout(workspaceId);
      if (layout.browserTabs.length > 0) {
        return layout.browserTabs.map((pt) => hydratePersistedTab(pt, workspaceId));
      }
    }
    return [createBrowserTab(workspaceId)];
  });

  const [activeTabId, setActiveTabId] = useState<string>(() => {
    if (workspaceId) {
      const layout = workspaceLayoutActions.getLayout(workspaceId);
      if (layout.activeBrowserTabId && layout.browserTabs.length > 0) {
        // Find the tab with the persisted active ID
        const persisted = layout.browserTabs.find((t) => t.id === layout.activeBrowserTabId);
        if (persisted) return persisted.id;
      }
    }
    return tabs[0]?.id ?? "";
  });

  // Imperative handles per tab
  const tabRefs = useRef<Map<string, BrowserTabHandle>>(new Map());

  // Debounced persistence timer
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track previous workspaceId to detect switches
  const prevWorkspaceIdRef = useRef(workspaceId);

  // Mobile viewport toggle — constrains webview width to 390px (iPhone 14 logical width)
  const [mobileView, setMobileView] = useState(false);

  // Shared dev-browser server (called once in container, status passed to all tabs)
  const { status: devBrowserStatus, startServer } = useBrowser();

  // Derived: active tab for nav bar state
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // --- Centralized webview visibility guard ---
  // Native WKWebViews render above the DOM, so CSS can't hide them.
  // Individual BrowserTabs manage their own show/hide via effects, but
  // race conditions during rapid tab switches can leave stale webviews
  // visible. This guard explicitly hides all non-active webviews whenever
  // the active tab or panel visibility changes — belt-and-suspenders.
  const tabInfoRef = useRef(tabs);
  tabInfoRef.current = tabs;

  useEffect(() => {
    const currentTabs = tabInfoRef.current;
    for (const tab of currentTabs) {
      if (tab.id !== activeTabId || !panelVisible) {
        invoke("hide_browser_webview", { label: tab.webviewLabel }).catch(() => {});
      }
    }
  }, [activeTabId, panelVisible]);

  // Browser automation RPC handler — lets the sidecar operate the browser
  // via MCP tools (snapshot, click, type, navigate, getState).
  // Uses a ref-based callback to always read the latest active tab without
  // causing the Tauri event listener to re-subscribe on every tab change.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const getActiveTab = useCallback(() => activeTabRef.current, []);

  // Provide access to all tabs for session-mapped tab lookups
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const getTabs = useCallback(() => tabsRef.current, []);

  // Auto-create (or populate an existing empty tab) when the sidecar calls
  // BrowserNavigate and no usable tab exists. Sets the URL, switches the
  // right panel to browser, and returns the webviewLabel.
  // BrowserTab's auto-navigate effect handles actual native webview creation.
  const handleAutoCreateTab = useCallback(
    (url: string): string | null => {
      if (!workspaceId) return null;

      let fullUrl = url;
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("file://")) {
        fullUrl = "https://" + url;
      }

      // Reuse existing empty tab if available (BrowserPanel always creates one)
      const emptyTab = tabs.find((t) => !t.currentUrl);
      let targetLabel: string;

      if (emptyTab) {
        // Populate the existing empty tab with the URL
        setTabs((prev) =>
          prev.map((t) =>
            t.id === emptyTab.id
              ? {
                  ...t,
                  url: fullUrl,
                  currentUrl: fullUrl,
                  title: deriveTitleFromUrl(fullUrl),
                  loading: true,
                  history: [fullUrl],
                  historyIndex: 0,
                }
              : t
          )
        );
        setActiveTabId(emptyTab.id);
        targetLabel = emptyTab.webviewLabel;
      } else {
        // Create a new tab with URL pre-filled
        const newTab = createBrowserTab(workspaceId);
        newTab.url = fullUrl;
        newTab.currentUrl = fullUrl;
        newTab.title = deriveTitleFromUrl(fullUrl);
        newTab.loading = true;
        newTab.history = [fullUrl];
        newTab.historyIndex = 0;

        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
        targetLabel = newTab.webviewLabel;
      }

      // Switch the right panel to browser tab so the webview becomes visible
      workspaceLayoutActions.setActiveRightSideTab(workspaceId, "browser");

      return targetLabel;
    },
    [workspaceId, tabs]
  );

  // Store auto-create in ref for stable identity (avoids Tauri listener re-subscribe)
  const autoCreateTabRef = useRef(handleAutoCreateTab);
  autoCreateTabRef.current = handleAutoCreateTab;
  const stableAutoCreateTab = useCallback((url: string) => autoCreateTabRef.current(url), []);

  useBrowserRpcHandler(getActiveTab, stableAutoCreateTab, workspaceId, getTabs);

  // --- Persist tab state to workspace layout store (debounced) ---
  const persistTabs = useCallback(
    (currentTabs: BrowserTabState[], currentActiveId: string) => {
      if (!workspaceId) return;

      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        // Only persist tabs that have a loaded URL (skip empty new tabs)
        const persisted: PersistedBrowserTab[] = currentTabs
          .filter((t) => t.currentUrl)
          .map((t) => ({ id: t.id, url: t.currentUrl, title: t.title }));

        workspaceLayoutActions.setLayout(workspaceId, {
          browserTabs: persisted,
          activeBrowserTabId: currentActiveId,
        });
      }, PERSIST_DEBOUNCE_MS);
    },
    [workspaceId]
  );

  // Cleanup persist timer on unmount
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, []);

  // --- Swap tabs when workspaceId changes (workspace switch) ---
  // BrowserPanel stays mounted to preserve WKWebView lifecycle, so we
  // manually swap tab state instead of relying on remount.
  //
  // CRITICAL: We must explicitly close old native webviews BEFORE setting
  // new tabs. BrowserTab's unmount cleanup also calls close, but it's async
  // and races with the new workspace's webviews — causing overlapping webviews
  // (native webviews render above the DOM so CSS can't hide them).
  useEffect(() => {
    const prevId = prevWorkspaceIdRef.current;
    if (prevId === workspaceId) return;

    // Flush pending persistence for the old workspace immediately
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (prevId) {
      // Persist current tabs to old workspace synchronously (no debounce)
      const persisted: PersistedBrowserTab[] = tabs
        .filter((t) => t.currentUrl)
        .map((t) => ({ id: t.id, url: t.currentUrl, title: t.title }));
      workspaceLayoutActions.setLayout(prevId, {
        browserTabs: persisted,
        activeBrowserTabId: activeTabId,
      });
    }

    // Hide then close ALL old native webviews immediately (don't wait for BrowserTab unmount).
    // hide() is called first as a defensive measure — on macOS, WKWebView.close() may not
    // immediately remove the native view from the NSView hierarchy, but hide() reliably
    // sets [view setHidden:YES] which makes it invisible instantly.
    for (const tab of tabs) {
      invoke("hide_browser_webview", { label: tab.webviewLabel }).catch(() => {});
      invoke("close_browser_webview", { label: tab.webviewLabel }).catch(() => {});
    }

    // Load tabs for the new workspace
    let newTabs: BrowserTabState[];
    let newActiveId: string;

    if (workspaceId) {
      const layout = workspaceLayoutActions.getLayout(workspaceId);
      if (layout.browserTabs.length > 0) {
        newTabs = layout.browserTabs.map((pt) => hydratePersistedTab(pt, workspaceId));
        const persisted = layout.activeBrowserTabId
          ? layout.browserTabs.find((t) => t.id === layout.activeBrowserTabId)
          : null;
        newActiveId = persisted ? persisted.id : newTabs[0].id;
      } else {
        const fresh = createBrowserTab(workspaceId);
        newTabs = [fresh];
        newActiveId = fresh.id;
      }
    } else {
      const fresh = createBrowserTab(null);
      newTabs = [fresh];
      newActiveId = fresh.id;
    }

    tabRefs.current.clear();

    setTabs(newTabs);
    setActiveTabId(newActiveId);
    prevWorkspaceIdRef.current = workspaceId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // --- Auto-start dev-browser server on mount ---
  useEffect(() => {
    if (!devBrowserStatus.running && !devBrowserStatus.error) {
      startServer().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("VITE_DEV_BROWSER_PATH")) {
          console.error("Failed to auto-start dev-browser:", err);
        }
      });
    }
  }, [devBrowserStatus.running, devBrowserStatus.error, startServer]);

  // Log when MCP server starts (to active tab's console)
  useEffect(() => {
    if (devBrowserStatus.running && devBrowserStatus.port && activeTabId) {
      handleAddLog(activeTabId, "info", `MCP server running on port ${devBrowserStatus.port}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devBrowserStatus.running]);

  // --- Tab operations ---

  const addTab = useCallback(() => {
    const newTab = createBrowserTab(workspaceId);
    setTabs((prev) => {
      const next = [...prev, newTab];
      // Persist inside updater to avoid stale closure over `tabs`
      persistTabs(next, newTab.id);
      return next;
    });
    setActiveTabId(newTab.id);
  }, [workspaceId, persistTabs]);

  const closeTab = useCallback(
    (closingTabId: string) => {
      // Close the native webview BEFORE removing from React state.
      // BrowserTab's unmount cleanup also calls close, but it's async and
      // races with re-render — the native WKWebView can remain visible
      // during the gap because it renders above the DOM.
      const closingTab = tabs.find((t) => t.id === closingTabId);
      if (closingTab) {
        invoke("hide_browser_webview", { label: closingTab.webviewLabel }).catch(() => {});
        invoke("close_browser_webview", { label: closingTab.webviewLabel }).catch(() => {});
      }

      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === closingTabId);
        const newTabs = prev.filter((t) => t.id !== closingTabId);

        let nextActiveId = activeTabId;
        // Select neighbor when closing the active tab
        if (closingTabId === activeTabId) {
          if (newTabs.length > 0) {
            const nextIdx = Math.min(idx, newTabs.length - 1);
            nextActiveId = newTabs[nextIdx].id;
            setActiveTabId(nextActiveId);
          } else {
            nextActiveId = "";
            setActiveTabId("");
          }
        }

        persistTabs(newTabs, nextActiveId);
        return newTabs;
      });
      tabRefs.current.delete(closingTabId);
    },
    [tabs, activeTabId, persistTabs]
  );

  /**
   * Stable callback for BrowserTab children to update their tab state.
   * Auto-derives title from URL when a page finishes loading.
   * Triggers debounced persistence on meaningful changes.
   */
  const handleUpdateTab = useCallback(
    (tabId: string, updates: Partial<BrowserTabState>) => {
      setTabs((prev) => {
        const next = prev.map((t) => {
          if (t.id !== tabId) return t;
          const updated = { ...t, ...updates };
          // Auto-derive title when page finishes loading successfully
          if (updates.loading === false && !updates.error && updated.currentUrl) {
            updated.title = deriveTitleFromUrl(updated.currentUrl);
          }
          return updated;
        });

        // Persist on URL or title changes (page load finish, title change, navigation)
        if (
          updates.currentUrl !== undefined ||
          updates.title !== undefined ||
          (updates.loading === false && !updates.error)
        ) {
          persistTabs(next, activeTabId);
        }

        return next;
      });
    },
    [activeTabId, persistTabs]
  );

  /** Stable callback for BrowserTab children to add console logs */
  const handleAddLog = useCallback((tabId: string, level: ConsoleLog["level"], message: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        const next = [...t.consoleLogs, { timestamp: new Date(), level, message }];
        return {
          ...t,
          consoleLogs: next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next,
        };
      })
    );
  }, []);

  /** Dispatch element selection to the chat input via chatInsertStore.
   *  Only handles "element-selected" — "area-selected" is intentionally ignored
   *  since area selections have no element metadata to reference. */
  const handleElementSelected = useCallback(
    (_tabId: string, event: ElementSelectedEvent) => {
      if (event.type !== "element-selected" || !event.element || !workspaceId) return;

      // Serialize Record<string, string> fields as semicolon-separated strings
      const serialize = (rec: Record<string, string> | undefined, sep: string) =>
        rec
          ? Object.entries(rec)
              .map(([k, v]) => `${k}${sep}${v}`)
              .join("; ")
          : undefined;

      chatInsertActions.insertElement(workspaceId, {
        ref: event.ref ?? "",
        tagName: event.element.tagName,
        path: event.element.path,
        innerText: event.element.innerText,
        context: event.context,
        reactComponent: event.reactComponent?.name,
        file: event.reactComponent?.fileName ?? undefined,
        line: event.reactComponent?.lineNumber?.toString() ?? undefined,
        styles: serialize(event.element.styles, ": "),
        props: serialize(event.element.props, "="),
        attributes: serialize(event.element.attributes, "="),
        innerHTML: event.element.innerHTML,
      });
    },
    [workspaceId]
  );

  /** Capture the active tab's WKWebView as JPEG and dispatch to chat input */
  const handleScreenshot = useCallback(async () => {
    if (!activeTab?.webviewLabel || !activeTab.currentUrl || !workspaceId) return;
    try {
      const base64 = await invoke<string>("screenshot_browser_webview", {
        label: activeTab.webviewLabel,
      });
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "image/jpeg" });
      const file = new File([blob], `browser-screenshot-${Date.now()}.jpg`, { type: "image/jpeg" });
      chatInsertActions.insertFiles(workspaceId, [file]);
    } catch (err) {
      console.error("Browser screenshot failed:", err);
    }
  }, [activeTab?.webviewLabel, activeTab?.currentUrl, workspaceId]);

  // --- Navigation (operates on active tab) ---

  const handleNavigate = useCallback(() => {
    if (!activeTab) return;
    const targetUrl = activeTab.url;
    if (!targetUrl) return;

    let fullUrl = targetUrl;
    if (
      !targetUrl.startsWith("http://") &&
      !targetUrl.startsWith("https://") &&
      !targetUrl.startsWith("file://")
    ) {
      fullUrl = "https://" + targetUrl;
    }

    const title = deriveTitleFromUrl(fullUrl);

    // Truncate forward history and add new entry
    const newHistory = activeTab.history.slice(0, activeTab.historyIndex + 1);
    newHistory.push(fullUrl);

    handleUpdateTab(activeTab.id, {
      url: fullUrl,
      currentUrl: fullUrl,
      loading: true,
      error: null,
      injected: false,
      title,
      history: newHistory,
      historyIndex: newHistory.length - 1,
    });

    handleAddLog(activeTab.id, "info", `Navigating to: ${fullUrl}`);
    tabRefs.current.get(activeTab.id)?.navigateToUrl(fullUrl);
  }, [activeTab, handleUpdateTab, handleAddLog]);

  const handleGoBack = useCallback(() => {
    if (!activeTab || activeTab.historyIndex <= 0) return;
    const newIndex = activeTab.historyIndex - 1;
    const previousUrl = activeTab.history[newIndex];

    handleUpdateTab(activeTab.id, {
      url: previousUrl,
      currentUrl: previousUrl,
      historyIndex: newIndex,
      loading: true,
      error: null,
      injected: false,
      title: deriveTitleFromUrl(previousUrl),
    });

    tabRefs.current.get(activeTab.id)?.navigateToUrl(previousUrl);
  }, [activeTab, handleUpdateTab]);

  const handleGoForward = useCallback(() => {
    if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return;
    const newIndex = activeTab.historyIndex + 1;
    const nextUrl = activeTab.history[newIndex];

    handleUpdateTab(activeTab.id, {
      url: nextUrl,
      currentUrl: nextUrl,
      historyIndex: newIndex,
      loading: true,
      error: null,
      injected: false,
      title: deriveTitleFromUrl(nextUrl),
    });

    tabRefs.current.get(activeTab.id)?.navigateToUrl(nextUrl);
  }, [activeTab, handleUpdateTab]);

  const handleReload = useCallback(() => {
    if (!activeTab) return;
    tabRefs.current.get(activeTab.id)?.reload();
  }, [activeTab]);

  const handleToggleSelector = useCallback(() => {
    if (!activeTab) return;
    tabRefs.current.get(activeTab.id)?.toggleElementSelector();
  }, [activeTab]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") handleNavigate();
    },
    [handleNavigate]
  );

  const handleUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (activeTab) {
        handleUpdateTab(activeTab.id, { url: e.target.value });
      }
    },
    [activeTab, handleUpdateTab]
  );

  // Persist active tab ID changes — read tabs from ref to avoid stale closure
  const handleTabSelect = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      persistTabs(tabsRef.current, tabId);
    },
    [persistTabs]
  );

  // --- Cookie Sync ---

  const [cookieBrowsers, setCookieBrowsers] = useState<InstalledBrowser[]>([]);
  const [cookieSyncing, setCookieSyncing] = useState<string | null>(null); // browser name being synced
  const [lastSyncResult, setLastSyncResult] = useState<{ browser: string; count: number } | null>(
    null
  );

  /** Fetch available browsers when dropdown opens */
  const handleCookieDropdownOpen = useCallback(async () => {
    try {
      const browsers = await invoke<InstalledBrowser[]>("get_cookie_browsers");
      setCookieBrowsers(browsers);
    } catch (err) {
      console.error("Failed to get cookie browsers:", err);
    }
  }, []);

  /** Sync cookies from a browser for the active tab's domain, inject natively, and reload */
  const handleCookieSync = useCallback(
    async (browserName: string) => {
      if (!activeTab?.currentUrl) return;

      let domain: string;
      try {
        domain = new URL(activeTab.currentUrl).hostname;
      } catch {
        handleAddLog(activeTab.id, "error", "Invalid URL — can't extract domain for cookie sync");
        return;
      }

      setCookieSyncing(browserName);
      handleAddLog(activeTab.id, "info", `Syncing cookies from ${browserName} for ${domain}...`);

      try {
        const cookies = await invoke<DecryptedCookie[]>("sync_browser_cookies", {
          browserName,
          domain,
        });

        if (cookies.length === 0) {
          handleAddLog(activeTab.id, "warn", `No cookies found in ${browserName} for ${domain}`);
          setCookieSyncing(null);
          return;
        }

        // Inject ALL cookies (including HttpOnly) via native WKHTTPCookieStore
        const injected = await invoke<number>("inject_browser_cookies", {
          label: activeTab.webviewLabel,
          cookies,
        });

        handleAddLog(
          activeTab.id,
          "info",
          `Injected ${injected}/${cookies.length} cookies from ${browserName}`
        );

        setLastSyncResult({ browser: browserName, count: injected });

        // Reload the page so the browser sends cookies with new requests
        if (injected > 0) {
          tabRefs.current.get(activeTab.id)?.reload();
          handleAddLog(activeTab.id, "info", "Reloading page with injected cookies...");
        }
      } catch (err) {
        handleAddLog(activeTab.id, "error", `Cookie sync failed: ${err}`);
      } finally {
        setCookieSyncing(null);
      }
    },
    [activeTab, handleAddLog]
  );

  /** Clear cookies by navigating to about:blank and back (resets WKHTTPCookieStore) */
  const handleClearCookies = useCallback(() => {
    if (!activeTab?.currentUrl) return;
    const restoreUrl = activeTab.currentUrl;
    const handle = tabRefs.current.get(activeTab.id);
    if (!handle) return;

    handleAddLog(activeTab.id, "info", "Clearing site data...");
    setLastSyncResult(null);

    // Navigate to blank page (clears cookie association), then back
    handle.navigateToUrl("about:blank");
    setTimeout(() => {
      handle.navigateToUrl(restoreUrl);
      handleAddLog(activeTab.id, "info", "Reloaded without cookies");
    }, 200);
  }, [activeTab, handleAddLog]);

  // Ref setter callback — stores/removes imperative handle per tab
  const setTabRef = useCallback(
    (tabId: string) => (handle: BrowserTabHandle | null) => {
      if (handle) {
        tabRefs.current.set(tabId, handle);
      } else {
        tabRefs.current.delete(tabId);
      }
    },
    []
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tab Bar */}
      <BrowserTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabSelect={handleTabSelect}
        onTabClose={closeTab}
        onTabAdd={addTab}
        onDetach={onDetach}
      />

      {/* Navigation Bar — h-9 to align with chat tabs row */}
      <div className="border-border-subtle flex h-9 flex-shrink-0 items-center gap-2 border-b px-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleGoBack}
          disabled={!activeTab || activeTab.loading || activeTab.historyIndex <= 0}
          title="Go back"
          aria-label="Go back"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleGoForward}
          disabled={
            !activeTab ||
            activeTab.loading ||
            activeTab.historyIndex >= activeTab.history.length - 1
          }
          title="Go forward"
          aria-label="Go forward"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleReload}
          disabled={!activeTab || activeTab.loading || !activeTab.currentUrl}
          title="Reload"
          aria-label="Reload"
        >
          <RefreshCw className={`h-4 w-4 ${activeTab?.loading ? "animate-spin" : ""}`} />
        </Button>

        <Input
          type="text"
          value={activeTab?.url ?? ""}
          onChange={handleUrlChange}
          onKeyDown={handleKeyDown}
          onFocus={(e) => e.target.select()}
          placeholder="Search or enter URL..."
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          className="focus-visible:border-border h-7 min-w-0 flex-1 text-sm focus-visible:ring-0"
          disabled={!activeTab || activeTab.loading}
        />

        {/* Injection failure indicator — red dot, only visible on error */}
        {activeTab?.injectionFailed && (
          <>
            <span
              className="bg-destructive h-2 w-2 shrink-0 rounded-full"
              title="Automation injection failed — check console"
              aria-hidden="true"
            />
            <span className="sr-only">Automation injection failed</span>
          </>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleToggleSelector}
          disabled={!activeTab?.currentUrl || !activeTab?.injected}
          aria-pressed={activeTab?.selectorActive}
          title={
            activeTab?.selectorActive ? "Exit element selector (Esc)" : "Select element to inspect"
          }
          aria-label={
            activeTab?.selectorActive ? "Exit element selector" : "Select element to inspect"
          }
        >
          <MousePointer2
            className={`h-4 w-4 ${activeTab?.selectorActive ? "text-primary animate-pulse" : ""}`}
          />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleScreenshot}
          disabled={!activeTab?.currentUrl}
          title="Screenshot to chat"
          aria-label="Screenshot to chat"
        >
          <Camera className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setMobileView((v) => !v)}
          disabled={!activeTab?.currentUrl}
          aria-pressed={mobileView}
          title={mobileView ? "Switch to desktop view" : "Switch to mobile view"}
          aria-label={mobileView ? "Switch to desktop view" : "Switch to mobile view"}
        >
          {mobileView ? (
            <Monitor className="text-primary h-4 w-4" />
          ) : (
            <Smartphone className="h-4 w-4" />
          )}
        </Button>

        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              handleCookieDropdownOpen();
              // Hide native webview so the dropdown isn't rendered behind it
              // (WKWebView floats above all DOM layers including portals)
              if (activeTab?.webviewLabel) {
                invoke("hide_browser_webview", { label: activeTab.webviewLabel }).catch(() => {});
              }
            } else {
              // Re-show webview when dropdown closes
              if (activeTab?.webviewLabel && activeTab.currentUrl) {
                invoke("show_browser_webview", { label: activeTab.webviewLabel }).catch(() => {});
              }
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!activeTab?.currentUrl || !!cookieSyncing}
              title="Import cookies from browser"
              aria-label="Import cookies from browser"
            >
              {cookieSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Cookie className="h-4 w-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {/* Show target domain */}
            {activeTab?.currentUrl &&
              (() => {
                try {
                  return (
                    <DropdownMenuLabel className="text-muted-foreground text-2xs truncate font-normal">
                      {new URL(activeTab.currentUrl).hostname}
                    </DropdownMenuLabel>
                  );
                } catch {
                  return null;
                }
              })()}

            <DropdownMenuLabel className="text-xs">Import Cookies</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {cookieBrowsers.length === 0 ? (
              <DropdownMenuItem disabled className="text-xs">
                No browsers detected
              </DropdownMenuItem>
            ) : (
              cookieBrowsers.map((b) => (
                <DropdownMenuItem
                  key={b.name}
                  disabled={!b.available || !!cookieSyncing}
                  className="text-xs"
                  onClick={() => handleCookieSync(b.name)}
                >
                  <span className="flex-1">{b.name}</span>
                  {!b.available && (
                    <span className="text-muted-foreground text-2xs">Not installed</span>
                  )}
                  {b.available && cookieSyncing === b.name && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                  {b.available && !cookieSyncing && lastSyncResult?.browser === b.name && (
                    <span className="text-success text-2xs">{lastSyncResult.count} synced</span>
                  )}
                  {b.available && !cookieSyncing && lastSyncResult?.browser !== b.name && (
                    <Check className="text-muted-foreground/40 h-3 w-3" />
                  )}
                </DropdownMenuItem>
              ))
            )}

            {/* Clear cookies option */}
            {activeTab?.currentUrl && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive text-xs"
                  onClick={handleClearCookies}
                  disabled={!!cookieSyncing}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Clear Site Data</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => {
            if (!activeTab?.webviewLabel) return;
            if (activeTab.devtoolsOpen) {
              invoke("close_browser_devtools", { label: activeTab.webviewLabel })
                .then(() => handleUpdateTab(activeTab.id, { devtoolsOpen: false }))
                .catch((err) =>
                  handleAddLog(activeTab.id, "error", `Close devtools failed: ${err}`)
                );
            } else {
              invoke("open_browser_devtools", { label: activeTab.webviewLabel })
                .then(() => handleUpdateTab(activeTab.id, { devtoolsOpen: true }))
                .catch((err) =>
                  handleAddLog(activeTab.id, "error", `Open devtools failed: ${err}`)
                );
            }
          }}
          disabled={!activeTab?.currentUrl}
          aria-pressed={activeTab?.devtoolsOpen}
          title={activeTab?.devtoolsOpen ? "Close DevTools" : "Open DevTools"}
          aria-label={activeTab?.devtoolsOpen ? "Close DevTools" : "Open DevTools"}
        >
          <Terminal className={`h-4 w-4 ${activeTab?.devtoolsOpen ? "text-primary" : ""}`} />
        </Button>
      </div>

      {/* Tab content — devtools opens as floating window (docked not yet supported).
       * See open_browser_devtools in webview.rs for full history of docking attempts.
       *
       * Tab stacking uses CSS Grid (all tabs in [grid-area:1/1]) instead of
       * absolute positioning. Previous approach (absolute inset-0 on BrowserTab)
       * broke mobile view: the placeholder's getBoundingClientRect() returned
       * stale full-width values because absolute-positioned elements don't
       * reliably inherit width constraints from their containing block when
       * parent containers restructure (mx-auto, flex centering). Grid stacking
       * keeps tabs in normal flow so they inherit w-[390px] naturally and
       * ResizeObserver fires on actual size changes. */}
      <div className={`relative min-h-0 flex-1 overflow-hidden ${mobileView ? "bg-muted/30" : ""}`}>
        <div
          className={`grid h-full ${mobileView ? "border-border/40 mx-auto w-[390px] border-x" : "w-full"}`}
        >
          {tabs.length === 0 ? (
            <div className="text-muted-foreground/50 flex h-full items-center justify-center text-xs">
              Click + to open a browser tab
            </div>
          ) : (
            tabs.map((tab) => (
              <BrowserTab
                key={tab.id}
                ref={setTabRef(tab.id)}
                tab={tab}
                devBrowserStatus={devBrowserStatus}
                onUpdateTab={handleUpdateTab}
                onAddLog={handleAddLog}
                onElementSelected={handleElementSelected}
                visible={tab.id === activeTabId && panelVisible}
                windowLabel={windowLabel}
                mobileView={mobileView}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
