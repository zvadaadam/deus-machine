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
  showSettingsModal: boolean;
  diffModal: DiffModalState | null;

  // Actions - Modals
  openNewWorkspaceModal: () => void;
  closeNewWorkspaceModal: () => void;
  openSystemPromptModal: () => void;
  closeSystemPromptModal: () => void;
  openSettingsModal: () => void;
  closeSettingsModal: () => void;
  openDiffModal: (file: string, diff: string) => void;
  closeDiffModal: () => void;
  closeAllModals: () => void;
}

export const useUIStore = create<UIState>()(
  devtools(
    (set) => ({
      // Initial state
      showNewWorkspaceModal: false,
      showSystemPromptModal: false,
      showSettingsModal: false,
      diffModal: null,

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

      openSettingsModal: () =>
        set(
          { showSettingsModal: true },
          false,
          'ui/openSettingsModal'
        ),

      closeSettingsModal: () =>
        set(
          { showSettingsModal: false },
          false,
          'ui/closeSettingsModal'
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
            showSettingsModal: false,
            diffModal: null,
          },
          false,
          'ui/closeAllModals'
        ),
    }),
    {
      name: 'ui-store',
      enabled: process.env.NODE_ENV === 'development',
    }
  )
);
