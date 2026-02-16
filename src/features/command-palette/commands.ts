import type { LucideIcon } from "lucide-react";
import {
  Plus,
  FolderOpen,
  GitBranch,
  Settings,
  Sparkles,
  Puzzle,
} from "lucide-react";
import { uiActions } from "@/shared/stores/uiStore";

export type CommandGroup = "workspace" | "navigation" | "settings";

export interface CommandDefinition {
  id: string;
  label: string;
  icon: LucideIcon;
  group: CommandGroup;
  shortcut?: string;
  keywords?: string[];
  action: () => void;
  /** Return false to hide this command from the palette */
  when?: () => boolean;
}

export const GROUP_LABELS: Record<CommandGroup, string> = {
  workspace: "Workspace",
  navigation: "Navigation",
  settings: "Settings",
};

/**
 * Centralized command registry.
 *
 * Commands that need runtime context (Tauri dialogs, mutations, etc.)
 * have placeholder actions here — the palette component overrides them
 * via the `actionOverrides` prop.
 */
export const staticCommands: CommandDefinition[] = [
  // --- Workspace ---
  {
    id: "new-workspace",
    label: "New Workspace",
    icon: Plus,
    group: "workspace",
    keywords: ["create", "add", "workspace", "agent"],
    action: () => uiActions.openNewWorkspaceModal(),
  },
  {
    id: "open-project",
    label: "Open Project",
    icon: FolderOpen,
    group: "workspace",
    keywords: ["add", "repository", "folder", "directory", "repo"],
    action: () => {},
  },
  {
    id: "clone-repository",
    label: "Clone Repository",
    icon: GitBranch,
    group: "workspace",
    keywords: ["git", "clone", "github", "repo"],
    action: () => {},
  },

  // --- Navigation ---
  {
    id: "go-to-settings",
    label: "Go to Settings",
    icon: Settings,
    group: "navigation",
    shortcut: "\u2318,",
    keywords: ["preferences", "config", "options"],
    action: () => uiActions.openSettings(),
  },

  // --- Settings sections ---
  {
    id: "settings-general",
    label: "Settings: General",
    icon: Settings,
    group: "settings",
    keywords: ["theme", "appearance", "name", "preferences"],
    action: () => {
      uiActions.openSettings();
      uiActions.setActiveSettingsSection("general");
    },
  },
  {
    id: "settings-ai",
    label: "Settings: AI",
    icon: Sparkles,
    group: "settings",
    keywords: ["model", "claude", "anthropic", "api", "key", "provider"],
    action: () => {
      uiActions.openSettings();
      uiActions.setActiveSettingsSection("ai");
    },
  },
  {
    id: "settings-extensions",
    label: "Settings: Extensions",
    icon: Puzzle,
    group: "settings",
    keywords: ["mcp", "servers", "commands", "agents", "hooks", "plugins"],
    action: () => {
      uiActions.openSettings();
      uiActions.setActiveSettingsSection("extensions");
    },
  },
];
