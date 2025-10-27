/**
 * UI Store
 * Global state management for UI-related state (modals, panels, etc.)
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface UIState {
  // Modals
  showNewWorkspaceModal: boolean;
  showSystemPromptModal: boolean;
  showSettingsModal: boolean;

  // Actions - Modals
  openNewWorkspaceModal: () => void;
  closeNewWorkspaceModal: () => void;
  openSystemPromptModal: () => void;
  closeSystemPromptModal: () => void;
  openSettingsModal: () => void;
  closeSettingsModal: () => void;
  closeAllModals: () => void;
}

export const useUIStore = create<UIState>()(
  devtools(
    (set) => ({
      // Initial state
      showNewWorkspaceModal: false,
      showSystemPromptModal: false,
      showSettingsModal: false,

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

      closeAllModals: () =>
        set(
          {
            showNewWorkspaceModal: false,
            showSystemPromptModal: false,
            showSettingsModal: false,
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
