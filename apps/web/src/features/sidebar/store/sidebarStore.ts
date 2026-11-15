import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WorkspaceLocation } from "../lib/location";

interface SidebarState {
  // Sidebar-specific state
  collapsedRepos: Set<string>;
  toggleRepoCollapse: (repoId: string) => void;
  expandRepo: (repoId: string) => void;

  // Repos where user expanded the "Show more" stale workspaces
  expandedOldWorkspaces: Set<string>;
  toggleOldWorkspaces: (repoId: string) => void;

  // Repository ordering
  repositoryOrder: string[];
  setRepositoryOrder: (order: string[]) => void;
  reorderRepositories: <T extends { repo_id: string }>(repos: T[]) => T[];

  // Where this window's workspaces run (persisted), and the workspace last
  // selected in each location during this app session (memory only).
  location: WorkspaceLocation;
  setLocation: (location: WorkspaceLocation) => void;
  lastSelectedByLocation: Partial<Record<WorkspaceLocation, string>>;
  rememberSelection: (location: WorkspaceLocation, workspaceId: string) => void;
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set, get) => ({
      // Existing state
      collapsedRepos: new Set(),
      toggleRepoCollapse: (repoId) =>
        set((state) => {
          const newCollapsed = new Set(state.collapsedRepos);
          if (newCollapsed.has(repoId)) {
            newCollapsed.delete(repoId);
          } else {
            newCollapsed.add(repoId);
          }
          return { collapsedRepos: newCollapsed };
        }),
      expandRepo: (repoId) =>
        set((state) => {
          if (!state.collapsedRepos.has(repoId)) return state;
          const newCollapsed = new Set(state.collapsedRepos);
          newCollapsed.delete(repoId);
          return { collapsedRepos: newCollapsed };
        }),

      // Stale workspace expansion (per-repo)
      expandedOldWorkspaces: new Set(),
      toggleOldWorkspaces: (repoId) =>
        set((state) => {
          const next = new Set(state.expandedOldWorkspaces);
          if (next.has(repoId)) {
            next.delete(repoId);
          } else {
            next.add(repoId);
          }
          return { expandedOldWorkspaces: next };
        }),

      location: "local",
      setLocation: (location) => set({ location }),
      lastSelectedByLocation: {},
      rememberSelection: (location, workspaceId) =>
        set((state) =>
          state.lastSelectedByLocation[location] === workspaceId
            ? state
            : {
                lastSelectedByLocation: {
                  ...state.lastSelectedByLocation,
                  [location]: workspaceId,
                },
              }
        ),

      // Repository ordering
      repositoryOrder: [],

      /**
       * Save the order of the repositories in view. The order is shared by every
       * computer opened in this browser, so ids not in view keep their places
       * and the ones in view fill their slots in the new order.
       */
      setRepositoryOrder: (order) =>
        set((state) => {
          const inView = new Set(order);
          const placed = [...order];
          const merged = state.repositoryOrder.map((id) => (inView.has(id) ? placed.shift()! : id));
          return { repositoryOrder: [...merged, ...placed] };
        }),

      /**
       * Reorder repositories based on user preferences
       * Unordered repos appear at the end in their original order
       */
      reorderRepositories: (repos) => {
        const { repositoryOrder } = get();

        // If no custom order, return as-is
        if (repositoryOrder.length === 0) return repos;

        // Create lookup map for O(1) access
        const orderMap = new Map(repositoryOrder.map((id, idx) => [id, idx]));

        return [...repos].sort((a, b) => {
          const indexA = orderMap.get(a.repo_id) ?? Infinity;
          const indexB = orderMap.get(b.repo_id) ?? Infinity;
          return indexA - indexB;
        });
      },
    }),
    {
      name: "sidebar-storage",
      // Serialize Set properly for localStorage
      partialize: (state) => ({
        collapsedRepos: Array.from(state.collapsedRepos),
        expandedOldWorkspaces: Array.from(state.expandedOldWorkspaces),
        repositoryOrder: state.repositoryOrder,
        location: state.location,
      }),
      merge: (persistedState: any, currentState) => ({
        ...currentState,
        collapsedRepos: new Set(persistedState?.collapsedRepos || []),
        expandedOldWorkspaces: new Set(persistedState?.expandedOldWorkspaces || []),
        repositoryOrder: persistedState?.repositoryOrder || [],
        // Added without a version bump: the merge defaults it for older saves.
        location: persistedState?.location === "cloud" ? "cloud" : "local",
      }),
    }
  )
);
