/**
 * Content Tab Registry — data-driven tab definitions for the content panel.
 *
 * Each entry declares its visibility gates (settings key, platform capability).
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

export interface ContentTabItem {
  id: ContentTab;
  label: string;
  icon: typeof GitBranch;
  /** Settings key that controls visibility. Absent = always visible. */
  visibilityKey?: keyof Settings;
  /** Platform capability that must be true. Absent = always available. */
  capabilityGate?: CapabilityName;
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
    capabilityGate: "nativeSimulator",
    visibilityKey: "experimental_simulator",
  },
  // AAP (agentic apps protocol) — always visible, no settings/capability gate.
  { id: "apps", label: "Apps", icon: LayoutGrid },
  { id: "config", label: "Agent", icon: Bot },
];

/** Check if a tab should be visible given current settings and platform capabilities. */
export function isTabVisible(tab: ContentTab, settings?: Settings): boolean {
  const item = CONTENT_TABS.find((i) => i.id === tab);
  if (!item) return false;
  if (item.capabilityGate && !capabilities[item.capabilityGate]) return false;
  if (item.visibilityKey) return settings?.[item.visibilityKey] === true;
  return true;
}
