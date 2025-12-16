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
 *     rightPanelExpanded: boolean          // Panel in wide mode (file/browser open)
 *     activeRightTab: 'changes' | 'files' | 'browser'  // Which tab is active
 *     selectedFile: { path: string, source: 'changes' | 'files' } | null
 *     sidebarCollapsed: boolean            // Left sidebar state
 *   }
 * }
 */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export type RightPanelTab = "changes" | "files" | "browser";

export interface SelectedFile {
  path: string;
  source: "changes" | "files";
}

interface WorkspaceLayoutState {
  rightPanelExpanded: boolean;
  activeRightTab: RightPanelTab;
  selectedFile: SelectedFile | null;
  sidebarCollapsed: boolean;
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
   * Expand/collapse right panel for a workspace
   */
  setRightPanelExpanded: (workspaceId: string, expanded: boolean) => void;

  /**
   * Switch active tab in right panel
   */
  setActiveRightTab: (workspaceId: string, tab: RightPanelTab) => void;

  /**
   * Select a file to display in the panel
   */
  setSelectedFile: (workspaceId: string, file: SelectedFile | null) => void;

  /**
   * Toggle sidebar collapsed state
   */
  setSidebarCollapsed: (workspaceId: string, collapsed: boolean) => void;

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

const defaultLayout: WorkspaceLayoutState = {
  rightPanelExpanded: false,
  activeRightTab: "changes",
  selectedFile: null,
  sidebarCollapsed: false,
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
          return layouts[workspaceId] || defaultLayout;
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
        setRightPanelExpanded: (workspaceId, expanded) =>
          set(
            (state) => ({
              layouts: {
                ...state.layouts,
                [workspaceId]: {
                  ...(state.layouts[workspaceId] || defaultLayout),
                  rightPanelExpanded: expanded,
                },
              },
            }),
            false,
            "workspaceLayout/setRightPanelExpanded"
          ),

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

        // Utilities
        clearWorkspaceLayout: (workspaceId) =>
          set(
            (state) => {
              const { [workspaceId]: removed, ...remaining } = state.layouts;
              return { layouts: remaining };
            },
            false,
            "workspaceLayout/clearWorkspaceLayout"
          ),

        resetAll: () => set({ layouts: {} }, false, "workspaceLayout/resetAll"),
      }),
      {
        name: "workspace-layout-store", // localStorage key
        version: 1,
      }
    ),
    {
      name: "workspace-layout-store",
      enabled: process.env.NODE_ENV === "development",
    }
  )
);

/**
 * Stable Actions - Call from anywhere without causing re-renders
 */
export const workspaceLayoutActions = {
  getLayout: (workspaceId: string) =>
    useWorkspaceLayoutStore.getState().getLayout(workspaceId),
  setLayout: (workspaceId: string, layout: Partial<WorkspaceLayoutState>) =>
    useWorkspaceLayoutStore.getState().setLayout(workspaceId, layout),
  setRightPanelExpanded: (workspaceId: string, expanded: boolean) =>
    useWorkspaceLayoutStore.getState().setRightPanelExpanded(workspaceId, expanded),
  setActiveRightTab: (workspaceId: string, tab: RightPanelTab) =>
    useWorkspaceLayoutStore.getState().setActiveRightTab(workspaceId, tab),
  setSelectedFile: (workspaceId: string, file: SelectedFile | null) =>
    useWorkspaceLayoutStore.getState().setSelectedFile(workspaceId, file),
  setSidebarCollapsed: (workspaceId: string, collapsed: boolean) =>
    useWorkspaceLayoutStore.getState().setSidebarCollapsed(workspaceId, collapsed),
  clearWorkspaceLayout: (workspaceId: string) =>
    useWorkspaceLayoutStore.getState().clearWorkspaceLayout(workspaceId),
  resetAll: () => useWorkspaceLayoutStore.getState().resetAll(),
};
