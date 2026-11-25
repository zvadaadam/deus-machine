/** Per-workspace view, browser-style tabs, and file state. Live terminal processes are never persisted. */

import { create } from "zustand";
import { createJSONStorage, devtools, persist, type StateStorage } from "zustand/middleware";
import { deriveTitleFromUrl, isBlankUrl } from "@/features/browser/types";
import { webviewManager } from "@/features/browser/webview-manager";
import {
  clearTerminalInitialCommand,
  setTerminalInitialCommand,
} from "@/features/terminal/store/terminalTaskStore";
import { normalizeWorkspaceRelativePath } from "@/features/workspace/lib/normalizeWorkspaceRelativePath";
import {
  DEFAULT_NEW_TAB,
  DEFAULT_NEW_TAB_ID,
  createBrowserTabItem,
  createToolTab,
  type ContentTab,
  type WorkspaceTab,
} from "@/features/workspace-tabs/types";
import {
  addNewTabState,
  closeTabState,
  openBrowserTabState,
  openFileTabState,
  openTerminalTabState,
  openToolTabState,
  reorderTabState,
  updateTabState,
} from "@/features/workspace-tabs/lib/tabOperations";

export type { ContentTab, WorkspaceTab };

export type WorkspacePanelMode = "split" | "chat" | "content";

export type FileNavigationTarget = "files" | "changes";

export interface PendingFileNavigation {
  requestId: string;
  path: string;
  target: FileNavigationTarget;
}

export interface WorkspaceLayoutState {
  workspaceTabs: WorkspaceTab[];
  activeWorkspaceTabId: string | null;
  nextTerminalNum: number; // Counter for "Terminal N" naming
  selectedFilePath: string | null;
  pendingFileNavigation: PendingFileNavigation | null;
  panelMode: WorkspacePanelMode;
  fileTreePinned: boolean; // true = expanded file tree panel, false = minimap strip + hover
  chatTabSessionIds: string[]; // Ordered session IDs for open chat tabs
  activeChatTabSessionId: string | null; // Which chat tab is active
  knownChatSessionIds: string[]; // The chats the tab view knew when it last saved
  simulatorUdid: string | null; // Last-used simulator UDID for this workspace
}

export const defaultLayout: WorkspaceLayoutState = {
  workspaceTabs: [],
  activeWorkspaceTabId: null,
  nextTerminalNum: 1,
  selectedFilePath: null,
  pendingFileNavigation: null,
  panelMode: "split",
  fileTreePinned: true,
  chatTabSessionIds: [],
  activeChatTabSessionId: null,
  knownChatSessionIds: [],
  simulatorUdid: null,
};

// ---------------------------------------------------------------------------
// Persist v11 → v12 typed migration
// ---------------------------------------------------------------------------

interface PersistedBrowserTabV11 {
  id: string;
  url: string;
  title?: string;
  isMobileView?: boolean;
}

interface WorkspaceLayoutV11 {
  activeContentTab?: unknown;
  selectedFilePath?: unknown;
  browserTabs?: unknown;
  activeBrowserTabId?: unknown;
  panelMode?: unknown;
  fileTreePinned?: unknown;
  chatTabSessionIds?: unknown;
  activeChatTabSessionId?: unknown;
  knownChatSessionIds?: unknown;
  simulatorUdid?: unknown;
}

const VALID_PANEL_MODES = new Set<WorkspacePanelMode>(["split", "chat", "content"]);
const VALID_CONTENT_TABS = new Set<ContentTab>([
  "changes",
  "files",
  "config",
  "terminal",
  "browser",
  "simulator",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseBrowserTabsV11(value: unknown): PersistedBrowserTabV11[] {
  if (!Array.isArray(value)) return [];
  const result: PersistedBrowserTabV11[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.url !== "string") continue;
    if (isBlankUrl(item.url)) continue;
    result.push({
      id: item.id,
      url: item.url,
      title: typeof item.title === "string" ? item.title : undefined,
      isMobileView: item.isMobileView === true ? true : undefined,
    });
  }
  return result;
}

function migrateWorkspaceEntryV11(
  workspaceId: string,
  raw: WorkspaceLayoutV11
): WorkspaceLayoutState {
  const panelMode: WorkspacePanelMode =
    typeof raw.panelMode === "string" && VALID_PANEL_MODES.has(raw.panelMode as WorkspacePanelMode)
      ? (raw.panelMode as WorkspacePanelMode)
      : defaultLayout.panelMode;

  const activeContentTab: ContentTab | null =
    typeof raw.activeContentTab === "string" &&
    VALID_CONTENT_TABS.has(raw.activeContentTab as ContentTab)
      ? (raw.activeContentTab as ContentTab)
      : null;

  const oldBrowserTabs = parseBrowserTabsV11(raw.browserTabs);
  const oldActiveBrowserId = asStringOrNull(raw.activeBrowserTabId);

  const migratedBrowserTabs: WorkspaceTab[] = oldBrowserTabs.map((pt) =>
    createBrowserTabItem(workspaceId, pt.url, {
      id: pt.id,
      title: pt.title && !isBlankUrl(pt.title) ? pt.title : deriveTitleFromUrl(pt.url),
      isMobileView: pt.isMobileView,
    })
  );

  const workspaceTabs: WorkspaceTab[] = [];
  let activeWorkspaceTabId: string | null = null;

  if (
    activeContentTab === "changes" ||
    activeContentTab === "files" ||
    activeContentTab === "config" ||
    activeContentTab === "simulator"
  ) {
    const activeToolTab = createToolTab(activeContentTab, workspaceId);
    workspaceTabs.push(activeToolTab, ...migratedBrowserTabs);
    activeWorkspaceTabId = activeToolTab.id;
  } else {
    // "browser", "terminal" (ephemeral — never persisted), or absent
    workspaceTabs.push(...migratedBrowserTabs);
    if (migratedBrowserTabs.length > 0) {
      const matched =
        oldActiveBrowserId && migratedBrowserTabs.some((t) => t.id === oldActiveBrowserId)
          ? oldActiveBrowserId
          : migratedBrowserTabs[0].id;
      activeWorkspaceTabId = matched;
    }
  }

  return {
    ...defaultLayout,
    workspaceTabs,
    activeWorkspaceTabId,
    nextTerminalNum: 1,
    pendingFileNavigation: null,
    selectedFilePath: asStringOrNull(raw.selectedFilePath),
    panelMode,
    fileTreePinned:
      typeof raw.fileTreePinned === "boolean" ? raw.fileTreePinned : defaultLayout.fileTreePinned,
    chatTabSessionIds: asStringArray(raw.chatTabSessionIds),
    activeChatTabSessionId: asStringOrNull(raw.activeChatTabSessionId),
    knownChatSessionIds: asStringArray(raw.knownChatSessionIds),
    simulatorUdid: asStringOrNull(raw.simulatorUdid),
  };
}

/** Migrate persisted layout state from v11 into the v12 browser-tab model. */
export function migrateWorkspaceLayoutState(
  persisted: unknown,
  version: number
): { layouts: Record<string, WorkspaceLayoutState> } {
  if (!isRecord(persisted) || !isRecord(persisted.layouts)) {
    return { layouts: {} };
  }
  if (version >= 12) {
    return persisted as { layouts: Record<string, WorkspaceLayoutState> };
  }
  if (version !== 11) {
    return { layouts: {} };
  }

  const layouts: Record<string, WorkspaceLayoutState> = {};
  for (const [workspaceId, entry] of Object.entries(persisted.layouts)) {
    if (!isRecord(entry)) continue;
    layouts[workspaceId] = migrateWorkspaceEntryV11(workspaceId, entry as WorkspaceLayoutV11);
  }
  return { layouts };
}

// ---------------------------------------------------------------------------
// Coalesced storage (batches rapid browser URL/title updates into one write)
// ---------------------------------------------------------------------------

const PERSIST_COALESCE_MS = 250;

let pendingWrite: { name: string; value: string } | null = null;
let pendingWriteTimer: ReturnType<typeof setTimeout> | null = null;

function getNativeStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

/** Immediately flush any queued debounced persist write to localStorage. */
export function flushWorkspaceLayoutStorage(): void {
  if (pendingWriteTimer !== null) {
    clearTimeout(pendingWriteTimer);
    pendingWriteTimer = null;
  }
  if (!pendingWrite) return;
  const { name, value } = pendingWrite;
  pendingWrite = null;
  try {
    getNativeStorage()?.setItem(name, value);
  } catch {
    // Ignore quota / unavailable storage errors
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", flushWorkspaceLayoutStorage);
  window.addEventListener("beforeunload", flushWorkspaceLayoutStorage);
}

const coalescedStorage: StateStorage = {
  getItem: (name) => {
    if (pendingWrite?.name === name) return pendingWrite.value;
    try {
      return getNativeStorage()?.getItem(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    // In headless/test environments without window, write synchronously.
    if (typeof window === "undefined") {
      try {
        getNativeStorage()?.setItem(name, value);
      } catch {
        // Ignore unavailable storage
      }
      return;
    }
    pendingWrite = { name, value };
    if (pendingWriteTimer !== null) clearTimeout(pendingWriteTimer);
    pendingWriteTimer = setTimeout(flushWorkspaceLayoutStorage, PERSIST_COALESCE_MS);
  },
  removeItem: (name) => {
    if (pendingWrite?.name === name) {
      pendingWrite = null;
      if (pendingWriteTimer !== null) {
        clearTimeout(pendingWriteTimer);
        pendingWriteTimer = null;
      }
    }
    try {
      getNativeStorage()?.removeItem(name);
    } catch {
      // Ignore unavailable storage
    }
  },
};

/** Resolve concrete tabs + active tab for rendering (falls back to virtual New Tab when empty). */
export function resolveWorkspaceTabs(
  layout: Pick<WorkspaceLayoutState, "workspaceTabs" | "activeWorkspaceTabId">
): {
  tabs: WorkspaceTab[];
  activeTabId: string;
  activeTab: WorkspaceTab;
} {
  if (layout.workspaceTabs.length === 0) {
    return {
      tabs: [DEFAULT_NEW_TAB],
      activeTabId: DEFAULT_NEW_TAB_ID,
      activeTab: DEFAULT_NEW_TAB,
    };
  }
  const active =
    (layout.activeWorkspaceTabId
      ? layout.workspaceTabs.find((t) => t.id === layout.activeWorkspaceTabId)
      : undefined) ?? layout.workspaceTabs[0];
  return {
    tabs: layout.workspaceTabs,
    activeTabId: active.id,
    activeTab: active,
  };
}

function revealedMode(mode: WorkspacePanelMode): WorkspacePanelMode {
  return mode === "content" ? "content" : "split";
}

/** Tear down native resources owned by a closed or cleared workspace tab. */
function disposeTabResources(tab: WorkspaceTab): void {
  if (tab.kind === "browser" && !tab.cloud) {
    webviewManager.dispose(tab.id);
    webviewManager.dispose(`${tab.id}__devtools`);
  } else if (tab.kind === "terminal") {
    clearTerminalInitialCommand(tab.id);
  }
}

interface WorkspaceLayoutStore {
  layouts: Record<string, WorkspaceLayoutState>;

  getLayout: (workspaceId: string) => WorkspaceLayoutState;
  setLayout: (workspaceId: string, layout: Partial<WorkspaceLayoutState>) => void;

  setSelectedFilePath: (workspaceId: string, path: string | null) => void;
  setPendingFileNavigation: (workspaceId: string, navigation: PendingFileNavigation | null) => void;
  setPanelMode: (workspaceId: string, mode: WorkspacePanelMode) => void;
  setSimulatorUdid: (workspaceId: string, udid: string | null) => void;
  setChatTabState: (
    workspaceId: string,
    sessionIds: string[],
    activeSessionId: string | null,
    knownSessionIds?: string[]
  ) => void;

  clearWorkspaceLayout: (workspaceId: string) => void;
  resetAll: () => void;
}

export const useWorkspaceLayoutStore = create<WorkspaceLayoutStore>()(
  devtools(
    persist(
      (set, get) => ({
        layouts: {},

        getLayout: (workspaceId) => {
          const { layouts } = get();
          return { ...defaultLayout, ...(layouts[workspaceId] ?? {}) };
        },

        setLayout: (workspaceId, updates) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...defaultLayout,
                  ...state.layouts[workspaceId],
                  ...updates,
                },
              },
            }),
            false,
            "workspaceLayout/setLayout"
          ),

        setSelectedFilePath: (workspaceId, path) =>
          get().setLayout(workspaceId, { selectedFilePath: path }),
        setPendingFileNavigation: (workspaceId, navigation) =>
          get().setLayout(workspaceId, { pendingFileNavigation: navigation }),
        setPanelMode: (workspaceId, panelMode) => get().setLayout(workspaceId, { panelMode }),
        setChatTabState: (workspaceId, sessionIds, activeSessionId, knownSessionIds) =>
          get().setLayout(workspaceId, {
            chatTabSessionIds: sessionIds,
            activeChatTabSessionId: activeSessionId,
            ...(knownSessionIds ? { knownChatSessionIds: knownSessionIds } : {}),
          }),
        setSimulatorUdid: (workspaceId, udid) =>
          get().setLayout(workspaceId, { simulatorUdid: udid }),

        clearWorkspaceLayout: (workspaceId) => {
          const existing = get().layouts[workspaceId];
          if (existing) {
            for (const tab of existing.workspaceTabs) disposeTabResources(tab);
          }
          set(
            (state) => {
              const { [workspaceId]: _removed, ...remaining } = state.layouts;
              return { layouts: remaining };
            },
            false,
            "workspaceLayout/clearWorkspaceLayout"
          );
        },

        resetAll: () => set({ layouts: {} }, false, "workspaceLayout/resetAll"),
      }),
      {
        name: "workspace-layout-store",
        version: 12,
        storage: createJSONStorage(() => coalescedStorage),
        partialize: (state) => ({
          ...state,
          layouts: Object.fromEntries(
            Object.entries(state.layouts).map(([id, layout]) => {
              const persistedTabs = (layout.workspaceTabs ?? []).filter((tab) => {
                if (tab.kind === "terminal") return false;
                // Keep cloud preview tabs even without a URL; strip blank local browser tabs.
                if (tab.kind === "browser" && !tab.cloud && isBlankUrl(tab.url)) return false;
                return true;
              });
              const activeStillPresent =
                layout.activeWorkspaceTabId !== null &&
                persistedTabs.some((t) => t.id === layout.activeWorkspaceTabId);

              return [
                id,
                {
                  ...layout,
                  workspaceTabs: persistedTabs,
                  activeWorkspaceTabId: activeStillPresent
                    ? layout.activeWorkspaceTabId
                    : (persistedTabs[0]?.id ?? null),
                  pendingFileNavigation: null,
                  nextTerminalNum: 1,
                },
              ];
            })
          ),
        }),
        migrate: (persistedState, version) =>
          migrateWorkspaceLayoutState(persistedState, version) as unknown as WorkspaceLayoutStore,
      }
    ),
    {
      name: "workspace-layout-store",
      enabled: import.meta.env.DEV,
    }
  )
);

function currentTabState(layout: WorkspaceLayoutState) {
  return { tabs: layout.workspaceTabs, activeTabId: layout.activeWorkspaceTabId };
}

/**
 * Stable Actions - Call from anywhere without causing re-renders.
 */
export const workspaceLayoutActions = {
  getLayout: (workspaceId: string) => useWorkspaceLayoutStore.getState().getLayout(workspaceId),
  setLayout: (workspaceId: string, layout: Partial<WorkspaceLayoutState>) =>
    useWorkspaceLayoutStore.getState().setLayout(workspaceId, layout),
  setSelectedFilePath: (workspaceId: string, path: string | null) =>
    useWorkspaceLayoutStore.getState().setSelectedFilePath(workspaceId, path),
  setPendingFileNavigation: (workspaceId: string, navigation: PendingFileNavigation | null) =>
    useWorkspaceLayoutStore.getState().setPendingFileNavigation(workspaceId, navigation),
  setPanelMode: (workspaceId: string, mode: WorkspacePanelMode) =>
    useWorkspaceLayoutStore.getState().setPanelMode(workspaceId, mode),
  setChatTabState: (
    workspaceId: string,
    sessionIds: string[],
    activeSessionId: string | null,
    knownSessionIds?: string[]
  ) =>
    useWorkspaceLayoutStore
      .getState()
      .setChatTabState(workspaceId, sessionIds, activeSessionId, knownSessionIds),
  setSimulatorUdid: (workspaceId: string, udid: string | null) =>
    useWorkspaceLayoutStore.getState().setSimulatorUdid(workspaceId, udid),
  clearWorkspaceLayout: (workspaceId: string) =>
    useWorkspaceLayoutStore.getState().clearWorkspaceLayout(workspaceId),
  resetAll: () => useWorkspaceLayoutStore.getState().resetAll(),

  /** Add a new "New tab" at the end of the tab strip and activate it. */
  addNewTab: (workspaceId: string, options?: { reveal?: boolean }) => {
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const next = addNewTabState(currentTabState(layout));
    store.setLayout(workspaceId, {
      workspaceTabs: next.tabs,
      activeWorkspaceTabId: next.activeTabId,
      ...(options?.reveal !== false ? { panelMode: revealedMode(layout.panelMode) } : {}),
    });
    return next.tabId;
  },

  /** Focus an existing tab by ID. */
  selectWorkspaceTab: (workspaceId: string, tabId: string) => {
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    if (tabId === DEFAULT_NEW_TAB_ID && layout.workspaceTabs.length === 0) return;
    if (!layout.workspaceTabs.some((t) => t.id === tabId)) return;
    store.setLayout(workspaceId, { activeWorkspaceTabId: tabId });
  },

  /** Close a tab, tearing down native resources (webview / initial command). */
  closeWorkspaceTab: (workspaceId: string, tabId: string) => {
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const next = closeTabState(currentTabState(layout), tabId);
    if (!next.closedTab) return;
    disposeTabResources(next.closedTab);
    store.setLayout(workspaceId, {
      workspaceTabs: next.tabs,
      activeWorkspaceTabId: next.activeTabId,
    });
  },

  /** Reorder workspace tabs by `(draggedId, targetId)` against the full list (preserves hidden tabs). */
  reorderWorkspaceTabs: (workspaceId: string, draggedId: string, targetId: string) => {
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const nextTabs = reorderTabState(layout.workspaceTabs, draggedId, targetId);
    if (nextTabs) {
      store.setLayout(workspaceId, { workspaceTabs: nextTabs });
    }
  },

  /** Runtime- and compile-time-safe updater for a specific tab kind. */
  updateWorkspaceTab: <K extends WorkspaceTab["kind"]>(
    workspaceId: string,
    tabId: string,
    kind: K,
    updater: (tab: Extract<WorkspaceTab, { kind: K }>) => Extract<WorkspaceTab, { kind: K }>
  ) => {
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const nextTabs = updateTabState(layout.workspaceTabs, tabId, kind, updater);
    if (nextTabs) {
      store.setLayout(workspaceId, { workspaceTabs: nextTabs });
    }
  },

  /** Open a new terminal tab (always creates a fresh PTY instance). */
  openTerminalTab: (
    workspaceId: string,
    options?: {
      title?: string;
      initialCommand?: string;
      replaceTabId?: string;
      reveal?: boolean;
    }
  ) => {
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const title = options?.title ?? `Terminal ${layout.nextTerminalNum}`;
    const next = openTerminalTabState(currentTabState(layout), title, options?.replaceTabId);
    if (options?.initialCommand) {
      setTerminalInitialCommand(next.tabId, options.initialCommand);
    }
    store.setLayout(workspaceId, {
      workspaceTabs: next.tabs,
      activeWorkspaceTabId: next.activeTabId,
      nextTerminalNum: layout.nextTerminalNum + 1,
      ...(options?.reveal !== false ? { panelMode: revealedMode(layout.panelMode) } : {}),
    });
    return next.tabId;
  },

  /** Open a browser tab (local: multi-instance; cloud: singleton preview). */
  openBrowserTab: (
    workspaceId: string,
    url = "",
    options?: {
      background?: boolean;
      replaceTabId?: string;
      reveal?: boolean;
      cloud?: boolean;
    }
  ) => {
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const next = openBrowserTabState(currentTabState(layout), workspaceId, url, options);
    const shouldReveal = !options?.background && options?.reveal !== false;
    store.setLayout(workspaceId, {
      workspaceTabs: next.tabs,
      activeWorkspaceTabId: next.activeTabId,
      ...(shouldReveal ? { panelMode: revealedMode(layout.panelMode) } : {}),
    });
    return next.tabId;
  },

  /** Open a dedicated single-file viewer tab (deduplicates if already open). */
  openFileTab: (
    workspaceId: string,
    rawPath: string,
    options?: { replaceTabId?: string; reveal?: boolean }
  ) => {
    const normalizedPath = normalizeWorkspaceRelativePath(rawPath);
    if (!normalizedPath) return null;

    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const next = openFileTabState(currentTabState(layout), normalizedPath, options?.replaceTabId);
    store.setLayout(workspaceId, {
      workspaceTabs: next.tabs,
      activeWorkspaceTabId: next.activeTabId,
      selectedFilePath: normalizedPath,
      ...(options?.reveal !== false ? { panelMode: revealedMode(layout.panelMode) } : {}),
    });
    return next.tabId;
  },

  /** Open a tool tab (singleton tools focus existing; terminal/local browser open or focus). */
  openToolTab: (
    workspaceId: string,
    kind: ContentTab,
    options?: { reveal?: boolean; forceNew?: boolean; replaceTabId?: string; cloud?: boolean }
  ) => {
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const next = openToolTabState(currentTabState(layout), workspaceId, kind, {
      forceNew: options?.forceNew,
      replaceTabId: options?.replaceTabId,
      nextTerminalNum: layout.nextTerminalNum,
      cloud: options?.cloud,
    });
    store.setLayout(workspaceId, {
      workspaceTabs: next.tabs,
      activeWorkspaceTabId: next.activeTabId,
      ...(next.consumedTerminalNum ? { nextTerminalNum: layout.nextTerminalNum + 1 } : {}),
      ...(options?.reveal !== false ? { panelMode: revealedMode(layout.panelMode) } : {}),
    });
    return next.tabId;
  },

  /** Background tab selection — does not reveal a hidden workspace panel. */
  setActiveContentTab: (workspaceId: string, tab: ContentTab) => {
    workspaceLayoutActions.openToolTab(workspaceId, tab, { reveal: false });
  },

  /** Explicit tool navigation — reveals the workspace panel if hidden. */
  openContentTab: (workspaceId: string, tab: ContentTab, options?: { cloud?: boolean }) => {
    workspaceLayoutActions.openToolTab(workspaceId, tab, { reveal: true, cloud: options?.cloud });
  },

  /** Reveal a file in the Files explorer tree tab. */
  revealFileInTree: (workspaceId: string, rawPath: string) => {
    const normalizedPath = normalizeWorkspaceRelativePath(rawPath);
    if (!normalizedPath) return;

    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const next = openToolTabState(currentTabState(layout), workspaceId, "files", {
      nextTerminalNum: layout.nextTerminalNum,
    });
    store.setLayout(workspaceId, {
      workspaceTabs: next.tabs,
      activeWorkspaceTabId: next.activeTabId,
      selectedFilePath: normalizedPath,
      panelMode: revealedMode(layout.panelMode),
      pendingFileNavigation: {
        requestId: crypto.randomUUID(),
        path: normalizedPath,
        target: "files",
      },
    });
  },

  /** Open a file from chat or resource cards in either Changes or a dedicated File tab. */
  openFileInContent: (workspaceId: string, path: string, target: FileNavigationTarget) => {
    const normalizedPath = normalizeWorkspaceRelativePath(path);
    if (!normalizedPath) return;

    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const next =
      target === "changes"
        ? openToolTabState(currentTabState(layout), workspaceId, "changes", {
            nextTerminalNum: layout.nextTerminalNum,
          })
        : openFileTabState(currentTabState(layout), normalizedPath);

    store.setLayout(workspaceId, {
      workspaceTabs: next.tabs,
      activeWorkspaceTabId: next.activeTabId,
      selectedFilePath: normalizedPath,
      panelMode: revealedMode(layout.panelMode),
      pendingFileNavigation: {
        requestId: crypto.randomUUID(),
        path: normalizedPath,
        target,
      },
    });
  },
};
