/** Per-workspace view, tab and file state. Live terminal processes are never persisted. */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { PersistedBrowserTab } from "@/features/browser/types";
import { normalizeWorkspaceRelativePath } from "@/features/workspace/lib/normalizeWorkspaceRelativePath";

export type ContentTab =
  | "changes"
  | "files"
  | "config"
  | "terminal"
  | "browser"
  | "simulator"
  | "apps";

export type WorkspacePanelMode = "split" | "chat" | "content";

export interface PersistedTerminalTab {
  id: string;
  title: string;
}

export type FileNavigationTarget = "files" | "changes";

export interface PendingFileNavigation {
  requestId: string;
  path: string;
  target: FileNavigationTarget;
}

interface WorkspaceLayoutState {
  activeContentTab: ContentTab;
  selectedFilePath: string | null;
  pendingFileNavigation: PendingFileNavigation | null;
  browserTabs: PersistedBrowserTab[]; // Persisted browser tab URLs/titles
  activeBrowserTabId: string | null; // Which browser tab was last active
  panelMode: WorkspacePanelMode;
  fileTreePinned: boolean; // true = expanded file tree panel, false = minimap strip + hover
  chatTabSessionIds: string[]; // Ordered session IDs for open chat tabs
  activeChatTabSessionId: string | null; // Which chat tab is active
  pendingTerminalCommand: string | null; // Command to auto-run in a new terminal tab (e.g. "claude login")
  simulatorUdid: string | null; // Last-used simulator UDID for this workspace
  terminalTabs: PersistedTerminalTab[]; // Per-workspace terminal tab metadata
  activeTerminalTabId: string | null; // Which terminal tab is active
  nextTerminalNum: number; // Counter for "Terminal N" naming
}

interface WorkspaceLayoutStore {
  layouts: Record<string, WorkspaceLayoutState>;

  getLayout: (workspaceId: string) => WorkspaceLayoutState;
  setLayout: (workspaceId: string, layout: Partial<WorkspaceLayoutState>) => void;

  setActiveContentTab: (workspaceId: string, tab: ContentTab) => void;
  setSelectedFilePath: (workspaceId: string, path: string | null) => void;
  setPendingFileNavigation: (workspaceId: string, navigation: PendingFileNavigation | null) => void;
  setPanelMode: (workspaceId: string, mode: WorkspacePanelMode) => void;
  setPendingTerminalCommand: (workspaceId: string, command: string | null) => void;
  setSimulatorUdid: (workspaceId: string, udid: string | null) => void;
  setChatTabState: (
    workspaceId: string,
    sessionIds: string[],
    activeSessionId: string | null
  ) => void;
  setTerminalTabState: (
    workspaceId: string,
    tabs: PersistedTerminalTab[],
    activeTabId: string | null,
    nextNum: number
  ) => void;

  clearWorkspaceLayout: (workspaceId: string) => void;
  resetAll: () => void;
}

export const defaultLayout: WorkspaceLayoutState = {
  activeContentTab: "changes",
  selectedFilePath: null,
  pendingFileNavigation: null,
  browserTabs: [],
  activeBrowserTabId: null,
  panelMode: "split",
  fileTreePinned: true,
  chatTabSessionIds: [],
  activeChatTabSessionId: null,
  pendingTerminalCommand: null,
  simulatorUdid: null,
  terminalTabs: [],
  activeTerminalTabId: null,
  nextTerminalNum: 1,
};

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

        setActiveContentTab: (workspaceId, tab) =>
          get().setLayout(workspaceId, { activeContentTab: tab }),
        setSelectedFilePath: (workspaceId, path) =>
          get().setLayout(workspaceId, { selectedFilePath: path }),
        setPendingFileNavigation: (workspaceId, navigation) =>
          get().setLayout(workspaceId, { pendingFileNavigation: navigation }),
        setPanelMode: (workspaceId, panelMode) => get().setLayout(workspaceId, { panelMode }),
        setChatTabState: (workspaceId, sessionIds, activeSessionId) =>
          get().setLayout(workspaceId, {
            chatTabSessionIds: sessionIds,
            activeChatTabSessionId: activeSessionId,
          }),
        setTerminalTabState: (workspaceId, tabs, activeTabId, nextNum) =>
          get().setLayout(workspaceId, {
            terminalTabs: tabs,
            activeTerminalTabId: activeTabId,
            nextTerminalNum: nextNum,
          }),
        setPendingTerminalCommand: (workspaceId, command) =>
          get().setLayout(workspaceId, { pendingTerminalCommand: command }),
        setSimulatorUdid: (workspaceId, udid) =>
          get().setLayout(workspaceId, { simulatorUdid: udid }),

        clearWorkspaceLayout: (workspaceId) =>
          set(
            (state) => {
              const { [workspaceId]: _removed, ...remaining } = state.layouts;
              return { layouts: remaining };
            },
            false,
            "workspaceLayout/clearWorkspaceLayout"
          ),

        resetAll: () => set({ layouts: {} }, false, "workspaceLayout/resetAll"),
      }),
      {
        name: "workspace-layout-store",
        version: 11,
        partialize: (state) => ({
          ...state,
          layouts: Object.fromEntries(
            Object.entries(state.layouts).map(([id, layout]) => [
              id,
              {
                ...layout,
                pendingFileNavigation: null,
                pendingTerminalCommand: null,
                terminalTabs: [],
                activeTerminalTabId: null,
                nextTerminalNum: 1,
              },
            ])
          ),
        }),
        // Pre-launch: obsolete layout preferences fall back to defaults; history lives in the DB.
        migrate: () => ({ layouts: {} }) as unknown as WorkspaceLayoutStore,
      }
    ),
    {
      name: "workspace-layout-store",
      enabled: import.meta.env.DEV,
    }
  )
);

/**
 * Stable Actions - Call from anywhere without causing re-renders
 */
export const workspaceLayoutActions = {
  getLayout: (workspaceId: string) => useWorkspaceLayoutStore.getState().getLayout(workspaceId),
  setLayout: (workspaceId: string, layout: Partial<WorkspaceLayoutState>) =>
    useWorkspaceLayoutStore.getState().setLayout(workspaceId, layout),
  setActiveContentTab: (workspaceId: string, tab: ContentTab) =>
    useWorkspaceLayoutStore.getState().setActiveContentTab(workspaceId, tab),
  setSelectedFilePath: (workspaceId: string, path: string | null) =>
    useWorkspaceLayoutStore.getState().setSelectedFilePath(workspaceId, path),
  setPendingFileNavigation: (workspaceId: string, navigation: PendingFileNavigation | null) =>
    useWorkspaceLayoutStore.getState().setPendingFileNavigation(workspaceId, navigation),
  setPanelMode: (workspaceId: string, mode: WorkspacePanelMode) =>
    useWorkspaceLayoutStore.getState().setPanelMode(workspaceId, mode),
  // Explicit navigation reveals the tool. Background tab updates do not change the view.
  openContentTab: (workspaceId: string, tab: ContentTab) => {
    const store = useWorkspaceLayoutStore.getState();
    store.setLayout(workspaceId, {
      activeContentTab: tab,
      panelMode: store.getLayout(workspaceId).panelMode === "content" ? "content" : "split",
    });
  },
  setChatTabState: (workspaceId: string, sessionIds: string[], activeSessionId: string | null) =>
    useWorkspaceLayoutStore.getState().setChatTabState(workspaceId, sessionIds, activeSessionId),
  setTerminalTabState: (
    workspaceId: string,
    tabs: PersistedTerminalTab[],
    activeTabId: string | null,
    nextNum: number
  ) =>
    useWorkspaceLayoutStore.getState().setTerminalTabState(workspaceId, tabs, activeTabId, nextNum),
  setPendingTerminalCommand: (workspaceId: string, command: string | null) =>
    useWorkspaceLayoutStore.getState().setPendingTerminalCommand(workspaceId, command),
  setSimulatorUdid: (workspaceId: string, udid: string | null) =>
    useWorkspaceLayoutStore.getState().setSimulatorUdid(workspaceId, udid),
  clearWorkspaceLayout: (workspaceId: string) =>
    useWorkspaceLayoutStore.getState().clearWorkspaceLayout(workspaceId),
  resetAll: () => useWorkspaceLayoutStore.getState().resetAll(),
  openFileInContent: (workspaceId: string, path: string, target: FileNavigationTarget) => {
    const normalizedPath = normalizeWorkspaceRelativePath(path);
    if (!normalizedPath) return;

    useWorkspaceLayoutStore.getState().setLayout(workspaceId, {
      activeContentTab: target,
      selectedFilePath: normalizedPath,
      panelMode:
        workspaceLayoutActions.getLayout(workspaceId).panelMode === "content" ? "content" : "split",
      pendingFileNavigation: {
        requestId: crypto.randomUUID(),
        path: normalizedPath,
        target,
      },
    });
  },
};
