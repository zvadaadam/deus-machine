import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SidebarState {
  // Sidebar-specific state
  collapsedRepos: Set<string>;
  toggleRepoCollapse: (repoId: string) => void;

  // Repository ordering
  repositoryOrder: string[];
  setRepositoryOrder: (order: string[]) => void;
  reorderRepositories: <T extends { repo_id: string }>(repos: T[]) => T[];
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

      // NEW: Repository ordering
      repositoryOrder: [],

      setRepositoryOrder: (order) => set({ repositoryOrder: order }),

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
        repositoryOrder: state.repositoryOrder,
      }),
      merge: (persistedState: any, currentState) => ({
        ...currentState,
        collapsedRepos: new Set(persistedState?.collapsedRepos || []),
        repositoryOrder: persistedState?.repositoryOrder || [],
      }),
    }
  )
);

/**
 * Stable Actions - Call from event handlers/effects without causing re-renders.
 * Not reactive: use useSidebarStore selectors for render-time reads.
 */
export const sidebarActions = {
  toggleRepoCollapse: (repoId: string) => useSidebarStore.getState().toggleRepoCollapse(repoId),
  setRepositoryOrder: (order: string[]) => useSidebarStore.getState().setRepositoryOrder(order),
  reorderRepositories: <T extends { repo_id: string }>(repos: T[]) =>
    useSidebarStore.getState().reorderRepositories(repos),
  isRepoCollapsed: (repoId: string) => useSidebarStore.getState().collapsedRepos.has(repoId),
};
