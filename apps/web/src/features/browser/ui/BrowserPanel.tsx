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
} from "lucide-react";
import { BrowserTabBar } from "./BrowserTabBar";
import { BrowserTab } from "./BrowserTab";
import type {
  BrowserTabState,
  BrowserTabHandle,
  ConsoleLog,
  PersistedBrowserTab,
  ElementSelectedEvent,
  ViewportState,
} from "../types";
import { createBrowserTab, deriveTitleFromUrl, hydratePersistedTab } from "../types";
import { ViewportDropdown } from "./ViewportDropdown";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { chatInsertActions } from "@/shared/stores/chatInsertStore";
import { native } from "@/platform";
import { BROWSER_NEW_TAB_REQUESTED } from "@shared/events";

const MAX_LOGS = 500;
const PERSIST_DEBOUNCE_MS = 300;

interface InstalledBrowser {
  name: string;
  keychain_service: string;
  cookie_db_path: string;
  available: boolean;
}

interface BrowserPanelProps {
  workspaceId: string | null;
  /** Whether the browser panel is the active (visible) right-side tab.
   *  When false, the panel stays mounted (preserving webview instances)
   *  but all native BrowserViews are hidden via IPC. */
  panelVisible?: boolean;
  /** Pop-out callback — shown as a button in the tab bar */
  onDetach?: () => void;
  /** Which Electron window hosts the child BrowserViews. Defaults to "main". */
  windowLabel?: string;
}

/** Load or create browser tabs for a workspace from persisted layout state */
function loadWorkspaceTabs(wsId: string | null): { tabs: BrowserTabState[]; activeTabId: string } {
  if (wsId) {
    const layout = workspaceLayoutActions.getLayout(wsId);
    if (layout.browserTabs.length > 0) {
      const tabs = layout.browserTabs.map((pt) => hydratePersistedTab(pt));
      const persisted = layout.activeBrowserTabId
        ? layout.browserTabs.find((t) => t.id === layout.activeBrowserTabId)
        : null;
      return { tabs, activeTabId: persisted?.id ?? tabs[0].id };
    }
  }
  const tab = createBrowserTab(wsId);
  return { tabs: [tab], activeTabId: tab.id };
}

/** Serialize tabs for persistence — only tabs with a loaded URL */
function serializeTabs(tabs: BrowserTabState[]): PersistedBrowserTab[] {
  return tabs
    .filter((t) => t.currentUrl)
    .map((t) => ({ id: t.id, url: t.currentUrl, title: t.title, ...(t.viewport ? { viewport: t.viewport } : {}) }));
}

export function BrowserPanel({
  workspaceId,
  panelVisible = true,
  onDetach,
  windowLabel,
}: BrowserPanelProps) {
  // --- Initialize tabs from persisted state or create a fresh empty tab ---
  const [{ tabs: initialTabs, activeTabId: initialActiveId }] = useState(() =>
    loadWorkspaceTabs(workspaceId)
  );
  const [tabs, setTabs] = useState<BrowserTabState[]>(initialTabs);
  const [activeTabId, setActiveTabId] = useState<string>(initialActiveId);

  // Imperative handles per tab
  const tabRefs = useRef<Map<string, BrowserTabHandle>>(new Map());

  // Debounced persistence timer
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track previous workspaceId to detect switches
  const prevWorkspaceIdRef = useRef(workspaceId);

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
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  useEffect(() => {
    const currentTabs = tabInfoRef.current;
    for (const tab of currentTabs) {
      if (tab.id !== activeTabId || !panelVisible) {
        native.browserViews.hide(tab.webviewLabel).catch(() => {});
      }
    }
  }, [activeTabId, panelVisible]);

  // --- Persist tab state to workspace layout store (debounced) ---
  const persistTabs = useCallback(
    (currentTabs: BrowserTabState[], currentActiveId: string) => {
      if (!workspaceId) return;

      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        workspaceLayoutActions.setLayout(workspaceId, {
          browserTabs: serializeTabs(currentTabs),
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
    // Read refs unconditionally — always fresh, no stale closure risk
    const currentTabs = tabInfoRef.current;
    const currentActiveId = activeTabIdRef.current;

    if (prevId) {
      // Persist current tabs to old workspace
      workspaceLayoutActions.setLayout(prevId, {
        browserTabs: serializeTabs(currentTabs),
        activeBrowserTabId: currentActiveId,
      });
    }

    // Park old views instead of destroying them — keeps native WebContentsViews
    // alive so they can be recalled without page reload when switching back.
    // Views are hidden immediately (WKWebView setHidden:YES) and stay in the
    // main process views Map so existing IPC handlers still work.
    for (const tab of currentTabs) {
      native.browserViews.hide(tab.webviewLabel).catch(() => {});
    }

    // Load tabs for the new workspace (reuses loadWorkspaceTabs helper)
    const { tabs: newTabs, activeTabId: newActiveId } = loadWorkspaceTabs(workspaceId);

    tabRefs.current.clear();

    setTabs(newTabs);
    setActiveTabId(newActiveId);
    prevWorkspaceIdRef.current = workspaceId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // --- Listen for popup/OAuth new-tab requests from the main process ---
  // When a page calls window.open() or has target="_blank" links (e.g. Google
  // OAuth), the main process sends "browser:new-tab-requested" instead of
  // opening in the system browser. This keeps OAuth flows in-app so callbacks work.
  useEffect(() => {
    const unlisten = native.events.on(BROWSER_NEW_TAB_REQUESTED, (data) => {
      const newTab = createBrowserTab(workspaceId);
      newTab.url = data.url;
      newTab.currentUrl = data.url;
      setTabs((prev) => {
        const next = [...prev, newTab];
        persistTabs(next, newTab.id);
        return next;
      });
      // Only activate the new tab for foreground dispositions
      if (data.disposition !== "background-tab") {
        setActiveTabId(newTab.id);
      }
    });
    return unlisten;
  }, [workspaceId, persistTabs]);

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
      setTabs((prev) => {
        // Close the native webview — lookup from prev (always fresh, no stale closure).
        const closingTab = prev.find((t) => t.id === closingTabId);
        if (closingTab) {
          native.browserViews.hide(closingTab.webviewLabel).catch(() => {});
          native.browserViews.close(closingTab.webviewLabel).catch(() => {});
        }

        const idx = prev.findIndex((t) => t.id === closingTabId);
        let newTabs = prev.filter((t) => t.id !== closingTabId);

        let nextActiveId = activeTabIdRef.current;
        // When closing the last tab, create a fresh empty tab (like real browsers)
        if (newTabs.length === 0) {
          const freshTab = createBrowserTab(workspaceId);
          newTabs = [freshTab];
          nextActiveId = freshTab.id;
          setActiveTabId(nextActiveId);
        } else if (closingTabId === activeTabIdRef.current) {
          const nextIdx = Math.min(idx, newTabs.length - 1);
          nextActiveId = newTabs[nextIdx].id;
          setActiveTabId(nextActiveId);
        }

        persistTabs(newTabs, nextActiveId);
        return newTabs;
      });
      tabRefs.current.delete(closingTabId);
    },
    [workspaceId, persistTabs]
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

        // Persist on URL, title, or viewport changes (page load finish, navigation, device preset)
        if (
          updates.currentUrl !== undefined ||
          updates.title !== undefined ||
          updates.viewport !== undefined ||
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

  /** Capture the active tab's BrowserView as PNG and dispatch to chat input */
  const handleScreenshot = useCallback(async () => {
    if (!activeTab?.webviewLabel || !activeTab.currentUrl || !workspaceId) return;
    try {
      const dataUrl = await native.browserViews.screenshot(activeTab.webviewLabel);
      if (!dataUrl) return;
      // capturePage().toDataURL() returns "data:image/png;base64,..." — strip prefix
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "image/png" });
      const file = new File([blob], `browser-screenshot-${Date.now()}.png`, { type: "image/png" });
      chatInsertActions.insertFiles(workspaceId, [file]);
    } catch (err) {
      console.error("Browser screenshot failed:", err);
    }
  }, [activeTab?.webviewLabel, activeTab?.currentUrl, workspaceId]);

  /** Set viewport emulation — state update only. BrowserTab's useLayoutEffect
   *  handles the IPC (setEmulation/clearEmulation + setBounds) because it knows
   *  the panel dimensions needed to compute scale-to-fit. */
  const handleViewportChange = useCallback(
    (viewport: ViewportState | null) => {
      if (!activeTab?.id) return;
      handleUpdateTab(activeTab.id, { viewport });
    },
    [activeTab?.id, handleUpdateTab]
  );

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

    tabRefs.current.get(activeTab.id)?.goBack();
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

    tabRefs.current.get(activeTab.id)?.goForward();
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
      if (e.key === "Escape" && activeTab) {
        handleUpdateTab(activeTab.id, { url: activeTab.currentUrl });
        e.currentTarget.blur();
      }
    },
    [handleNavigate, activeTab, handleUpdateTab]
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
      persistTabs(tabInfoRef.current, tabId);
    },
    [persistTabs]
  );

  const handleToggleDevtools = useCallback(() => {
    if (!activeTab?.webviewLabel) return;
    if (activeTab.devtoolsOpen) {
      native.browserViews
        .closeDevtools(activeTab.webviewLabel)
        .then(() => handleUpdateTab(activeTab.id, { devtoolsOpen: false }))
        .catch((err) => handleAddLog(activeTab.id, "error", `Close devtools failed: ${err}`));
    } else {
      native.browserViews
        .openDevtools(activeTab.webviewLabel)
        .then(() => handleUpdateTab(activeTab.id, { devtoolsOpen: true }))
        .catch((err) => handleAddLog(activeTab.id, "error", `Open devtools failed: ${err}`));
    }
  }, [activeTab, handleUpdateTab, handleAddLog]);

  // --- Cookie Sync ---

  const [cookieBrowsers, setCookieBrowsers] = useState<InstalledBrowser[]>([]);
  const [cookieSyncing, setCookieSyncing] = useState<string | null>(null); // browser name being synced
  const [lastSyncResult, setLastSyncResult] = useState<{ browser: string; count: number } | null>(
    null
  );

  // Cookie import requires macOS Keychain handlers (not yet implemented).
  // The dropdown degrades gracefully to "No browsers detected" until wired up.
  const handleCookieDropdownOpen = useCallback(() => {
    setCookieBrowsers([]);
  }, []);

  // Cookie sync requires macOS Keychain handlers (not yet implemented).
  const handleCookieSync = useCallback(
    (_browserName: string) => {
      if (!activeTab?.currentUrl) return;
      handleAddLog(activeTab.id, "warn", "Cookie sync not yet available");
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

  // Derived: hostname of the active tab's URL for the cookie dropdown label
  let cookieDropdownHostname: string | null = null;
  if (activeTab?.currentUrl) {
    try {
      cookieDropdownHostname = new URL(activeTab.currentUrl).hostname;
    } catch {
      cookieDropdownHostname = null;
    }
  }

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

        <ViewportDropdown
          viewport={activeTab?.viewport ?? null}
          onChange={handleViewportChange}
          onOpenChange={(open) => {
            if (open && activeTab?.webviewLabel) {
              native.browserViews.hide(activeTab.webviewLabel).catch(() => {});
            } else if (!open && activeTab?.webviewLabel && activeTab.currentUrl) {
              native.browserViews.show(activeTab.webviewLabel).catch(() => {});
            }
          }}
          disabled={!activeTab?.currentUrl}
        />

        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              handleCookieDropdownOpen();
              // Hide native webview so the dropdown isn't rendered behind it
              // (WKWebView floats above all DOM layers including portals)
              if (activeTab?.webviewLabel) {
                native.browserViews.hide(activeTab.webviewLabel).catch(() => {});
              }
            } else {
              // Re-show webview when dropdown closes
              if (activeTab?.webviewLabel && activeTab.currentUrl) {
                native.browserViews.show(activeTab.webviewLabel).catch(() => {});
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
            {cookieDropdownHostname && (
              <DropdownMenuLabel className="text-muted-foreground text-2xs truncate font-normal">
                {cookieDropdownHostname}
              </DropdownMenuLabel>
            )}

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
          onClick={handleToggleDevtools}
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
      <div className={`relative min-h-0 flex-1 overflow-hidden ${activeTab?.viewport ? "bg-muted/30" : ""}`}>
        <div className="grid h-full w-full">
          {tabs.map((tab) => (
            <BrowserTab
              key={tab.id}
              ref={setTabRef(tab.id)}
              tab={tab}
              onUpdateTab={handleUpdateTab}
              onAddLog={handleAddLog}
              onElementSelected={handleElementSelected}
              visible={tab.id === activeTabId && panelVisible}
              windowLabel={windowLabel}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
