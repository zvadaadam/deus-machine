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

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Terminal,
  MousePointer2,
  Cookie,
  Check,
  Loader2,
  Trash2,
  Camera,
  Monitor,
  Smartphone,
} from "lucide-react";
import { BrowserTabBar } from "./BrowserTabBar";
import { BrowserTab } from "./BrowserTab";
import { FocusModeOverlay } from "./FocusModeOverlay";
import { webviewManager } from "../webview-manager";
import { useSidebar } from "@/components/ui";
import type {
  BrowserTabState,
  BrowserTabHandle,
  ConsoleLog,
  PersistedBrowserTab,
  ElementSelectedEvent,
} from "../types";
import {
  createBrowserTab,
  deriveTitleFromUrl,
  hydratePersistedTab,
  isBlankUrl,
  FOCUS_URL_BAR_EVENT,
} from "../types";
import {
  workspaceLayoutActions,
  useWorkspaceLayoutStore,
} from "@/features/workspace/store/workspaceLayoutStore";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import { processImageFiles } from "@/features/session/lib/imageAttachments";
import { useBrowserWindowStore, browserWindowActions } from "../store/browserWindowStore";
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
  /** Whether the Browser content tab is currently the active one in the
   *  workspace view. When false, the whole panel is hidden by its parent
   *  wrapper (`invisible absolute`), but <webview> elements live in
   *  document.body and don't see that CSS — we must forward this down so
   *  the webviews hide themselves via the useWebview hook.
   *
   *  Defaults true so out-of-tree callers (storybook, tests) still work. */
  panelVisible?: boolean;
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

/** Single-line wrapper that replaces the native `title=` attribute on every
 *  toolbar button with the design-system Tooltip. All triggers below sit
 *  under one TooltipProvider so hovering across siblings reuses the delay. */
function IconTooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Serialize tabs for persistence — only tabs with a real loaded URL.
 *  Blank/about:blank tabs are ephemeral (always recreated on mount), so we
 *  don't write them to localStorage. */
function serializeTabs(tabs: BrowserTabState[]): PersistedBrowserTab[] {
  return tabs
    .filter((t) => !isBlankUrl(t.currentUrl))
    .map((t) => ({
      id: t.id,
      url: t.currentUrl,
      title: t.title,
      ...(t.isMobileView ? { isMobileView: true } : {}),
      ...(t.openedAt ? { openedAt: t.openedAt } : {}),
    }));
}

export function BrowserPanel({ workspaceId, panelVisible = true }: BrowserPanelProps) {
  // --- Initialize tabs from persisted state or create a fresh empty tab ---
  const [{ tabs: initialTabs, activeTabId: initialActiveId }] = useState(() =>
    loadWorkspaceTabs(workspaceId)
  );
  const [tabs, setTabs] = useState<BrowserTabState[]>(initialTabs);
  const [activeTabId, setActiveTabId] = useState<string>(initialActiveId);

  // Focus mode — toggle lives in `browserWindowStore.focusModeByWorkspace`.
  // When flipped ON, we stash the current layout and collapse chat + sidebar;
  // flipped OFF, we restore. The ContentTabBar button drives this flag.
  const focusMode = useBrowserWindowStore((s) =>
    workspaceId ? (s.focusModeByWorkspace[workspaceId] ?? false) : false
  );

  // Chat-panel collapsed state. The overlay composer appears whenever
  // chat is collapsed AND we're on the Browser tab — the user either
  // dragged the splitter to collapse or clicked the focus button. Either
  // way, we give them the floating composer so they can keep chatting
  // without a visible chat panel.
  const chatCollapsed = useWorkspaceLayoutStore((s) =>
    workspaceId ? (s.layouts[workspaceId]?.chatPanelCollapsed ?? false) : false
  );
  const showFocusOverlay = (focusMode || chatCollapsed) && panelVisible && !!workspaceId;
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
  const previousLayoutRef = useRef<{ chatCollapsed: boolean; sidebarOpen: boolean } | null>(null);

  // Hold the latest values in refs so the focus-mode side-effect doesn't
  // re-fire just because `setSidebarOpen` or `sidebarOpen` changed identity
  // (useSidebar re-memoises setOpen on every open flip, which used to
  // reset focus mode mid-entry).
  const setSidebarOpenRef = useRef(setSidebarOpen);
  const sidebarOpenRef = useRef(sidebarOpen);
  useEffect(() => {
    setSidebarOpenRef.current = setSidebarOpen;
    sidebarOpenRef.current = sidebarOpen;
  });

  // Apply / revert the layout changes when focus mode toggles.
  useEffect(() => {
    if (!workspaceId) return;
    if (focusMode) {
      if (!previousLayoutRef.current) {
        const layout = workspaceLayoutActions.getLayout(workspaceId);
        previousLayoutRef.current = {
          chatCollapsed: layout.chatPanelCollapsed,
          sidebarOpen: sidebarOpenRef.current,
        };
      }
      workspaceLayoutActions.setChatPanelCollapsed(workspaceId, true);
      setSidebarOpenRef.current(false);
    } else if (previousLayoutRef.current) {
      workspaceLayoutActions.setChatPanelCollapsed(
        workspaceId,
        previousLayoutRef.current.chatCollapsed
      );
      setSidebarOpenRef.current(previousLayoutRef.current.sidebarOpen);
      previousLayoutRef.current = null;
    }
  }, [focusMode, workspaceId]);

  // On workspace switch: exit focus mode (so the overlay doesn't follow the
  // user to a different workspace) and restore the previous layout.
  useEffect(() => {
    return () => {
      if (!workspaceId) return;
      if (previousLayoutRef.current) {
        workspaceLayoutActions.setChatPanelCollapsed(
          workspaceId,
          previousLayoutRef.current.chatCollapsed
        );
        setSidebarOpenRef.current(previousLayoutRef.current.sidebarOpen);
        previousLayoutRef.current = null;
      }
      browserWindowActions.setFocusMode(workspaceId, false);
    };
  }, [workspaceId]);

  // Esc anywhere exits focus mode.
  useEffect(() => {
    if (!focusMode || !workspaceId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") browserWindowActions.setFocusMode(workspaceId, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode, workspaceId]);

  // Auto-exit when the Browser content tab is no longer active — otherwise
  // the portal-rendered overlay would keep floating over whatever tab the
  // user switched to (Apps / Files / etc).
  useEffect(() => {
    if (!panelVisible && focusMode && workspaceId) {
      browserWindowActions.setFocusMode(workspaceId, false);
    }
  }, [panelVisible, focusMode, workspaceId]);

  const exitFocusMode = useCallback(() => {
    if (workspaceId) browserWindowActions.setFocusMode(workspaceId, false);
  }, [workspaceId]);

  // Imperative handles per tab
  const tabRefs = useRef<Map<string, BrowserTabHandle>>(new Map());

  // Debounced persistence timer
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track previous workspaceId to detect switches
  const prevWorkspaceIdRef = useRef(workspaceId);

  // Derived: active tab for nav bar state
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // "Latest value" refs used by stable callbacks (closeTab, handleTabSelect)
  // — child event handlers read the most recent tab list without forcing
  // the callback to re-memoize. Updated in an effect (not during render)
  // to satisfy react-hooks/refs; event handlers fire after commit anyway.
  const tabInfoRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    tabInfoRef.current = tabs;
    activeTabIdRef.current = activeTabId;
  });

  // URL bar focus — dispatched by BrowserTab when the guest preload sees Cmd+L.
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  // The panel container that hosts browser tabs — used as the anchor rect
  // for the portal-rendered FocusModeOverlay so it can sit visually over
  // the browser view despite living outside the component tree. Held in
  // state (via callback ref) rather than a plain ref so we can pass the
  // element to the overlay without reading `.current` during render.
  const [tabHostEl, setTabHostEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const onFocus = () => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    };
    window.addEventListener(FOCUS_URL_BAR_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_URL_BAR_EVENT, onFocus);
  }, []);

  // Fire the focus-url-bar event on the next frame — rAF lets React commit
  // the new tab / activeTabId first so the <input> is enabled when the
  // listener runs `urlInputRef.current?.focus()`.
  const requestFocusUrlBar = useCallback(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent(FOCUS_URL_BAR_EVENT));
    });
  }, []);

  // Auto-focus the URL bar whenever the active tab has no real URL and the
  // panel is visible — covers app launch, workspace switch, and tab switch
  // landing on an empty tab. Explicit user actions (addTab, close-last-tab)
  // also call requestFocusUrlBar(); this effect is the passive safety net.
  const activeTabUrl = activeTab?.currentUrl ?? "";
  useEffect(() => {
    if (!panelVisible) return;
    if (!isBlankUrl(activeTabUrl)) return;
    requestFocusUrlBar();
  }, [activeTabId, activeTabUrl, panelVisible, requestFocusUrlBar]);

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
  // BrowserPanel stays mounted across workspace switches. The DOM-resident
  // <webview> elements owned by webviewManager survive the swap too — tabs
  // for other workspaces are simply hidden off-screen until their workspace
  // is re-selected. No park/unpark / race-condition dance is needed: CSS
  // visibility handles it naturally.
  useEffect(() => {
    const prevId = prevWorkspaceIdRef.current;
    if (prevId === workspaceId) return;

    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }

    if (prevId) {
      workspaceLayoutActions.setLayout(prevId, {
        browserTabs: serializeTabs(tabInfoRef.current),
        activeBrowserTabId: activeTabIdRef.current,
      });
    }

    const { tabs: newTabs, activeTabId: newActiveId } = loadWorkspaceTabs(workspaceId);
    tabRefs.current.clear();
    // Sync tabs state to the new workspace — legitimate dependency-driven
    // state update (workspaceId is the external signal, tabs are derived
    // from persisted per-workspace layout).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTabs(newTabs);
    setActiveTabId(newActiveId);
    prevWorkspaceIdRef.current = workspaceId;
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

  // --- Consume pending new-tab requests from the browserWindow store ---
  // Producers (AAP launcher, Phase-4 auto-open-on-launch hook) dispatch a
  // URL via `browserWindowActions.requestNewTab(workspaceId, url)`. This
  // effect creates a foreground tab for the matching workspace and consumes
  // the request. Workspace filtering prevents stale requests from a former
  // workspace leaking across a switch.
  const pendingNewTab = useBrowserWindowStore((s) => s.pendingNewTab);
  useEffect(() => {
    if (!pendingNewTab) return;
    if (pendingNewTab.workspaceId !== workspaceId) return;

    const newTab = createBrowserTab(workspaceId);
    newTab.url = pendingNewTab.url;
    newTab.currentUrl = pendingNewTab.url;
    // Stamp the opening URL so apps:stopped can match this tab even after
    // Electron overwrites url/currentUrl on load failure (chrome-error).
    newTab.openedAt = pendingNewTab.url;
    // Reacting to a consumer-side effect (new-tab request dispatched via
    // the global browserWindowStore) — the setState IS the sync from that
    // external store into this component's state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTabs((prev) => {
      const next = [...prev, newTab];
      persistTabs(next, newTab.id);
      return next;
    });
    setActiveTabId(newTab.id);
    browserWindowActions.consumePendingNewTab();
  }, [pendingNewTab, workspaceId, persistTabs]);

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
    // New tabs always land on the empty state — put the cursor in the URL
    // bar so the user can start typing immediately (matches Chrome/Safari).
    requestFocusUrlBar();
  }, [workspaceId, persistTabs, requestFocusUrlBar]);

  const closeTab = useCallback(
    (closingTabId: string) => {
      setTabs((prev) => {
        // Dispose both the page <webview> and the companion DevTools host
        // so their guest pages tear down. Keeps memory tight as tabs churn.
        webviewManager.dispose(closingTabId);
        webviewManager.dispose(`${closingTabId}__devtools`);

        const idx = prev.findIndex((t) => t.id === closingTabId);
        let newTabs = prev.filter((t) => t.id !== closingTabId);

        let nextActiveId = activeTabIdRef.current;
        // When closing the last tab, create a fresh empty tab (like real browsers)
        if (newTabs.length === 0) {
          const freshTab = createBrowserTab(workspaceId);
          newTabs = [freshTab];
          nextActiveId = freshTab.id;
          setActiveTabId(nextActiveId);
          requestFocusUrlBar();
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
    [workspaceId, persistTabs, requestFocusUrlBar]
  );

  // Close-tab request consumer — triggered by AAP's `apps:stopped` event
  // via useAppsStopped. Matches any tab whose `currentUrl` shares the
  // dead app's origin+port prefix (covers in-app client-side navigation)
  // and closes it through the existing `closeTab` path so webview cleanup
  // + next-active-tab selection are unified with the manual close flow.
  const pendingCloseTab = useBrowserWindowStore((s) => s.pendingCloseTab);
  useEffect(() => {
    if (!pendingCloseTab) return;
    if (pendingCloseTab.workspaceId !== workspaceId) return;

    // Match on `openedAt` (the URL the tab was created for) rather than
    // `currentUrl`. When an app stops, the <webview> hits
    // ERR_CONNECTION_REFUSED on reload and transitions currentUrl to
    // `chrome-error://chromewebdata/` — prefix matching on that would
    // silently miss the tab we intended to close. `openedAt` is immutable.
    //
    // Snapshot ids before closing — closeTab mutates `tabs` and re-renders
    // asynchronously, so iterating the live array mid-loop would skip or
    // double-close entries.
    const doomed = tabs.filter(
      (t) => t.openedAt && t.openedAt.startsWith(pendingCloseTab.urlPrefix)
    );
    for (const t of doomed) closeTab(t.id);
    browserWindowActions.consumePendingCloseTab();
  }, [pendingCloseTab, workspaceId, tabs, closeTab]);

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
          updates.isMobileView !== undefined ||
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

  /** Push an inspected element into the active chat's composer. We go
   *  straight to the session composer store — the workspace's active
   *  chat-tab sessionId is looked up in workspaceLayoutStore. Only
   *  "element-selected" is handled; "area-selected" is ignored (no
   *  element metadata to reference). */
  const handleElementSelected = useCallback(
    (_tabId: string, event: ElementSelectedEvent) => {
      if (event.type !== "element-selected" || !event.element || !workspaceId) return;
      const sid = workspaceLayoutActions.getLayout(workspaceId).activeChatTabSessionId;
      if (!sid) return;

      // Serialize Record<string, string> fields as semicolon-separated strings.
      const serialize = (rec: Record<string, string> | undefined, sep: string) =>
        rec
          ? Object.entries(rec)
              .map(([k, v]) => `${k}${sep}${v}`)
              .join("; ")
          : undefined;

      sessionComposerActions.addInspectedElement(sid, {
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

  /** Capture the active tab's <webview> as PNG and attach it to the chat
   *  composer. Routes through the session composer store so the image
   *  card appears in every surface (main chat, focus overlay, modal). */
  const handleScreenshot = useCallback(async () => {
    if (!activeTab?.currentUrl || !workspaceId) return;
    const sid = workspaceLayoutActions.getLayout(workspaceId).activeChatTabSessionId;
    if (!sid) return;
    const handle = tabRefs.current.get(activeTab.id);
    if (!handle?.captureScreenshot) return;
    try {
      const dataUrl = await handle.captureScreenshot();
      if (!dataUrl) return;
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      const file = new File([blob], `browser-screenshot-${Date.now()}.png`, { type: "image/png" });
      const processed = await processImageFiles([file]);
      if (processed.length) sessionComposerActions.addImageAttachments(sid, processed);
    } catch (err) {
      console.error("Browser screenshot failed:", err);
    }
  }, [activeTab, workspaceId]);

  /** Toggle between desktop (webview fills panel) and mobile preview
   *  (390-wide centered frame + CDP mobile UA/touch). Per-tab state. */
  const handleToggleMobileView = useCallback(() => {
    if (!activeTab?.id) return;
    handleUpdateTab(activeTab.id, { isMobileView: !activeTab.isMobileView });
  }, [activeTab, handleUpdateTab]);

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
    if (!activeTab) return;
    const handle = tabRefs.current.get(activeTab.id);
    if (!handle) return;
    const action = activeTab.devtoolsOpen ? handle.closeDevtools : handle.openDevtools;
    if (!action) return;
    action()
      .then(() => handleUpdateTab(activeTab.id, { devtoolsOpen: !activeTab.devtoolsOpen }))
      .catch((err) => handleAddLog(activeTab.id, "error", `DevTools toggle failed: ${err}`));
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
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {/* Tab Bar */}
      <BrowserTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabSelect={handleTabSelect}
        onTabClose={closeTab}
        onTabAdd={addTab}
        workspaceId={workspaceId}
      />

      {/* Navigation Bar — h-9 to align with chat tabs row.
       *  One TooltipProvider shares the 400ms open-delay across all icon
       *  triggers, so scanning across buttons after the first hover feels
       *  instant (Radix skipDelayDuration default handles the handoff). */}
      <TooltipProvider delayDuration={400}>
        <div className="border-border-subtle flex h-9 flex-shrink-0 items-center gap-2 border-b px-2">
          <IconTooltip label="Go back">
            <Button
              variant="ghost"
              size="icon"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary h-7 w-7 transition-colors duration-150 ease-out"
              onClick={handleGoBack}
              disabled={!activeTab || activeTab.loading || activeTab.historyIndex <= 0}
              aria-label="Go back"
            >
              <ChevronLeft strokeWidth={1.75} className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>

          <IconTooltip label="Go forward">
            <Button
              variant="ghost"
              size="icon"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary h-7 w-7 transition-colors duration-150 ease-out"
              onClick={handleGoForward}
              disabled={
                !activeTab ||
                activeTab.loading ||
                activeTab.historyIndex >= activeTab.history.length - 1
              }
              aria-label="Go forward"
            >
              <ChevronRight strokeWidth={1.75} className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>

          <IconTooltip label="Reload">
            <Button
              variant="ghost"
              size="icon"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary h-7 w-7 transition-colors duration-150 ease-out"
              onClick={handleReload}
              disabled={!activeTab || activeTab.loading || !activeTab.currentUrl}
              aria-label="Reload"
            >
              <RefreshCw
                strokeWidth={1.75}
                className={`h-3.5 w-3.5 ${activeTab?.loading ? "animate-spin" : ""}`}
              />
            </Button>
          </IconTooltip>

          <Input
            ref={urlInputRef}
            type="text"
            value={isBlankUrl(activeTab?.url) ? "" : (activeTab?.url ?? "")}
            onChange={handleUrlChange}
            onKeyDown={handleKeyDown}
            onFocus={(e) => e.target.select()}
            placeholder="Search or enter URL..."
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            className="bg-bg-elevated focus-visible:border-border-strong h-7 min-w-0 flex-1 text-sm focus-visible:ring-0"
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

          <IconTooltip
            label={
              activeTab?.selectorActive
                ? "Exit element selector (Esc)"
                : "Select element to inspect"
            }
          >
            <Button
              variant="ghost"
              size="icon"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary h-7 w-7 transition-colors duration-150 ease-out"
              onClick={handleToggleSelector}
              disabled={!activeTab?.currentUrl}
              aria-pressed={activeTab?.selectorActive}
              aria-label={
                activeTab?.selectorActive ? "Exit element selector" : "Select element to inspect"
              }
            >
              <MousePointer2 strokeWidth={1.75} className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>

          <IconTooltip label="Screenshot to chat">
            <Button
              variant="ghost"
              size="icon"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary h-7 w-7 transition-colors duration-150 ease-out"
              onClick={handleScreenshot}
              disabled={!activeTab?.currentUrl}
              aria-label="Screenshot to chat"
            >
              <Camera strokeWidth={1.75} className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>

          <IconTooltip
            label={activeTab?.isMobileView ? "Switch to desktop view" : "Switch to mobile view"}
          >
            <Button
              variant="ghost"
              size="icon"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary h-7 w-7 transition-colors duration-150 ease-out"
              onClick={handleToggleMobileView}
              disabled={!activeTab?.currentUrl}
              aria-pressed={!!activeTab?.isMobileView}
              aria-label={
                activeTab?.isMobileView ? "Switch to desktop view" : "Switch to mobile view"
              }
            >
              {activeTab?.isMobileView ? (
                <Smartphone strokeWidth={1.75} className="h-3.5 w-3.5" />
              ) : (
                <Monitor strokeWidth={1.75} className="h-3.5 w-3.5" />
              )}
            </Button>
          </IconTooltip>

          <DropdownMenu onOpenChange={(open) => open && handleCookieDropdownOpen()}>
            <IconTooltip label="Import cookies from browser">
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary h-7 w-7 transition-colors duration-150 ease-out"
                  disabled={!activeTab?.currentUrl || !!cookieSyncing}
                  aria-label="Import cookies from browser"
                >
                  {cookieSyncing ? (
                    <Loader2 strokeWidth={1.75} className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Cookie strokeWidth={1.75} className="h-3.5 w-3.5" />
                  )}
                </Button>
              </DropdownMenuTrigger>
            </IconTooltip>
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

          <IconTooltip label={activeTab?.devtoolsOpen ? "Close DevTools" : "Open DevTools"}>
            <Button
              variant="ghost"
              size="icon"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary h-7 w-7 transition-colors duration-150 ease-out"
              onClick={handleToggleDevtools}
              disabled={!activeTab?.currentUrl}
              aria-pressed={activeTab?.devtoolsOpen}
              aria-label={activeTab?.devtoolsOpen ? "Close DevTools" : "Open DevTools"}
            >
              <Terminal strokeWidth={1.75} className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>
        </div>
      </TooltipProvider>

      {/* Tab content — DevTools docks inside the panel by routing its UI into
       * a second <webview> (see BrowserTab's `getDevtoolsWebview`).
       *
       * Tab stacking uses CSS Grid (all tabs in [grid-area:1/1]) instead of
       * absolute positioning. Previous approach (absolute inset-0 on BrowserTab)
       * broke mobile view: the placeholder's getBoundingClientRect() returned
       * stale full-width values because absolute-positioned elements don't
       * reliably inherit width constraints from their containing block when
       * parent containers restructure (mx-auto, flex centering). Grid stacking
       * keeps tabs in normal flow so they inherit w-[390px] naturally and
       * ResizeObserver fires on actual size changes. */}
      <div
        ref={setTabHostEl}
        className={`relative min-h-0 flex-1 overflow-hidden ${activeTab?.isMobileView ? "bg-muted/30" : ""}`}
      >
        {showFocusOverlay && workspaceId && (
          <FocusModeOverlay anchorEl={tabHostEl} workspaceId={workspaceId} onExit={exitFocusMode} />
        )}
        <div className="grid h-full min-h-0 w-full min-w-0">
          {tabs.map((tab) => (
            <BrowserTab
              key={tab.id}
              ref={setTabRef(tab.id)}
              tab={tab}
              onUpdateTab={handleUpdateTab}
              onAddLog={handleAddLog}
              onElementSelected={handleElementSelected}
              visible={panelVisible && tab.id === activeTabId}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
