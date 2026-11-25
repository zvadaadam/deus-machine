/**
 * BrowserHost — persistent local Electron browser host driven by workspace tabs.
 *
 * Unlike the old BrowserPanel, BrowserHost renders NO nested tab bar: every
 * local browser tab is a first-class tab in the right-pane WorkspaceTabBar.
 *
 * Layout:
 *   Navigation Bar (h-9) — < > R [URL bar] inspect screenshot mobile cookie devtools
 *   Tab Content (flex-1)  — all open browser tabs stacked in a CSS Grid so
 *                           <webview> bounds and state stay intact across switches.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
  RotateCw,
  ChevronLeft,
  ChevronRight,
  Terminal,
  MousePointer2,
  Cookie,
  Trash2,
  Camera,
  Monitor,
  Smartphone,
  ArrowUpRight,
} from "lucide-react";
import { BrowserTab } from "./BrowserTab";
import { FocusModeOverlay } from "./FocusModeOverlay";
import { InspectPromptOverlay } from "./InspectPromptOverlay";
import { webviewManager, type Bounds } from "../webview-manager";
import type { BrowserTabState, BrowserTabHandle, ConsoleLog, ElementSelectedEvent } from "../types";
import {
  deriveTitleFromUrl,
  isBlankUrl,
  FOCUS_URL_BAR_EVENT,
  TOGGLE_INSPECT_MODE_EVENT,
} from "../types";
import {
  workspaceLayoutActions,
  useWorkspaceLayoutStore,
} from "@/features/workspace/store/workspaceLayoutStore";
import { normalizeNavigationUrl } from "@/features/workspace-tabs/lib/omnibox";
import type { WorkspaceTab } from "@/features/workspace-tabs/types";
import {
  composerTarget,
  sessionComposerActions,
} from "@/features/session/store/sessionComposerStore";
import { attachScreenshotToComposer } from "../lib/attachScreenshotToComposer";
import { native } from "@/platform";
import { BROWSER_NEW_TAB_REQUESTED } from "@shared/events";
import type { ReactNode } from "react";

const EMPTY_TABS: WorkspaceTab[] = [];
const MAX_LOGS = 500;
const INSPECT_SCREENSHOT_PADDING = 24;
const INSPECT_SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
    ? "⌘⇧D"
    : "Ctrl⇧D";

type PersistedBrowserTabItem = Extract<WorkspaceTab, { kind: "browser" }>;

interface EphemeralBrowserRuntime {
  urlDraft?: string;
  history: string[];
  historyIndex: number;
  loading: boolean;
  error: string | null;
  injected: boolean;
  injectionFailed: boolean;
  selectorActive: boolean;
  devtoolsOpen: boolean;
  consoleLogs: ConsoleLog[];
}

function defaultRuntime(url: string): EphemeralBrowserRuntime {
  const cleanUrl = isBlankUrl(url) ? "" : url;
  return {
    history: cleanUrl ? [cleanUrl] : [],
    historyIndex: cleanUrl ? 0 : -1,
    loading: false,
    error: null,
    injected: false,
    injectionFailed: false,
    selectorActive: false,
    devtoolsOpen: false,
    consoleLogs: [],
  };
}

function isInspectShortcut(e: KeyboardEvent): boolean {
  return (
    !e.repeat && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "d"
  );
}

interface PendingInspection {
  id: number;
  event: ElementSelectedEvent;
  tabId: string;
  boundsAtSelection: Bounds | null;
}

function serializeInspectionRecord(
  record: Record<string, string> | undefined,
  separator: string
): string | undefined {
  if (!record) return undefined;
  return Object.entries(record)
    .map(([key, value]) => `${key}${separator}${value}`)
    .join("; ");
}

function getInspectionScreenshotRect(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.max(0, rect.left - INSPECT_SCREENSHOT_PADDING),
    y: Math.max(0, rect.top - INSPECT_SCREENSHOT_PADDING),
    width: rect.width + INSPECT_SCREENSHOT_PADDING * 2,
    height: rect.height + INSPECT_SCREENSHOT_PADDING * 2,
  };
}

function areBoundsEqual(a: Bounds | null, b: Bounds | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function IconTooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

interface BrowserHostProps {
  workspaceId: string | null;
  /** ID of the currently active workspace tab (when it is a browser tab). */
  activeTabId: string | null;
  /** Whether the local browser host is currently visible on screen. */
  panelVisible: boolean;
}

export function BrowserHost({ workspaceId, activeTabId, panelVisible }: BrowserHostProps) {
  const workspaceTabs = useWorkspaceLayoutStore((s) =>
    workspaceId ? (s.layouts[workspaceId]?.workspaceTabs ?? EMPTY_TABS) : EMPTY_TABS
  );

  const browserItems = useMemo(
    () => workspaceTabs.filter((t): t is PersistedBrowserTabItem => t.kind === "browser"),
    [workspaceTabs]
  );

  const [runtimeByTabId, setRuntimeByTabId] = useState<Record<string, EphemeralBrowserRuntime>>({});

  // Prune stale runtime entries whenever tabs are closed so long sessions never leak memory.
  useEffect(() => {
    const liveIds = new Set(browserItems.map((item) => item.id));
    setRuntimeByTabId((prev) => {
      const keys = Object.keys(prev);
      if (keys.every((k) => liveIds.has(k))) return prev;
      const next: Record<string, EphemeralBrowserRuntime> = {};
      for (const key of keys) {
        if (liveIds.has(key)) next[key] = prev[key];
      }
      return next;
    });
  }, [browserItems]);

  // Merge store tabs with ephemeral runtime state into BrowserTabState[] for BrowserTab children.
  const tabs: BrowserTabState[] = useMemo(
    () =>
      browserItems.map((item) => {
        const rt = runtimeByTabId[item.id] ?? defaultRuntime(item.url);
        const cleanUrl = isBlankUrl(item.url) ? "" : item.url;
        return {
          id: item.id,
          title: item.title || (cleanUrl ? deriveTitleFromUrl(cleanUrl) : "Browser"),
          url: rt.urlDraft !== undefined ? rt.urlDraft : cleanUrl,
          currentUrl: cleanUrl,
          history: rt.history,
          historyIndex: rt.historyIndex,
          loading: rt.loading,
          error: rt.error,
          injected: rt.injected,
          injectionFailed: rt.injectionFailed,
          selectorActive: rt.selectorActive,
          devtoolsOpen: rt.devtoolsOpen,
          consoleLogs: rt.consoleLogs,
          isMobileView: item.isMobileView ?? false,
        };
      }),
    [browserItems, runtimeByTabId]
  );

  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId]
  );
  const activeSelectorActive = !!activeTab?.selectorActive;

  // Workspace focus owns geometry. The browser supplies its floating composer overlay.
  const expanded = useWorkspaceLayoutStore(
    (s) => !!workspaceId && s.layouts[workspaceId]?.panelMode === "content"
  );
  const showFocusOverlay = expanded && panelVisible && !!workspaceId && !!activeTab;
  const exitFocusMode = useCallback(() => {
    if (workspaceId) workspaceLayoutActions.setPanelMode(workspaceId, "split");
  }, [workspaceId]);

  useEffect(() => {
    if (!showFocusOverlay) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !activeSelectorActive) exitFocusMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showFocusOverlay, activeSelectorActive, exitFocusMode]);

  const tabRefs = useRef<Map<string, BrowserTabHandle>>(new Map());
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const [tabHostEl, setTabHostEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const onFocus = () => {
      if (!panelVisible) return;
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    };
    window.addEventListener(FOCUS_URL_BAR_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_URL_BAR_EVENT, onFocus);
  }, [panelVisible]);

  // Auto-focus URL bar when landing on a blank browser tab
  const activeTabUrl = activeTab?.currentUrl ?? "";
  const activeBrowserId = activeTab?.id ?? null;
  useEffect(() => {
    if (!panelVisible || !activeBrowserId) return;
    if (!isBlankUrl(activeTabUrl)) return;
    const raf = requestAnimationFrame(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeBrowserId, activeTabUrl, panelVisible]);

  // --- Popup / OAuth new-tab requests from main process ---
  useEffect(() => {
    if (!workspaceId) return;
    return native.events.on(BROWSER_NEW_TAB_REQUESTED, (data) => {
      if (
        data.sourceWebContentsId !== undefined &&
        !tabsRef.current.some(
          (t) => webviewManager.webContentsIdOf(t.id) === data.sourceWebContentsId
        )
      ) {
        return;
      }
      workspaceLayoutActions.openBrowserTab(workspaceId, data.url, {
        background: data.disposition === "background-tab",
      });
    });
  }, [workspaceId]);

  // --- Tab state updater (splits persisted store fields vs ephemeral runtime) ---
  const handleUpdateTab = useCallback(
    (tabId: string, updates: Partial<BrowserTabState>) => {
      // Ephemeral runtime fields
      const hasRuntimeUpdate =
        updates.url !== undefined ||
        updates.history !== undefined ||
        updates.historyIndex !== undefined ||
        updates.loading !== undefined ||
        updates.error !== undefined ||
        updates.injected !== undefined ||
        updates.injectionFailed !== undefined ||
        updates.selectorActive !== undefined ||
        updates.devtoolsOpen !== undefined;

      if (hasRuntimeUpdate) {
        setRuntimeByTabId((prev) => {
          const existing =
            prev[tabId] ??
            defaultRuntime(tabsRef.current.find((t) => t.id === tabId)?.currentUrl ?? "");
          const next: EphemeralBrowserRuntime = {
            ...existing,
            ...(updates.url !== undefined ? { urlDraft: updates.url } : {}),
            ...(updates.currentUrl !== undefined && updates.url === undefined
              ? { urlDraft: updates.currentUrl }
              : {}),
            ...(updates.history !== undefined ? { history: updates.history } : {}),
            ...(updates.historyIndex !== undefined ? { historyIndex: updates.historyIndex } : {}),
            ...(updates.loading !== undefined ? { loading: updates.loading } : {}),
            ...(updates.error !== undefined ? { error: updates.error } : {}),
            ...(updates.injected !== undefined ? { injected: updates.injected } : {}),
            ...(updates.injectionFailed !== undefined
              ? { injectionFailed: updates.injectionFailed }
              : {}),
            ...(updates.selectorActive !== undefined
              ? { selectorActive: updates.selectorActive }
              : {}),
            ...(updates.devtoolsOpen !== undefined ? { devtoolsOpen: updates.devtoolsOpen } : {}),
          };
          return { ...prev, [tabId]: next };
        });
      }

      // Persisted store fields (url, title, isMobileView)
      if (
        workspaceId &&
        (updates.currentUrl !== undefined ||
          updates.title !== undefined ||
          updates.isMobileView !== undefined ||
          (updates.loading === false && !updates.error))
      ) {
        workspaceLayoutActions.updateWorkspaceTab(workspaceId, tabId, "browser", (tab) => {
          const nextUrl = updates.currentUrl !== undefined ? updates.currentUrl : tab.url;
          let nextTitle = updates.title !== undefined ? updates.title : tab.title;
          if (
            updates.loading === false &&
            !updates.error &&
            nextUrl &&
            (!nextTitle || nextTitle === "Browser" || nextTitle === "New Tab")
          ) {
            nextTitle = deriveTitleFromUrl(nextUrl);
          }
          const nextMobile =
            updates.isMobileView !== undefined ? updates.isMobileView : tab.isMobileView;
          if (tab.url === nextUrl && tab.title === nextTitle && tab.isMobileView === nextMobile) {
            return tab;
          }
          return {
            ...tab,
            url: nextUrl,
            title: nextTitle,
            ...(nextMobile ? { isMobileView: true } : { isMobileView: undefined }),
          };
        });
      }
    },
    [workspaceId]
  );

  const handleAddLog = useCallback((tabId: string, level: ConsoleLog["level"], message: string) => {
    setRuntimeByTabId((prev) => {
      const existing = prev[tabId] ?? defaultRuntime("");
      const nextLogs = [...existing.consoleLogs, { timestamp: new Date(), level, message }];
      return {
        ...prev,
        [tabId]: {
          ...existing,
          consoleLogs:
            nextLogs.length > MAX_LOGS ? nextLogs.slice(nextLogs.length - MAX_LOGS) : nextLogs,
        },
      };
    });
  }, []);

  // --- Inspect mode ---
  const [pendingInspection, setPendingInspection] = useState<PendingInspection | null>(null);
  const [pendingInspectionBounds, setPendingInspectionBounds] = useState<Bounds | null>(null);
  const nextInspectionIdRef = useRef(0);

  const handleElementSelected = useCallback(
    (tabId: string, event: ElementSelectedEvent) => {
      if (event.type !== "element-selected" || !event.element || !workspaceId) return;
      const boundsAtSelection = tabRefs.current.get(tabId)?.getWebviewBounds?.() ?? null;
      setPendingInspectionBounds(boundsAtSelection);
      setPendingInspection({
        id: ++nextInspectionIdRef.current,
        event,
        tabId,
        boundsAtSelection,
      });
    },
    [workspaceId]
  );

  const clearPendingInspection = useCallback((inspection: PendingInspection | null) => {
    if (!inspection) return;
    setPendingInspection((current) => (current?.id === inspection.id ? null : current));
    void tabRefs.current
      .get(inspection.tabId)
      ?.clearInspectSelection?.(inspection.event.selectionKey);
  }, []);

  const disableElementSelector = useCallback(() => {
    clearPendingInspection(pendingInspection);
    if (activeTabId) {
      void tabRefs.current.get(activeTabId)?.setElementSelectorActive(false);
    }
  }, [activeTabId, pendingInspection, clearPendingInspection]);

  const handleInspectPromptSubmit = useCallback(
    async (text: string) => {
      const inspection = pendingInspection;
      if (!inspection || !workspaceId) return;
      const sid = workspaceLayoutActions.getLayout(workspaceId).activeChatTabSessionId;
      const { event, tabId } = inspection;
      const element = event.element;
      if (!sid || !element) {
        clearPendingInspection(inspection);
        return;
      }

      try {
        sessionComposerActions.appendDraft(sid, text);
        sessionComposerActions.addInspectedElement(sid, {
          ref: event.ref ?? "",
          tagName: element.tagName,
          path: element.path,
          innerText: element.innerText,
          context: event.context,
          reactComponent: event.reactComponent?.name,
          file: event.reactComponent?.fileName ?? undefined,
          line: event.reactComponent?.lineNumber?.toString() ?? undefined,
          styles: serializeInspectionRecord(element.styles, ": "),
          props: serializeInspectionRecord(element.props, "="),
          attributes: serializeInspectionRecord(element.attributes, "="),
          innerHTML: element.innerHTML,
        });

        const handle = tabRefs.current.get(tabId);
        if (handle?.captureScreenshot) {
          const target = composerTarget(sid);
          try {
            await handle.setInspectOverlaysVisible?.(false);
            const dataUrl = await handle.captureScreenshot(
              getInspectionScreenshotRect(element.rect)
            );
            await attachScreenshotToComposer(target, dataUrl, `element-${event.ref ?? "region"}`);
          } finally {
            await handle.setInspectOverlaysVisible?.(true);
          }
        }
      } finally {
        clearPendingInspection(inspection);
      }
    },
    [pendingInspection, workspaceId, clearPendingInspection]
  );

  useEffect(() => {
    if (!pendingInspection) return;
    if (pendingInspection.tabId !== activeTabId || !activeSelectorActive) {
      clearPendingInspection(pendingInspection);
    }
  }, [pendingInspection, activeTabId, activeSelectorActive, clearPendingInspection]);

  useEffect(() => {
    if (!activeSelectorActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      disableElementSelector();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeSelectorActive, disableElementSelector]);

  useEffect(() => {
    if (!pendingInspection) return;
    const handle = tabRefs.current.get(pendingInspection.tabId);
    if (!handle?.getWebviewBounds) return;

    const syncBounds = () => {
      const nextBounds = handle.getWebviewBounds?.() ?? null;
      setPendingInspectionBounds((current) =>
        areBoundsEqual(current, nextBounds) ? current : nextBounds
      );
      if (
        pendingInspection.boundsAtSelection &&
        nextBounds &&
        (nextBounds.width !== pendingInspection.boundsAtSelection.width ||
          nextBounds.height !== pendingInspection.boundsAtSelection.height)
      ) {
        clearPendingInspection(pendingInspection);
      }
    };

    const rafId = requestAnimationFrame(syncBounds);
    const ro = tabHostEl ? new ResizeObserver(syncBounds) : null;
    if (ro && tabHostEl) ro.observe(tabHostEl);
    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, [
    pendingInspection,
    tabHostEl,
    activeTab?.isMobileView,
    activeTab?.devtoolsOpen,
    clearPendingInspection,
  ]);

  // --- Navigation handlers ---
  const handleScreenshot = useCallback(async () => {
    if (!activeTab?.currentUrl || !workspaceId) return;
    const sid = workspaceLayoutActions.getLayout(workspaceId).activeChatTabSessionId;
    if (!sid) return;
    const handle = tabRefs.current.get(activeTab.id);
    if (!handle?.captureScreenshot) return;
    const target = composerTarget(sid);
    const dataUrl = await handle.captureScreenshot();
    await attachScreenshotToComposer(target, dataUrl, "full-page");
  }, [activeTab, workspaceId]);

  const handleToggleMobileView = useCallback(() => {
    if (!activeTab?.id) return;
    handleUpdateTab(activeTab.id, { isMobileView: !activeTab.isMobileView });
  }, [activeTab, handleUpdateTab]);

  const handleNavigate = useCallback(() => {
    if (!activeTab) return;
    const targetUrl = activeTab.url.trim();
    if (!targetUrl) return;

    const fullUrl = normalizeNavigationUrl(targetUrl);
    const title = deriveTitleFromUrl(fullUrl);
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

  const handleOpenExternal = useCallback(() => {
    if (!activeTab?.currentUrl || isBlankUrl(activeTab.currentUrl)) return;
    window.open(activeTab.currentUrl, "_blank");
  }, [activeTab]);

  const handleToggleSelector = useCallback(() => {
    if (!activeTab?.currentUrl) return;
    tabRefs.current.get(activeTab.id)?.toggleElementSelector();
  }, [activeTab]);

  useEffect(() => {
    if (!panelVisible || !activeTab) return;
    const onToggleInspect = () => handleToggleSelector();
    const onKey = (e: KeyboardEvent) => {
      if (!isInspectShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      handleToggleSelector();
    };
    window.addEventListener(TOGGLE_INSPECT_MODE_EVENT, onToggleInspect);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener(TOGGLE_INSPECT_MODE_EVENT, onToggleInspect);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [panelVisible, activeTab, handleToggleSelector]);

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

  const handleClearCookies = useCallback(() => {
    if (!activeTab?.currentUrl) return;
    const restoreUrl = activeTab.currentUrl;
    const handle = tabRefs.current.get(activeTab.id);
    if (!handle) return;
    handleAddLog(activeTab.id, "info", "Clearing site data...");
    handle.navigateToUrl("about:blank");
    setTimeout(() => {
      handle.navigateToUrl(restoreUrl);
      handleAddLog(activeTab.id, "info", "Reloaded without cookies");
    }, 200);
  }, [activeTab, handleAddLog]);

  const setTabRef = useCallback(
    (tabId: string) => (handle: BrowserTabHandle | null) => {
      if (handle) tabRefs.current.set(tabId, handle);
      else tabRefs.current.delete(tabId);
    },
    []
  );

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
      {/* Navigation Bar — clean single-row browser toolbar */}
      <TooltipProvider delayDuration={400}>
        <div className="border-border-subtle flex h-9 flex-shrink-0 items-center gap-1.5 border-b px-2">
          <IconTooltip label="Go back">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary"
              onClick={handleGoBack}
              disabled={!activeTab || activeTab.loading || activeTab.historyIndex <= 0}
              aria-label="Go back"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>

          <IconTooltip label="Go forward">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary"
              onClick={handleGoForward}
              disabled={
                !activeTab ||
                activeTab.loading ||
                activeTab.historyIndex >= activeTab.history.length - 1
              }
              aria-label="Go forward"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>

          <IconTooltip label="Reload">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary"
              onClick={handleReload}
              disabled={!activeTab || activeTab.loading || !activeTab.currentUrl}
              aria-label="Reload"
            >
              <RotateCw className={`h-3 w-3 ${activeTab?.loading ? "animate-spin" : ""}`} />
            </Button>
          </IconTooltip>

          <div className="group relative flex min-w-0 flex-1 items-center">
            <Input
              ref={urlInputRef}
              type="text"
              value={isBlankUrl(activeTab?.url) ? "" : (activeTab?.url ?? "")}
              onChange={handleUrlChange}
              onKeyDown={handleKeyDown}
              onFocus={(e) => e.target.select()}
              placeholder="Enter URL"
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
              className="hover:bg-muted/60 focus-visible:bg-muted/80 focus-visible:ring-primary/40 h-7 w-full min-w-0 border-0 bg-transparent pr-7 text-sm shadow-none transition-colors focus-visible:ring-2"
              disabled={!activeTab || activeTab.loading}
            />
            {activeTab?.currentUrl && !isBlankUrl(activeTab.currentUrl) && (
              <IconTooltip label="Open in external browser">
                <button
                  type="button"
                  onClick={handleOpenExternal}
                  className="control-interaction text-text-muted hover:text-text-secondary absolute right-1 flex h-5 w-5 items-center justify-center rounded-lg opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                  aria-label="Open in external browser"
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              </IconTooltip>
            )}
          </div>

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
              <div className="flex items-center gap-3">
                <span>
                  {activeTab?.selectorActive ? "Exit inspect mode" : "Inspect an element"}
                </span>
                <span className="text-muted-foreground text-xs tracking-widest">
                  {activeTab?.selectorActive ? "Esc" : INSPECT_SHORTCUT}
                </span>
              </div>
            }
          >
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary"
              onClick={handleToggleSelector}
              disabled={!activeTab?.currentUrl}
              aria-pressed={activeTab?.selectorActive}
              aria-label={activeTab?.selectorActive ? "Exit inspect mode" : "Inspect an element"}
            >
              <MousePointer2 className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>

          <IconTooltip label="Screenshot to chat">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary"
              onClick={handleScreenshot}
              disabled={!activeTab?.currentUrl}
              aria-label="Screenshot to chat"
            >
              <Camera className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>

          <IconTooltip
            label={activeTab?.isMobileView ? "Switch to desktop view" : "Switch to mobile view"}
          >
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary"
              onClick={handleToggleMobileView}
              disabled={!activeTab?.currentUrl}
              aria-pressed={!!activeTab?.isMobileView}
              aria-label={
                activeTab?.isMobileView ? "Switch to desktop view" : "Switch to mobile view"
              }
            >
              {activeTab?.isMobileView ? (
                <Smartphone className="h-3.5 w-3.5" />
              ) : (
                <Monitor className="h-3.5 w-3.5" />
              )}
            </Button>
          </IconTooltip>

          <DropdownMenu>
            <IconTooltip label="Site data">
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary"
                  disabled={!activeTab?.currentUrl}
                  aria-label="Site data"
                >
                  <Cookie className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </IconTooltip>
            <DropdownMenuContent align="end" className="w-56">
              {cookieDropdownHostname && (
                <DropdownMenuLabel className="text-muted-foreground text-2xs truncate font-normal">
                  {cookieDropdownHostname}
                </DropdownMenuLabel>
              )}
              {activeTab?.currentUrl && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive text-xs"
                    onClick={handleClearCookies}
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
              size="icon-xs"
              className="text-text-muted hover:text-text-secondary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:text-primary"
              onClick={handleToggleDevtools}
              disabled={!activeTab?.currentUrl}
              aria-pressed={activeTab?.devtoolsOpen}
              aria-label={activeTab?.devtoolsOpen ? "Close DevTools" : "Open DevTools"}
            >
              <Terminal className="h-3.5 w-3.5" />
            </Button>
          </IconTooltip>
        </div>
      </TooltipProvider>

      {/* Stacked webview tabs */}
      <div
        ref={setTabHostEl}
        className={`relative min-h-0 flex-1 overflow-hidden ${activeTab?.isMobileView ? "bg-muted/30" : ""}`}
      >
        {showFocusOverlay && workspaceId && (
          <FocusModeOverlay anchorEl={tabHostEl} workspaceId={workspaceId} onExit={exitFocusMode} />
        )}
        {pendingInspection && pendingInspection.tabId === activeTabId && panelVisible && (
          <InspectPromptOverlay
            event={pendingInspection.event}
            webviewBounds={pendingInspectionBounds}
            onSubmit={handleInspectPromptSubmit}
            onDismiss={disableElementSelector}
          />
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
