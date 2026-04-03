/**
 * Workspace Layout Store
 *
 * Per-workspace layout state persistence for content panel, files, and browser.
 * Each workspace remembers its own layout configuration independently.
 *
 * State Structure:
 * {
 *   [workspaceId]: {
 *     activeContentTab: 'changes' | 'files' | 'config' | 'terminal' | ...
 *     selectedFilePath: string | null
 *     sidebarCollapsed: boolean
 *     chatPanelCollapsed: boolean
 *     contentPanelCollapsed: boolean
 *   }
 * }
 */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { PersistedBrowserTab } from "@/features/browser/types";

export type ContentTab =
  | "changes"
  | "files"
  | "config"
  | "terminal"
  | "design"
  | "browser"
  | "simulator";

export interface PersistedTerminalTab {
  id: string;
  title: string;
}

interface WorkspaceLayoutState {
  activeContentTab: ContentTab;
  selectedFilePath: string | null;
  sidebarCollapsed: boolean;
  browserTabs: PersistedBrowserTab[]; // Persisted browser tab URLs/titles
  activeBrowserTabId: string | null; // Which browser tab was last active
  chatPanelCollapsed: boolean;
  contentPanelCollapsed: boolean;
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
  setSidebarCollapsed: (workspaceId: string, collapsed: boolean) => void;
  setChatPanelCollapsed: (workspaceId: string, collapsed: boolean) => void;
  setContentPanelCollapsed: (workspaceId: string, collapsed: boolean) => void;
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
  sidebarCollapsed: false,
  browserTabs: [],
  activeBrowserTabId: null,
  chatPanelCollapsed: false,
  contentPanelCollapsed: false,
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
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  activeContentTab: tab,
                },
              },
            }),
            false,
            "workspaceLayout/setActiveContentTab"
          ),

        setSelectedFilePath: (workspaceId, path) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  selectedFilePath: path,
                },
              },
            }),
            false,
            "workspaceLayout/setSelectedFilePath"
          ),

        setSidebarCollapsed: (workspaceId, collapsed) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  sidebarCollapsed: collapsed,
                },
              },
            }),
            false,
            "workspaceLayout/setSidebarCollapsed"
          ),

        setChatPanelCollapsed: (workspaceId, collapsed) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  chatPanelCollapsed: collapsed,
                },
              },
            }),
            false,
            "workspaceLayout/setChatPanelCollapsed"
          ),

        setContentPanelCollapsed: (workspaceId, collapsed) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  contentPanelCollapsed: collapsed,
                },
              },
            }),
            false,
            "workspaceLayout/setContentPanelCollapsed"
          ),

        setChatTabState: (workspaceId, sessionIds, activeSessionId) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  chatTabSessionIds: sessionIds,
                  activeChatTabSessionId: activeSessionId,
                },
              },
            }),
            false,
            "workspaceLayout/setChatTabState"
          ),

        setTerminalTabState: (workspaceId, tabs, activeTabId, nextNum) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  terminalTabs: tabs,
                  activeTerminalTabId: activeTabId,
                  nextTerminalNum: nextNum,
                },
              },
            }),
            false,
            "workspaceLayout/setTerminalTabState"
          ),

        setPendingTerminalCommand: (workspaceId, command) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  pendingTerminalCommand: command,
                },
              },
            }),
            false,
            "workspaceLayout/setPendingTerminalCommand"
          ),

        setSimulatorUdid: (workspaceId, udid) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  simulatorUdid: udid,
                },
              },
            }),
            false,
            "workspaceLayout/setSimulatorUdid"
          ),

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
        version: 10,
        partialize: (state) => ({
          ...state,
          layouts: Object.fromEntries(
            Object.entries(state.layouts).map(([id, layout]) => [
              id,
              {
                ...layout,
                pendingTerminalCommand: null,
                terminalTabs: [],
                activeTerminalTabId: null,
                nextTerminalNum: 1,
              },
            ])
          ),
        }),
        // No migration — stale v9 data falls back to defaultLayout
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
  setSidebarCollapsed: (workspaceId: string, collapsed: boolean) =>
    useWorkspaceLayoutStore.getState().setSidebarCollapsed(workspaceId, collapsed),
  setChatPanelCollapsed: (workspaceId: string, collapsed: boolean) =>
    useWorkspaceLayoutStore.getState().setChatPanelCollapsed(workspaceId, collapsed),
  setContentPanelCollapsed: (workspaceId: string, collapsed: boolean) =>
    useWorkspaceLayoutStore.getState().setContentPanelCollapsed(workspaceId, collapsed),
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
};
