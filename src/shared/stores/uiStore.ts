/**
 * UI Store
 * Global state management for UI-related state (modals, panels, etc.)
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

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
        set({ showNewWorkspaceModal: true }, false, "ui/openNewWorkspaceModal"),

      closeNewWorkspaceModal: () =>
        set({ showNewWorkspaceModal: false }, false, "ui/closeNewWorkspaceModal"),

      openSystemPromptModal: () =>
        set({ showSystemPromptModal: true }, false, "ui/openSystemPromptModal"),

      closeSystemPromptModal: () =>
        set({ showSystemPromptModal: false }, false, "ui/closeSystemPromptModal"),

      openSettingsModal: () => set({ showSettingsModal: true }, false, "ui/openSettingsModal"),

      closeSettingsModal: () => set({ showSettingsModal: false }, false, "ui/closeSettingsModal"),

      closeAllModals: () =>
        set(
          {
            showNewWorkspaceModal: false,
            showSystemPromptModal: false,
            showSettingsModal: false,
          },
          false,
          "ui/closeAllModals"
        ),
    }),
    {
      name: "ui-store",
      enabled: process.env.NODE_ENV === "development",
    }
  )
);

/**
 * Stable Actions - Call from anywhere without causing re-renders
 *
 * Use these when:
 * - Calling from event handlers or callbacks
 * - Calling from Tauri event listeners
 * - Calling from keyboard shortcuts
 * - You don't need to subscribe to state changes
 *
 * Example:
 *   // Instead of: const { openSettingsModal } = useUIStore()
 *   uiActions.openSettingsModal()
 */
export const uiActions = {
  openNewWorkspaceModal: () => useUIStore.getState().openNewWorkspaceModal(),
  closeNewWorkspaceModal: () => useUIStore.getState().closeNewWorkspaceModal(),
  openSystemPromptModal: () => useUIStore.getState().openSystemPromptModal(),
  closeSystemPromptModal: () => useUIStore.getState().closeSystemPromptModal(),
  openSettingsModal: () => useUIStore.getState().openSettingsModal(),
  closeSettingsModal: () => useUIStore.getState().closeSettingsModal(),
  closeAllModals: () => useUIStore.getState().closeAllModals(),
};
