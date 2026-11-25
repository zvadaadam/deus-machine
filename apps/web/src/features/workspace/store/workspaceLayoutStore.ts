/** Per-workspace view, browser-style tabs, and file state. Live terminal processes are never persisted. */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { isBlankUrl } from "@/features/browser/types";
import { webviewManager } from "@/features/browser/webview-manager";
import {
  clearTerminalInitialCommand,
  setTerminalInitialCommand,
} from "@/features/terminal/store/terminalTaskStore";
import { normalizeWorkspaceRelativePath } from "@/features/workspace/lib/normalizeWorkspaceRelativePath";
import {
  DEFAULT_NEW_TAB,
  DEFAULT_NEW_TAB_ID,
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

function stripEphemeralLayouts(
  layouts: Record<string, WorkspaceLayoutState>
): Record<string, WorkspaceLayoutState> {
  return Object.fromEntries(
    Object.entries(layouts).map(([id, layout]) => {
      const persistedTabs = layout.workspaceTabs.filter(
        (tab) =>
          tab.kind !== "terminal" && !(tab.kind === "browser" && !tab.cloud && isBlankUrl(tab.url))
      );
      return [
        id,
        {
          ...layout,
          workspaceTabs: persistedTabs,
          activeWorkspaceTabId: persistedTabs.some((tab) => tab.id === layout.activeWorkspaceTabId)
            ? layout.activeWorkspaceTabId
            : (persistedTabs[0]?.id ?? null),
          pendingFileNavigation: null,
          nextTerminalNum: 1,
        },
      ];
    })
  );
}

/** Resolve concrete tabs + active tab for rendering (falls back to virtual New Tab when empty). */
export function resolveWorkspaceTabs(
  layout: Pick<WorkspaceLayoutState, "workspaceTabs" | "activeWorkspaceTabId">
): {
  tabs: WorkspaceTab[];
  activeTabId: string;
  activeTab: WorkspaceTab;
} {
  const tabs = Array.isArray(layout.workspaceTabs) ? layout.workspaceTabs : [];
  if (tabs.length === 0) {
    return {
      tabs: [DEFAULT_NEW_TAB],
      activeTabId: DEFAULT_NEW_TAB_ID,
      activeTab: DEFAULT_NEW_TAB,
    };
  }
  const active =
    (layout.activeWorkspaceTabId
      ? tabs.find((t) => t.id === layout.activeWorkspaceTabId)
      : undefined) ?? tabs[0];
  return {
    tabs,
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
        partialize: (state) => ({ layouts: stripEphemeralLayouts(state.layouts) }),
        // Pre-launch: obsolete layout preferences fall back to defaults; history lives in the DB.
        migrate: () => ({ layouts: {} }),
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
  closeWorkspaceTab: (
    workspaceId: string,
    tabId: string,
    options?: { nextActiveTabId?: string }
  ) => {
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.getLayout(workspaceId);
    const next = closeTabState(currentTabState(layout), tabId, options?.nextActiveTabId);
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
