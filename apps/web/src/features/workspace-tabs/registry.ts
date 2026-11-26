/**
 * Workspace Tab Registry — exhaustive, data-driven tool definitions and visibility gates.
 *
 * `TOOL_DEFINITIONS` is keyed by `Record<ContentTab, ToolDefinition>` so adding a
 * new `ContentTab` without registering its label, icon, and gates fails typechecking.
 * Strip labels, icons, New Tab cards, and visibility checks all derive from here.
 */

import {
  GitBranch,
  FolderOpen,
  Bot,
  Terminal,
  Globe,
  Smartphone,
  Compass,
  FileText,
} from "lucide-react";
import { match } from "ts-pattern";
import type { Settings } from "@shared/types/settings";
import { capabilities, type CapabilityName } from "@/platform/capabilities";
import { localDeviceRenderer } from "@/features/device/useDeviceSupport";
import { getDeploymentMode } from "@/shared/config/backend.config";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { deriveTitleFromUrl, isBlankUrl } from "@/features/browser/types";
import { basenameOfPath, type ContentTab, type WorkspaceTab, type WorkspaceTabKind } from "./types";

export interface ContentTabVisibility {
  /** The selected workspace runs in the cloud. */
  cloud?: boolean;
  /** This backend can install and stream local devices. */
  deviceAvailable?: boolean;
}

/** The visibility input for a workspace: the one place a tab reads local or cloud. */
export function tabsFor(
  workspace: { kind: string } | null | undefined,
  deviceAvailable = false
): ContentTabVisibility {
  return { cloud: workspace?.kind === "cloud", deviceAvailable };
}

export interface ToolDefinition {
  label: string;
  description: string;
  keywords: string[];
  icon: typeof GitBranch;
  /** Settings key that controls visibility. Absent = always visible. */
  visibilityKey?: keyof Settings;
  /** Platform capability that must be true. Absent = always available. */
  capabilityGate?: CapabilityName;
  requiresDeviceView?: boolean;
  hostedWeb?: boolean;
  /** The gates above are this computer's own panel's: a cloud workspace's tab
   *  is served by the cloud computer and always shows. */
  localGates?: boolean;
}

export interface ContentTabItem extends ToolDefinition {
  id: ContentTab;
}

/**
 * Exhaustive tool registry — omitting any `ContentTab` is a compile-time error.
 */
const TOOL_DEFINITIONS: Record<ContentTab, ToolDefinition> = {
  terminal: {
    label: "Terminal",
    description: "Run commands in this workspace",
    keywords: ["shell", "bash", "zsh", "cli", "console"],
    icon: Terminal,
  },
  browser: {
    label: "Browser",
    description: "Preview web apps & inspect UI",
    keywords: ["web", "preview", "url", "page", "localhost"],
    icon: Globe,
    capabilityGate: "nativeBrowser",
    visibilityKey: "experimental_browser",
    localGates: true,
  },
  changes: {
    label: "Changes",
    description: "Review git diffs & modified files",
    keywords: ["diff", "git", "review", "modified", "status"],
    icon: GitBranch,
  },
  files: {
    label: "Files",
    description: "Browse repository files",
    keywords: ["explorer", "tree", "code", "folder", "browse"],
    icon: FolderOpen,
  },
  device: {
    label: "Device",
    description: "View and control an iOS or Android device",
    keywords: ["ios", "android", "simulator", "emulator", "phone"],
    requiresDeviceView: true,
    localGates: true,
    hostedWeb: true,
    icon: Smartphone,
  },
  config: {
    label: "Agent",
    description: "Skills, commands, MCP & hooks",
    keywords: ["skills", "mcp", "hooks", "commands", "config"],
    icon: Bot,
  },
};

/** Display order derived directly from `TOOL_DEFINITIONS` so every `ContentTab` is covered. */
const TOOL_ORDER = Object.keys(TOOL_DEFINITIONS) as ContentTab[];

/** Ordered list of workspace tools derived directly from `TOOL_DEFINITIONS`. */
export const CONTENT_TABS: ContentTabItem[] = TOOL_ORDER.map((id) => ({
  id,
  ...TOOL_DEFINITIONS[id],
}));

/** Static icon lookup by WorkspaceTabKind, derived from `TOOL_DEFINITIONS`. */
export const TAB_KIND_ICONS: Record<WorkspaceTabKind, typeof GitBranch> = {
  "new-tab": Compass,
  file: FileText,
  terminal: TOOL_DEFINITIONS.terminal.icon,
  browser: TOOL_DEFINITIONS.browser.icon,
  changes: TOOL_DEFINITIONS.changes.icon,
  files: TOOL_DEFINITIONS.files.icon,
  device: TOOL_DEFINITIONS.device.icon,
  config: TOOL_DEFINITIONS.config.icon,
};

/** Human-readable tab title displayed in the tab strip, derived from `TOOL_DEFINITIONS`. */
export function getWorkspaceTabTitle(tab: WorkspaceTab): string {
  return match(tab)
    .with({ kind: "new-tab" }, () => "New tab")
    .with({ kind: "file" }, ({ path }) => basenameOfPath(path) || path)
    .with({ kind: "terminal" }, ({ title }) => title || TOOL_DEFINITIONS.terminal.label)
    .with({ kind: "browser" }, ({ title, url }) => {
      if (title && title !== "New Tab" && !isBlankUrl(title)) return title;
      if (url && !isBlankUrl(url)) return deriveTitleFromUrl(url);
      return TOOL_DEFINITIONS.browser.label;
    })
    .with(
      { kind: "changes" },
      { kind: "files" },
      { kind: "device" },
      { kind: "config" },
      ({ kind }) => TOOL_DEFINITIONS[kind].label
    )
    .exhaustive();
}

/** Check if a tool tab should be visible given current settings and platform capabilities. */
export function isTabVisible(
  tab: ContentTab,
  settings?: Settings,
  visibility: ContentTabVisibility = {}
): boolean {
  const item = TOOL_DEFINITIONS[tab];
  if (!item) return false;
  if (isCloudDirectWebMode()) return item.hostedWeb === true && visibility.cloud === true;
  if (item.localGates && visibility.cloud === true) return true;
  if (item.capabilityGate && !capabilities[item.capabilityGate]) return false;
  if (
    item.requiresDeviceView &&
    !(visibility.deviceAvailable && localDeviceRenderer(getDeploymentMode()))
  )
    return false;
  if (item.visibilityKey) return settings?.[item.visibilityKey] === true;
  return true;
}

/** Check whether a WorkspaceTab instance is allowed under current settings/visibility. */
export function isWorkspaceTabVisible(
  tab: WorkspaceTab,
  settings?: Settings,
  visibility: ContentTabVisibility = {}
): boolean {
  if (tab.kind === "new-tab") return anyContentTabVisible(settings, visibility);
  if (tab.kind === "file") return isTabVisible("files", settings, visibility);
  return isTabVisible(tab.kind, settings, visibility);
}

/** Visible tool items for the New Tab launcher and collapsed-panel shortcuts. */
export function getVisibleTools(
  settings?: Settings,
  visibility: ContentTabVisibility = {}
): ContentTabItem[] {
  return CONTENT_TABS.filter((item) => isTabVisible(item.id, settings, visibility));
}

/** Whether the content pane has anything to show — false means chat-only layout. */
export function anyContentTabVisible(
  settings?: Settings,
  visibility: ContentTabVisibility = {}
): boolean {
  return CONTENT_TABS.some((item) => isTabVisible(item.id, settings, visibility));
}
