import type { ComponentType, SVGAttributes } from "react";
import { Bot, Box, Chrome, Cloud, FlaskConical, Globe, Settings2, UserCircle } from "lucide-react";
import { GitHubIcon } from "@/shared/components/icons/GitHubIcon";
import { capabilities } from "@/platform/capabilities";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import type { SettingsSection } from "@shared/types/settings";

interface SettingsNavigationItem {
  id: SettingsSection;
  label: string;
  icon: ComponentType<SVGAttributes<SVGSVGElement>>;
  keywords: string[];
  cloudDirect?: boolean;
  capability?: keyof typeof capabilities;
  badge?: string;
}

/** Shared by the sidebar, page heading, and command palette. */
export const settingsNavigation: SettingsNavigationItem[] = [
  {
    id: "account",
    label: "Account",
    icon: UserCircle,
    cloudDirect: true,
    keywords: ["organization", "usage", "login", "sign in"],
  },
  {
    id: "general",
    label: "General",
    icon: Settings2,
    keywords: ["theme", "appearance", "preferences"],
  },
  {
    id: "github",
    label: "GitHub",
    icon: GitHubIcon,
    keywords: ["git", "repository", "auth", "login"],
  },
  {
    id: "browser",
    label: "Browser",
    icon: Chrome,
    capability: "browserProfileImport",
    keywords: ["profile", "import", "cookies"],
  },
  {
    id: "ai",
    label: "AI Providers",
    icon: Bot,
    cloudDirect: true,
    keywords: ["model", "claude", "anthropic", "codex", "openai", "api", "key", "subscription"],
  },
  { id: "cloud", label: "Cloud", icon: Cloud, keywords: ["connection", "setup", "sandbox"] },
  {
    id: "environment",
    label: "Environment",
    icon: Box,
    cloudDirect: true,
    keywords: ["repository", "setup", "run", "script", "secrets", "variables"],
  },
  {
    id: "experimental",
    label: "Experimental",
    icon: FlaskConical,
    keywords: ["features", "preview"],
  },
  {
    id: "access",
    label: "Remote Access",
    icon: Globe,
    badge: "Experimental",
    keywords: ["pair", "mobile", "device"],
  },
];

export function isSettingsSectionAvailable(item: SettingsNavigationItem): boolean {
  return (
    (!isCloudDirectWebMode() || item.cloudDirect === true) &&
    (!item.capability || capabilities[item.capability])
  );
}

export function resolveSettingsSection(section: SettingsSection): SettingsNavigationItem {
  return (
    settingsNavigation.find((item) => item.id === section && isSettingsSectionAvailable(item)) ??
    settingsNavigation[0]!
  );
}
