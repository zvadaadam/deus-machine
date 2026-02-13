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
 *     activeRightTab: 'changes' | 'files'  // Code panel tab
 *     activeRightSideTab: 'code' | 'config' | 'terminal' | 'design' | 'browser' // Sidecar panel
 *     selectedFile: { path: string, source: 'changes' | 'files' } | null
 *     sidebarCollapsed: boolean            // Left sidebar state
 *   }
 * }
 */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { PersistedBrowserTab } from "@/features/browser/types";

export type RightPanelTab = "changes" | "files";
export type RightSideTab = "code" | "config" | "terminal" | "design" | "browser";

export interface SelectedFile {
  path: string;
  source: "changes" | "files";
}

interface WorkspaceLayoutState {
  rightPanelExpanded: boolean;
  activeRightTab: RightPanelTab;
  activeRightSideTab: RightSideTab;
  selectedFile: SelectedFile | null;
  sidebarCollapsed: boolean;
  rightPanelWidth: number | null; // User-set width for code panel, null = auto (50/50 flex split)
  rightPanelWidthBrowser: number | null; // User-set width for browser panel
  browserTabs: PersistedBrowserTab[]; // Persisted browser tab URLs/titles
  activeBrowserTabId: string | null; // Which browser tab was last active
  chatPanelCollapsed: boolean;
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
  rightPanelExpanded: false,
  activeRightTab: "changes",
  activeRightSideTab: "code",
  selectedFile: null,
  sidebarCollapsed: false,
  rightPanelWidth: null,
  rightPanelWidthBrowser: null,
  browserTabs: [],
  activeBrowserTabId: null,
  chatPanelCollapsed: false,
};

type PersistedLayoutV1 = Partial<WorkspaceLayoutState> & {
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
        version: 5,
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

              // v4: Add browser tab persistence fields and chat panel state
              if (version < 4) {
                (nextLayout as Record<string, unknown>).browserTabs =
                  (layout as Record<string, unknown>).browserTabs ?? [];
                (nextLayout as Record<string, unknown>).activeBrowserTabId =
                  (layout as Record<string, unknown>).activeBrowserTabId ?? null;
                nextLayout.chatPanelCollapsed = false;
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
  setRightPanelExpanded: (workspaceId: string, expanded: boolean) =>
    useWorkspaceLayoutStore.getState().setRightPanelExpanded(workspaceId, expanded),
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
  clearWorkspaceLayout: (workspaceId: string) =>
    useWorkspaceLayoutStore.getState().clearWorkspaceLayout(workspaceId),
  resetAll: () => useWorkspaceLayoutStore.getState().resetAll(),
};
