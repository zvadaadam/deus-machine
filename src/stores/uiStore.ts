/**
 * UI Store
 * Global state management for UI-related state (modals, panels, etc.)
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface DiffModalState {
  file: string;
  diff: string;
}

interface UIState {
  // Modals
  showNewWorkspaceModal: boolean;
  showSystemPromptModal: boolean;
  diffModal: DiffModalState | null;

  // Sidebar
  collapsedRepos: Set<string>;

  // Actions - Modals
  openNewWorkspaceModal: () => void;
  closeNewWorkspaceModal: () => void;
  openSystemPromptModal: () => void;
  closeSystemPromptModal: () => void;
  openDiffModal: (file: string, diff: string) => void;
  closeDiffModal: () => void;
  closeAllModals: () => void;

  // Actions - Sidebar
  toggleRepoCollapse: (repoId: string) => void;
  setRepoCollapsed: (repoId: string, collapsed: boolean) => void;
}

export const useUIStore = create<UIState>()(
  devtools(
    (set) => ({
      // Initial state
      showNewWorkspaceModal: false,
      showSystemPromptModal: false,
      diffModal: null,
      collapsedRepos: new Set<string>(),

      // Modal actions
      openNewWorkspaceModal: () =>
        set(
          { showNewWorkspaceModal: true },
          false,
          'ui/openNewWorkspaceModal'
        ),

      closeNewWorkspaceModal: () =>
        set(
          { showNewWorkspaceModal: false },
          false,
          'ui/closeNewWorkspaceModal'
        ),

      openSystemPromptModal: () =>
        set(
          { showSystemPromptModal: true },
          false,
          'ui/openSystemPromptModal'
        ),

      closeSystemPromptModal: () =>
        set(
          { showSystemPromptModal: false },
          false,
          'ui/closeSystemPromptModal'
        ),

      openDiffModal: (file, diff) =>
        set(
          { diffModal: { file, diff } },
          false,
          'ui/openDiffModal'
        ),

      closeDiffModal: () =>
        set(
          { diffModal: null },
          false,
          'ui/closeDiffModal'
        ),

      closeAllModals: () =>
        set(
          {
            showNewWorkspaceModal: false,
            showSystemPromptModal: false,
            diffModal: null,
          },
          false,
          'ui/closeAllModals'
        ),

      // Sidebar actions
      toggleRepoCollapse: (repoId) =>
        set(
          (state) => {
            const newCollapsed = new Set(state.collapsedRepos);
            if (newCollapsed.has(repoId)) {
              newCollapsed.delete(repoId);
            } else {
              newCollapsed.add(repoId);
            }
            return { collapsedRepos: newCollapsed };
          },
          false,
          'ui/toggleRepoCollapse'
        ),

      setRepoCollapsed: (repoId, collapsed) =>
        set(
          (state) => {
            const newCollapsed = new Set(state.collapsedRepos);
            if (collapsed) {
              newCollapsed.add(repoId);
            } else {
              newCollapsed.delete(repoId);
            }
            return { collapsedRepos: newCollapsed };
          },
          false,
          'ui/setRepoCollapsed'
        ),
    }),
    {
      name: 'ui-store',
      enabled: process.env.NODE_ENV === 'development',
    }
  )
);
