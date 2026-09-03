/**
 * Content Tab Registry — data-driven tab definitions for the content panel.
 *
 * Each entry declares its visibility gates: settings, platform support, or
 * simulator availability.
 * The ContentTabBar and ContentView consume this registry — adding a new tab
 * is one entry here + the component in its feature folder.
 */

import {
  GitBranch,
  FolderOpen,
  Bot,
  Terminal,
  PenTool,
  Globe,
  Smartphone,
  LayoutGrid,
} from "lucide-react";
import type { ContentTab } from "@/features/workspace/store";
import type { Settings } from "@shared/types/settings";
import { capabilities, type CapabilityName } from "@/platform/capabilities";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";

export interface ContentTabVisibility {
  /** This Mac can serve the local simulator (simctl capability + flag). */
  simulatorAvailable?: boolean;
  /** The selected workspace is a cloud computer, which hosts its own device. */
  cloudSimulator?: boolean;
}

export interface ContentTabItem {
  id: ContentTab;
  label: string;
  icon: typeof GitBranch;
  /** Settings key that controls visibility. Absent = always visible. */
  visibilityKey?: keyof Settings;
  /** Platform capability that must be true. Absent = always available. */
  capabilityGate?: CapabilityName;
  /** Simulator tab needs a device to show: this Mac's local simulator, or a
   *  cloud computer's hosted one. */
  requiresSimulator?: boolean;
}

export const CONTENT_TABS: ContentTabItem[] = [
  { id: "changes", label: "Changes", icon: GitBranch },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "terminal", label: "Terminal", icon: Terminal, capabilityGate: "nativeTerminal" },
  { id: "design", label: "Design", icon: PenTool, visibilityKey: "experimental_design" },
  {
    id: "browser",
    label: "Browser",
    icon: Globe,
    capabilityGate: "nativeBrowser",
    visibilityKey: "experimental_browser",
  },
  {
    id: "simulator",
    label: "Simulator",
    icon: Smartphone,
    requiresSimulator: true,
    visibilityKey: "experimental_simulator",
  },
  { id: "apps", label: "Apps", icon: LayoutGrid, visibilityKey: "experimental_apps" },
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
  if (item.capabilityGate && !capabilities[item.capabilityGate]) return false;
  if (item.requiresSimulator) {
    // A cloud computer hosts its own device in the platform: neither this
    // Mac's simctl capability nor the experimental flag has a say. (Web-direct
    // is already out above — the panel needs the Mac backend's cloud driver.)
    if (visibility.cloudSimulator === true) return true;
    if (visibility.simulatorAvailable !== true) return false;
  }
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
