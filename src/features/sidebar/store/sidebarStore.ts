import { create } from 'zustand';

interface SidebarState {
  // Sidebar-specific state
  collapsedRepos: Set<string>;
  toggleRepoCollapse: (repoId: string) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
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
}));
