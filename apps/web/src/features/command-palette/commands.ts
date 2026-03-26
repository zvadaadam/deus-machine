import type { LucideIcon } from "lucide-react";
import {
  Plus,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Settings,
  Orbit,
  ArrowUpRight,
} from "lucide-react";
import { uiActions } from "@/shared/stores/uiStore";
import { capabilities } from "@/platform/capabilities";

export type CommandGroup = "workspace" | "project" | "navigation" | "settings";

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
  project: "Project",
  navigation: "Navigation",
  settings: "Settings",
};

/**
 * Centralized command registry.
 *
 * Commands that need runtime context (native dialogs, mutations, etc.)
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
    id: "new-workspace-from",
    label: "New Workspace from\u2026",
    icon: GitPullRequest,
    group: "workspace",
    keywords: ["create", "pr", "pull request", "branch", "github", "from"],
    action: () => uiActions.openNewWorkspaceModal("from-github"),
  },

  {
    id: "open-in-app",
    label: "Open in Last Editor",
    icon: ArrowUpRight,
    group: "workspace",
    shortcut: "\u2318O",
    keywords: ["open", "editor", "vscode", "cursor", "external", "app"],
    when: () => capabilities.openInExternalApp,
    action: () => {},
  },

  // --- Project ---
  {
    id: "open-project",
    label: "Open Project",
    icon: FolderOpen,
    group: "project",
    keywords: ["add", "repository", "folder", "directory", "repo"],
    when: () => capabilities.nativeFolderPicker,
    action: () => {},
  },
  {
    id: "clone-repository",
    label: "Clone Repository",
    icon: GitBranch,
    group: "project",
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
    label: "Settings: Providers",
    icon: Orbit,
    group: "settings",
    keywords: ["ai", "model", "claude", "anthropic", "codex", "openai", "api", "key", "provider"],
    action: () => {
      uiActions.openSettings();
      uiActions.setActiveSettingsSection("ai");
    },
  },
];
