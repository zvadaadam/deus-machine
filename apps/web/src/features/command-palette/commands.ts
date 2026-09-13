import type { ComponentType, SVGAttributes } from "react";
import {
  Plus,
  FolderOpen,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Settings,
  ArrowUpRight,
  ClockFading,
} from "lucide-react";
import { uiActions } from "@/shared/stores/uiStore";
import { capabilities } from "@/platform/capabilities";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import {
  settingsNavigation,
  isSettingsSectionAvailable,
} from "@/features/settings/settings-navigation";

export type CommandGroup = "workspace" | "project" | "navigation" | "settings";

/** Accepts both lucide icons and our custom SVG components (e.g. GitHubIcon). */
type IconComponent = ComponentType<SVGAttributes<SVGSVGElement>>;

export interface CommandDefinition {
  id: string;
  label: string;
  icon: IconComponent;
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

const macBackendAvailable = () => !isCloudDirectWebMode();

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
    when: macBackendAvailable,
    action: () => uiActions.openNewWorkspaceModal(),
  },
  {
    id: "new-workspace-from",
    label: "New Workspace from\u2026",
    icon: GitPullRequest,
    group: "workspace",
    keywords: ["create", "pr", "pull request", "branch", "github", "from"],
    when: macBackendAvailable,
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
    when: macBackendAvailable,
    action: () => {},
  },
  {
    id: "start-new-project",
    label: "Start New Project",
    icon: FolderGit2,
    group: "project",
    keywords: ["create", "new", "init", "template", "scratch", "blank"],
    when: macBackendAvailable,
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
  {
    id: "open-automations",
    label: "Go to Automations",
    icon: ClockFading,
    group: "navigation",
    keywords: ["automations", "scheduled", "cron", "recurring", "tasks"],
    when: macBackendAvailable,
    action: () => uiActions.openAutomations(),
  },

  ...settingsNavigation.map(
    (section): CommandDefinition => ({
      id: `settings-${section.id}`,
      label: `Settings: ${section.label}`,
      icon: section.icon,
      group: "settings",
      keywords: section.keywords,
      when: () => isSettingsSectionAvailable(section),
      action: () => {
        uiActions.openSettings();
        uiActions.setActiveSettingsSection(section.id);
      },
    })
  ),
];
