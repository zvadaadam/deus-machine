/**
 * UI Store
 * Global state management for UI-related state (modals, panels, views)
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { SettingsSection } from "@shared/types/settings";

export type NewWorkspaceMode = "default" | "from-github";

export interface EnvironmentSetupRequest {
  repoId: string;
  location: "local" | "cloud";
  model: string;
}

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
  environmentSettingsTarget: { repoId: string; location: "local" | "cloud" } | null;

  // Automations view (full-page, keeps the app sidebar)
  automationsOpen: boolean;
  /** Deep-link: open straight onto this automation's detail (consumed once). */
  automationsFocusId: string | null;

  /** MainLayout creates a workspace and sends the setup instructions as turn one. */
  pendingEnvSetup: EnvironmentSetupRequest | null;

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
  openEnvironmentSettings: (repoId: string, location: "local" | "cloud") => void;
  closeSettings: () => void;
  setActiveSettingsSection: (section: SettingsSection) => void;
  requestEnvSetup: (request: EnvironmentSetupRequest) => void;
  clearEnvSetupRequest: () => void;

  // Actions - Automations view
  openAutomations: (automationId?: string) => void;
  closeAutomations: () => void;
  clearAutomationsFocus: () => void;

  closeAllModals: () => void;
}

export const useUIStore = create<UIState>()(
  devtools(
    (set) => ({
      // Initial state
      showNewWorkspaceModal: false,
      newWorkspaceMode: "default" as NewWorkspaceMode,
      newWorkspaceDraft: null,
      showSystemPromptModal: false,
      commandPaletteOpen: false,
      settingsOpen: false,
      activeSettingsSection: "general" as SettingsSection,
      environmentSettingsTarget: null,
      automationsOpen: false,
      automationsFocusId: null,
      pendingEnvSetup: null,

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

      openEnvironmentSettings: (repoId, location) =>
        set(
          {
            settingsOpen: true,
            automationsOpen: false,
            activeSettingsSection: "environment",
            environmentSettingsTarget: { repoId, location },
          },
          false,
          "ui/openEnvironmentSettings"
        ),

      closeSettings: () =>
        set({ settingsOpen: false, environmentSettingsTarget: null }, false, "ui/closeSettings"),

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

      requestEnvSetup: (request) =>
        set(
          { pendingEnvSetup: request, settingsOpen: false, environmentSettingsTarget: null },
          false,
          "ui/requestEnvSetup"
        ),

      clearEnvSetupRequest: () => set({ pendingEnvSetup: null }, false, "ui/clearEnvSetupRequest"),

      closeAllModals: () =>
        set(
          {
            showNewWorkspaceModal: false,
            newWorkspaceMode: "default" as NewWorkspaceMode,
            showSystemPromptModal: false,
            commandPaletteOpen: false,
            settingsOpen: false,
            environmentSettingsTarget: null,
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
  openEnvironmentSettings: (repoId: string, location: "local" | "cloud") =>
    useUIStore.getState().openEnvironmentSettings(repoId, location),
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
