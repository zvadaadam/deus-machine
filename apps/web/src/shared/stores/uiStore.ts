/**
 * UI Store
 * Global state management for UI-related state (modals, panels, views)
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { SettingsSection } from "@shared/types/settings";

export type NewWorkspaceMode = "default" | "from-github";

interface UIState {
  // Modals
  showNewWorkspaceModal: boolean;
  newWorkspaceMode: NewWorkspaceMode;
  /** Prefill for the prompt-first workspace modal (consumed via remount key). */
  newWorkspaceDraft: string | null;
  showSystemPromptModal: boolean;

  // Command palette
  commandPaletteOpen: boolean;

  // Settings view (full-page, not a modal)
  settingsOpen: boolean;
  activeSettingsSection: SettingsSection;

  // Automations view (full-page, keeps the app sidebar)
  automationsOpen: boolean;
  /** Deep-link: open straight onto this automation's detail (consumed once). */
  automationsFocusId: string | null;

  /**
   * Pending "set up cloud environment with an agent" request from Settings.
   * MainLayout consumes it: closes settings, creates a cloud workspace on the
   * repo, and sends the onboarding prompt as turn one.
   */
  pendingEnvSetupRepoId: string | null;

  // Actions - Modals
  openNewWorkspaceModal: (mode?: NewWorkspaceMode) => void;
  /** Open the prompt-first modal with a starter prompt (Create with AI). */
  openNewWorkspaceModalWithDraft: (draft: string) => void;
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
  requestEnvSetup: (repoId: string) => void;
  clearEnvSetupRequest: () => void;

  // Actions - Automations view
  openAutomations: (automationId?: string) => void;
  closeAutomations: () => void;
  clearAutomationsFocus: () => void;

  closeAllModals: () => void;
}

export const useUIStore = create<UIState>()(
  devtools(
    (set, get) => ({
      // Initial state
      showNewWorkspaceModal: false,
      newWorkspaceMode: "default" as NewWorkspaceMode,
      newWorkspaceDraft: null,
      showSystemPromptModal: false,
      commandPaletteOpen: false,
      settingsOpen: false,
      activeSettingsSection: "general" as SettingsSection,
      automationsOpen: false,
      automationsFocusId: null,
      pendingEnvSetupRepoId: null,

      // Modal actions
      openNewWorkspaceModal: (mode: NewWorkspaceMode = "default") =>
        set(
          { showNewWorkspaceModal: true, newWorkspaceMode: mode, newWorkspaceDraft: null },
          false,
          "ui/openNewWorkspaceModal"
        ),

      openNewWorkspaceModalWithDraft: (draft: string) =>
        set(
          {
            showNewWorkspaceModal: true,
            newWorkspaceMode: "default" as NewWorkspaceMode,
            newWorkspaceDraft: draft,
            automationsOpen: false,
          },
          false,
          "ui/openNewWorkspaceModalWithDraft"
        ),

      closeNewWorkspaceModal: () =>
        set(
          { showNewWorkspaceModal: false, newWorkspaceMode: "default", newWorkspaceDraft: null },
          false,
          "ui/closeNewWorkspaceModal"
        ),

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

      // Settings view actions — settings and automations are both full-page
      // takeovers, so opening one closes the other.
      openSettings: () =>
        set({ settingsOpen: true, automationsOpen: false }, false, "ui/openSettings"),

      closeSettings: () => set({ settingsOpen: false }, false, "ui/closeSettings"),

      // Automations view actions
      openAutomations: (automationId) =>
        set(
          {
            automationsOpen: true,
            settingsOpen: false,
            automationsFocusId: automationId ?? null,
          },
          false,
          "ui/openAutomations"
        ),

      closeAutomations: () => set({ automationsOpen: false }, false, "ui/closeAutomations"),

      clearAutomationsFocus: () =>
        set({ automationsFocusId: null }, false, "ui/clearAutomationsFocus"),

      setActiveSettingsSection: (section) =>
        set({ activeSettingsSection: section }, false, "ui/setActiveSettingsSection"),

      requestEnvSetup: (repoId) =>
        set({ pendingEnvSetupRepoId: repoId, settingsOpen: false }, false, "ui/requestEnvSetup"),

      clearEnvSetupRequest: () =>
        set({ pendingEnvSetupRepoId: null }, false, "ui/clearEnvSetupRequest"),

      closeAllModals: () =>
        set(
          {
            showNewWorkspaceModal: false,
            newWorkspaceMode: "default" as NewWorkspaceMode,
            showSystemPromptModal: false,
            commandPaletteOpen: false,
            settingsOpen: false,
            automationsOpen: false,
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
  openNewWorkspaceModal: (mode?: NewWorkspaceMode) =>
    useUIStore.getState().openNewWorkspaceModal(mode),
  openNewWorkspaceModalWithDraft: (draft: string) =>
    useUIStore.getState().openNewWorkspaceModalWithDraft(draft),
  closeNewWorkspaceModal: () => useUIStore.getState().closeNewWorkspaceModal(),
  openSystemPromptModal: () => useUIStore.getState().openSystemPromptModal(),
  closeSystemPromptModal: () => useUIStore.getState().closeSystemPromptModal(),
  openSettings: () => useUIStore.getState().openSettings(),
  closeSettings: () => useUIStore.getState().closeSettings(),
  openAutomations: (automationId?: string) => useUIStore.getState().openAutomations(automationId),
  closeAutomations: () => useUIStore.getState().closeAutomations(),
  openCommandPalette: () => useUIStore.getState().openCommandPalette(),
  closeCommandPalette: () => useUIStore.getState().closeCommandPalette(),
  toggleCommandPalette: () => useUIStore.getState().toggleCommandPalette(),
  setActiveSettingsSection: (section: SettingsSection) =>
    useUIStore.getState().setActiveSettingsSection(section),
  closeAllModals: () => useUIStore.getState().closeAllModals(),
};
