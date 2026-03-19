/**
 * UI Store
 * Global state management for UI-related state (modals, panels, views)
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { SettingsSection } from "@shared/types/settings";

interface UIState {
  // Modals
  showNewWorkspaceModal: boolean;
  showSystemPromptModal: boolean;

  // Command palette
  commandPaletteOpen: boolean;

  // Settings view (full-page, not a modal)
  settingsOpen: boolean;
  activeSettingsSection: SettingsSection;

  // Actions - Modals
  openNewWorkspaceModal: () => void;
  closeNewWorkspaceModal: () => void;
  openSystemPromptModal: () => void;
  closeSystemPromptModal: () => void;

  // Actions - Command palette
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;

  // Actions - Settings view
  openSettings: () => void;
  closeSettings: () => void;
  setActiveSettingsSection: (section: SettingsSection) => void;

  closeAllModals: () => void;
}

export const useUIStore = create<UIState>()(
  devtools(
    (set, get) => ({
      // Initial state
      showNewWorkspaceModal: false,
      showSystemPromptModal: false,
      commandPaletteOpen: false,
      settingsOpen: false,
      activeSettingsSection: "general" as SettingsSection,

      // Modal actions
      openNewWorkspaceModal: () =>
        set({ showNewWorkspaceModal: true }, false, "ui/openNewWorkspaceModal"),

      closeNewWorkspaceModal: () =>
        set({ showNewWorkspaceModal: false }, false, "ui/closeNewWorkspaceModal"),

      openSystemPromptModal: () =>
        set({ showSystemPromptModal: true }, false, "ui/openSystemPromptModal"),

      closeSystemPromptModal: () =>
        set({ showSystemPromptModal: false }, false, "ui/closeSystemPromptModal"),

      // Command palette actions
      openCommandPalette: () => set({ commandPaletteOpen: true }, false, "ui/openCommandPalette"),

      closeCommandPalette: () =>
        set({ commandPaletteOpen: false }, false, "ui/closeCommandPalette"),

      toggleCommandPalette: () =>
        set(
          (state) => ({ commandPaletteOpen: !state.commandPaletteOpen }),
          false,
          "ui/toggleCommandPalette"
        ),

      // Settings view actions
      openSettings: () => set({ settingsOpen: true }, false, "ui/openSettings"),

      closeSettings: () => set({ settingsOpen: false }, false, "ui/closeSettings"),

      setActiveSettingsSection: (section) =>
        set({ activeSettingsSection: section }, false, "ui/setActiveSettingsSection"),

      closeAllModals: () =>
        set(
          {
            showNewWorkspaceModal: false,
            showSystemPromptModal: false,
            commandPaletteOpen: false,
            settingsOpen: false,
          },
          false,
          "ui/closeAllModals"
        ),
    }),
    {
      name: "ui-store",
      enabled: import.meta.env.DEV,
    }
  )
);

/**
 * Stable Actions - Call from anywhere without causing re-renders
 *
 * Use these when:
 * - Calling from event handlers or callbacks
 * - Calling from IPC event listeners
 * - Calling from keyboard shortcuts
 * - You don't need to subscribe to state changes
 */
export const uiActions = {
  openNewWorkspaceModal: () => useUIStore.getState().openNewWorkspaceModal(),
  closeNewWorkspaceModal: () => useUIStore.getState().closeNewWorkspaceModal(),
  openSystemPromptModal: () => useUIStore.getState().openSystemPromptModal(),
  closeSystemPromptModal: () => useUIStore.getState().closeSystemPromptModal(),
  openSettings: () => useUIStore.getState().openSettings(),
  closeSettings: () => useUIStore.getState().closeSettings(),
  openCommandPalette: () => useUIStore.getState().openCommandPalette(),
  closeCommandPalette: () => useUIStore.getState().closeCommandPalette(),
  toggleCommandPalette: () => useUIStore.getState().toggleCommandPalette(),
  setActiveSettingsSection: (section: SettingsSection) =>
    useUIStore.getState().setActiveSettingsSection(section),
  closeAllModals: () => useUIStore.getState().closeAllModals(),
};
