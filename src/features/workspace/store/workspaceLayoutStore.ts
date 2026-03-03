/**
 * Workspace Layout Store
 *
 * Per-workspace layout state persistence for right panel, files, and browser.
 * Each workspace remembers its own layout configuration independently.
 *
 * Key Features:
 * - Workspace-specific state (not shared between workspaces)
 * - LocalStorage persistence (survives app restarts)
 * - Automatic restoration on workspace switch
 *
 * State Structure:
 * {
 *   [workspaceId]: {
 *     activeRightTab: 'changes' | 'files'  // Code panel tab
 *     activeRightSideTab: 'code' | 'config' | 'terminal' | 'notebook' | 'design' | 'browser' | 'simulator' // Sidecar panel
 *     selectedFile: { path: string, source: 'changes' | 'files' } | null
 *     sidebarCollapsed: boolean            // Left sidebar state
 *     chatPanelCollapsed: boolean          // Chat panel collapsed via resizable panels
 *     rightPanelCollapsed: boolean         // Content panel collapsed via resizable panels
 *   }
 * }
 */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { PersistedBrowserTab } from "@/features/browser/types";

export type RightPanelTab = "changes" | "files";
export type RightSideTab = "code" | "config" | "terminal" | "notebook" | "design" | "browser" | "simulator";

export interface SelectedFile {
  path: string;
  source: "changes" | "files";
}

export interface PersistedTerminalTab {
  id: string;
  title: string;
}

interface WorkspaceLayoutState {
  activeRightTab: RightPanelTab;
  activeRightSideTab: RightSideTab;
  selectedFile: SelectedFile | null;
  sidebarCollapsed: boolean;
  browserTabs: PersistedBrowserTab[]; // Persisted browser tab URLs/titles
  activeBrowserTabId: string | null; // Which browser tab was last active
  chatPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  chatTabSessionIds: string[]; // Ordered session IDs for open chat tabs
  activeChatTabSessionId: string | null; // Which chat tab is active
  pendingTerminalCommand: string | null; // Command to auto-run in a new terminal tab (e.g. "claude login")
  simulatorUdid: string | null; // Last-used simulator UDID for this workspace
  terminalTabs: PersistedTerminalTab[]; // Per-workspace terminal tab metadata
  activeTerminalTabId: string | null; // Which terminal tab is active
  nextTerminalNum: number; // Counter for "Terminal N" naming
}

interface WorkspaceLayoutStore {
  // State: Record of workspace ID → layout state
  layouts: Record<string, WorkspaceLayoutState>;

  // Getters
  /**
   * Get layout state for a specific workspace (with defaults if not set)
   */
  getLayout: (workspaceId: string) => WorkspaceLayoutState;

  // Setters - Full state updates
  /**
   * Set complete layout state for a workspace
   */
  setLayout: (workspaceId: string, layout: Partial<WorkspaceLayoutState>) => void;

  // Setters - Individual properties (convenience methods)
  /**
   * Switch active tab in right panel
   */
  setActiveRightTab: (workspaceId: string, tab: RightPanelTab) => void;

  /**
   * Switch active tab in right side panel
   */
  setActiveRightSideTab: (workspaceId: string, tab: RightSideTab) => void;

  /**
   * Select a file to display in the panel
   */
  setSelectedFile: (workspaceId: string, file: SelectedFile | null) => void;

  /**
   * Toggle sidebar collapsed state
   */
  setSidebarCollapsed: (workspaceId: string, collapsed: boolean) => void;

  /**
   * Toggle chat panel collapsed state
   */
  setChatPanelCollapsed: (workspaceId: string, collapsed: boolean) => void;

  /**
   * Toggle right panel collapsed state
   */
  setRightPanelCollapsed: (workspaceId: string, collapsed: boolean) => void;

  /**
   * Set a command to auto-run in a new terminal tab
   */
  setPendingTerminalCommand: (workspaceId: string, command: string | null) => void;

  /**
   * Set the last-used simulator UDID for a workspace
   */
  setSimulatorUdid: (workspaceId: string, udid: string | null) => void;

  /**
   * Persist chat tab order and active tab for a workspace
   */
  setChatTabState: (
    workspaceId: string,
    sessionIds: string[],
    activeSessionId: string | null
  ) => void;

  /**
   * Persist terminal tab order, active tab, and naming counter for a workspace
   */
  setTerminalTabState: (
    workspaceId: string,
    tabs: PersistedTerminalTab[],
    activeTabId: string | null,
    nextNum: number
  ) => void;

  // Utilities
  /**
   * Clear layout state for a specific workspace
   */
  clearWorkspaceLayout: (workspaceId: string) => void;

  /**
   * Reset all layout state (useful for debugging)
   */
  resetAll: () => void;
}

export const defaultLayout: WorkspaceLayoutState = {
  activeRightTab: "changes",
  activeRightSideTab: "code",
  selectedFile: null,
  sidebarCollapsed: false,
  browserTabs: [],
  activeBrowserTabId: null,
  chatPanelCollapsed: false,
  rightPanelCollapsed: false,
  chatTabSessionIds: [],
  activeChatTabSessionId: null,
  pendingTerminalCommand: null,
  simulatorUdid: null,
  terminalTabs: [],
  activeTerminalTabId: null,
  nextTerminalNum: 1,
};

// Legacy fields that may exist in persisted data from older versions.
// Kept here so the migration code compiles without errors.
type PersistedLayoutV1 = Partial<WorkspaceLayoutState> & {
  rightPanelExpanded?: boolean;
  rightPanelWidth?: number | null;
  rightPanelWidthBrowser?: number | null;
};

type PersistedStateV1 = {
  layouts?: Record<string, PersistedLayoutV1>;
};

export const useWorkspaceLayoutStore = create<WorkspaceLayoutStore>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial state
        layouts: {},

        // Getters
        getLayout: (workspaceId) => {
          const { layouts } = get();
          // Merge with defaults so newly-added fields (e.g. browserTabs)
          // are always present even for layouts persisted before they existed.
          return { ...defaultLayout, ...(layouts[workspaceId] ?? {}) };
        },

        // Setters - Full state
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

        // Setters - Individual properties
        setActiveRightTab: (workspaceId, tab) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  activeRightTab: tab,
                },
              },
            }),
            false,
            "workspaceLayout/setActiveRightTab"
          ),

        setActiveRightSideTab: (workspaceId, tab) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  activeRightSideTab: tab,
                },
              },
            }),
            false,
            "workspaceLayout/setActiveRightSideTab"
          ),

        setSelectedFile: (workspaceId, file) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  selectedFile: file,
                },
              },
            }),
            false,
            "workspaceLayout/setSelectedFile"
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

        setRightPanelCollapsed: (workspaceId, collapsed) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  rightPanelCollapsed: collapsed,
                },
              },
            }),
            false,
            "workspaceLayout/setRightPanelCollapsed"
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

        // Utilities
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
        name: "workspace-layout-store", // localStorage key
        version: 9,
        // Strip ephemeral/runtime-only state that must not survive app restarts.
        // pendingTerminalCommand: transient signal consumed by TerminalPanel.
        // terminalTabs/activeTerminalTabId/nextTerminalNum: PTY processes don't
        // survive app restarts, so persisting tab metadata would create zombie
        // tabs with no backing shell process.
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
        migrate: (persistedState: unknown, version: number) => {
          const state: PersistedStateV1 =
            typeof persistedState === "object" && persistedState !== null
              ? (persistedState as PersistedStateV1)
              : {};

          if (state.layouts && typeof state.layouts === "object") {
            const nextLayouts: Record<string, PersistedLayoutV1> = {};
            for (const [key, layout] of Object.entries(state.layouts)) {
              if (!layout || typeof layout !== "object") {
                continue;
              }
              const nextLayout: PersistedLayoutV1 = {
                ...layout,
              };

              if (version < 2) {
                nextLayout.rightPanelWidth =
                  "rightPanelWidth" in layout ? (layout.rightPanelWidth ?? null) : null;
              }

              if (version < 3) {
                nextLayout.rightPanelWidthBrowser =
                  "rightPanelWidthBrowser" in layout
                    ? (layout.rightPanelWidthBrowser ?? null)
                    : null;
              }

              // v4: Add browser tab persistence fields
              if (version < 4) {
                (nextLayout as Record<string, unknown>).browserTabs =
                  (layout as Record<string, unknown>).browserTabs ?? [];
                (nextLayout as Record<string, unknown>).activeBrowserTabId =
                  (layout as Record<string, unknown>).activeBrowserTabId ?? null;
              }

              // v5: Add chat panel collapsed state
              if (version < 5) {
                nextLayout.chatPanelCollapsed = false;
              }

              // v6: Add chat tab persistence fields
              if (version < 6) {
                (nextLayout as Record<string, unknown>).chatTabSessionIds = [];
                (nextLayout as Record<string, unknown>).activeChatTabSessionId = null;
              }

              // v7: Add right panel collapsed state
              if (version < 7) {
                nextLayout.rightPanelCollapsed = false;
              }

              // v8: Add simulator UDID persistence
              if (version < 8) {
                (nextLayout as Record<string, unknown>).simulatorUdid = null;
              }

              // v9: Add terminal tab state (runtime-only, stripped by partialize)
              if (version < 9) {
                (nextLayout as Record<string, unknown>).terminalTabs = [];
                (nextLayout as Record<string, unknown>).activeTerminalTabId = null;
                (nextLayout as Record<string, unknown>).nextTerminalNum = 1;
              }

              nextLayouts[key] = nextLayout;
            }
            return { ...state, layouts: nextLayouts } as WorkspaceLayoutStore;
          }

          return state as WorkspaceLayoutStore;
        },
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
  setActiveRightTab: (workspaceId: string, tab: RightPanelTab) =>
    useWorkspaceLayoutStore.getState().setActiveRightTab(workspaceId, tab),
  setActiveRightSideTab: (workspaceId: string, tab: RightSideTab) =>
    useWorkspaceLayoutStore.getState().setActiveRightSideTab(workspaceId, tab),
  setSelectedFile: (workspaceId: string, file: SelectedFile | null) =>
    useWorkspaceLayoutStore.getState().setSelectedFile(workspaceId, file),
  setSidebarCollapsed: (workspaceId: string, collapsed: boolean) =>
    useWorkspaceLayoutStore.getState().setSidebarCollapsed(workspaceId, collapsed),
  setChatPanelCollapsed: (workspaceId: string, collapsed: boolean) =>
    useWorkspaceLayoutStore.getState().setChatPanelCollapsed(workspaceId, collapsed),
  setRightPanelCollapsed: (workspaceId: string, collapsed: boolean) =>
    useWorkspaceLayoutStore.getState().setRightPanelCollapsed(workspaceId, collapsed),
  setChatTabState: (workspaceId: string, sessionIds: string[], activeSessionId: string | null) =>
    useWorkspaceLayoutStore.getState().setChatTabState(workspaceId, sessionIds, activeSessionId),
  setTerminalTabState: (
    workspaceId: string,
    tabs: PersistedTerminalTab[],
    activeTabId: string | null,
    nextNum: number
  ) => useWorkspaceLayoutStore.getState().setTerminalTabState(workspaceId, tabs, activeTabId, nextNum),
  setPendingTerminalCommand: (workspaceId: string, command: string | null) =>
    useWorkspaceLayoutStore.getState().setPendingTerminalCommand(workspaceId, command),
  setSimulatorUdid: (workspaceId: string, udid: string | null) =>
    useWorkspaceLayoutStore.getState().setSimulatorUdid(workspaceId, udid),
  clearWorkspaceLayout: (workspaceId: string) =>
    useWorkspaceLayoutStore.getState().clearWorkspaceLayout(workspaceId),
  resetAll: () => useWorkspaceLayoutStore.getState().resetAll(),
};
