/**
 * UI Store
 * Global state management for UI-related state (modals, panels, views)
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { SettingsSection } from "@shared/types/settings";

/** What the Home composer should start with: a project, a draft, or neither. */
export interface NewWorkspaceRequest {
  /** Never reused, so Home can tell a new request from the one it already took. */
  id: number;
  repoId?: string;
  draft?: string;
}
let nextNewWorkspaceRequestId = 1;

export interface EnvironmentSetupRequest {
  repoId: string;
  location: "local" | "cloud";
  model: string;
  /** A cloud setup workspace starts in this organization; null names none. */
  organizationId: string | null;
}

interface UIState {
  /**
   * A workspace is only ever created from Home. Anything that wants one
   * (the sidebar, a project's "+", a starter prompt) asks Home to show up
   * with this in its composer; Home takes it once and clears it.
   */
  newWorkspaceRequest: NewWorkspaceRequest | null;

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

  // Customize view: Apps, Recommended Plugins and Skills (full-page, keeps the app sidebar)
  customizeOpen: boolean;

  /** MainLayout creates a workspace and sends the setup instructions as turn one. */
  pendingEnvSetup: EnvironmentSetupRequest | null;

  /** Leave whatever full page is open and hand Home what to start with. */
  requestNewWorkspace: (request?: { repoId?: string; draft?: string }) => void;
  clearNewWorkspaceRequest: () => void;

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

  // Actions - Customize view
  openCustomize: () => void;
  closeCustomize: () => void;

  closeAllModals: () => void;
}

export const useUIStore = create<UIState>()(
  devtools(
    (set) => ({
      // Initial state
      newWorkspaceRequest: null,
      commandPaletteOpen: false,
      settingsOpen: false,
      activeSettingsSection: "general" as SettingsSection,
      environmentSettingsTarget: null,
      automationsOpen: false,
      automationsFocusId: null,
      customizeOpen: false,
      pendingEnvSetup: null,

      requestNewWorkspace: (request = {}) =>
        set(
          {
            newWorkspaceRequest: { ...request, id: nextNewWorkspaceRequestId++ },
            settingsOpen: false,
            environmentSettingsTarget: null,
            automationsOpen: false,
            customizeOpen: false,
          },
          false,
          "ui/requestNewWorkspace"
        ),

      clearNewWorkspaceRequest: () =>
        set({ newWorkspaceRequest: null }, false, "ui/clearNewWorkspaceRequest"),

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

      // Settings view actions — settings, automations and Customize are all
      // full-page takeovers, so opening one closes the others.
      openSettings: () =>
        set(
          { settingsOpen: true, automationsOpen: false, customizeOpen: false },
          false,
          "ui/openSettings"
        ),

      openEnvironmentSettings: (repoId, location) =>
        set(
          {
            settingsOpen: true,
            automationsOpen: false,
            customizeOpen: false,
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
            customizeOpen: false,
            automationsFocusId: automationId ?? null,
          },
          false,
          "ui/openAutomations"
        ),

      closeAutomations: () => set({ automationsOpen: false }, false, "ui/closeAutomations"),

      clearAutomationsFocus: () =>
        set({ automationsFocusId: null }, false, "ui/clearAutomationsFocus"),

      // Customize view actions
      openCustomize: () =>
        set(
          { customizeOpen: true, settingsOpen: false, automationsOpen: false },
          false,
          "ui/openCustomize"
        ),

      closeCustomize: () => set({ customizeOpen: false }, false, "ui/closeCustomize"),

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
            commandPaletteOpen: false,
            settingsOpen: false,
            environmentSettingsTarget: null,
            automationsOpen: false,
            customizeOpen: false,
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
  requestNewWorkspace: (request?: { repoId?: string; draft?: string }) =>
    useUIStore.getState().requestNewWorkspace(request),
  clearNewWorkspaceRequest: () => useUIStore.getState().clearNewWorkspaceRequest(),
  openSettings: () => useUIStore.getState().openSettings(),
  openEnvironmentSettings: (repoId: string, location: "local" | "cloud") =>
    useUIStore.getState().openEnvironmentSettings(repoId, location),
  closeSettings: () => useUIStore.getState().closeSettings(),
  openAutomations: (automationId?: string) => useUIStore.getState().openAutomations(automationId),
  closeAutomations: () => useUIStore.getState().closeAutomations(),
  openCustomize: () => useUIStore.getState().openCustomize(),
  closeCustomize: () => useUIStore.getState().closeCustomize(),
  openCommandPalette: () => useUIStore.getState().openCommandPalette(),
  closeCommandPalette: () => useUIStore.getState().closeCommandPalette(),
  toggleCommandPalette: () => useUIStore.getState().toggleCommandPalette(),
  setActiveSettingsSection: (section: SettingsSection) =>
    useUIStore.getState().setActiveSettingsSection(section),
  closeAllModals: () => useUIStore.getState().closeAllModals(),
};
