/**
 * Content Tab Registry — data-driven tab definitions for the content panel.
 *
 * Each entry declares its visibility gates: settings, platform support, or
 * simulator availability. Those gates are this computer's; a cloud
 * workspace's Browser and Simulator tabs ignore them (`localGates`).
 * The ContentTabBar and ContentView consume this registry — adding a new tab
 * is one entry here + the component in its feature folder.
 */

import { GitBranch, FolderOpen, Bot, Terminal, Globe, Smartphone } from "lucide-react";
import type { ContentTab } from "@/features/workspace/store";
import type { Settings } from "@shared/types/settings";
import { capabilities, type CapabilityName } from "@/platform/capabilities";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";

/**
 * What a tab's visibility depends on besides settings. A cloud workspace's
 * tabs are the cloud computer's: this computer's local browser and simulator
 * (their capability, their experimental settings) have no say in them.
 */
export interface ContentTabVisibility {
  /** The selected workspace runs in the cloud. */
  cloud?: boolean;
  /** This computer can serve the local simulator (simctl capability + flag). */
  simulatorAvailable?: boolean;
}

/** The visibility input for a workspace: the one place a tab reads local or cloud. */
export function tabsFor(
  workspace: { kind: string } | null | undefined,
  simulatorAvailable = false
): ContentTabVisibility {
  return { cloud: workspace?.kind === "cloud", simulatorAvailable };
}

export interface ContentTabItem {
  id: ContentTab;
  label: string;
  icon: typeof GitBranch;
  /** Settings key that controls visibility. Absent = always visible. */
  visibilityKey?: keyof Settings;
  /** Platform capability that must be true. Absent = always available. */
  capabilityGate?: CapabilityName;
  /** Simulator tab needs a device to show: this Mac's local simulator. */
  requiresSimulator?: boolean;
  /** The gates above are this computer's own panel's: a cloud workspace's tab
   *  is served by the cloud computer and always shows. */
  localGates?: boolean;
}

export const CONTENT_TABS: ContentTabItem[] = [
  { id: "changes", label: "Changes", icon: GitBranch },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "terminal", label: "Terminal", icon: Terminal },
  {
    id: "browser",
    label: "Browser",
    icon: Globe,
    capabilityGate: "nativeBrowser",
    visibilityKey: "experimental_browser",
    localGates: true,
  },
  {
    id: "simulator",
    label: "Simulator",
    icon: Smartphone,
    requiresSimulator: true,
    visibilityKey: "experimental_simulator",
    localGates: true,
  },
  { id: "config", label: "Agent", icon: Bot },
];

/** Check if a tab should be visible given current settings and platform capabilities. */
export function isTabVisible(
  tab: ContentTab,
  settings?: Settings,
  visibility: ContentTabVisibility = {}
): boolean {
  // Web-direct (fully Mac-closed browser) serves NO content tab: every panel
  // here reads the Mac backend or the sandbox sidecar relay, neither of which
  // exists on the direct lane — the browser drives chat only. MainContent
  // renders the chat pane full-width when nothing here is visible.
  if (isCloudDirectWebMode()) return false;
  const item = CONTENT_TABS.find((i) => i.id === tab);
  if (!item) return false;
  // The cloud preview and the cloud device are the cloud computer's.
  if (item.localGates && visibility.cloud === true) return true;
  if (item.capabilityGate && !capabilities[item.capabilityGate]) return false;
  if (item.requiresSimulator && visibility.simulatorAvailable !== true) return false;
  if (item.visibilityKey) return settings?.[item.visibilityKey] === true;
  return true;
}

/** Whether the content pane has anything to show — false means chat-only layout. */
export function anyContentTabVisible(
  settings?: Settings,
  visibility: ContentTabVisibility = {}
): boolean {
  return CONTENT_TABS.some((item) => isTabVisible(item.id, settings, visibility));
}
