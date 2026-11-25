/**
 * Keyboard shortcuts for the right-side browser-style workspace tabs.
 *
 * - ⌘1…⌘9 (macOS Meta + digit, never Control — Control+1..9 switches places):
 *   selects the 1st..9th visible workspace tab and reveals the pane if hidden.
 * - ⌘W / Ctrl+W when focus is inside the workspace content pane (and not in a
 *   text field): closes the active workspace tab instead of closing a chat tab.
 */

import { useEffect } from "react";
import type { WorkspaceTab } from "../types";

function isTextFieldFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable ||
      el.getAttribute("role") === "textbox")
  );
}

export function useWorkspaceTabShortcuts({
  enabled,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
}: {
  enabled: boolean;
  tabs: WorkspaceTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Meta+1..9 only (Control+1..9 is reserved for location/org switching).
      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
        if (digit) {
          const target = tabs[Number(digit) - 1];
          if (!target) return;
          event.preventDefault();
          onSelectTab(target.id);
          return;
        }
      }

      // Cmd+W / Ctrl+W closes the active workspace tab when focus lives in the workspace pane.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "w"
      ) {
        if (isTextFieldFocused()) return;
        const activeEl = document.activeElement;
        if (!activeEl?.closest('[data-slot="workspace-content-pane"]')) return;
        const current = tabs.find((t) => t.id === activeTabId);
        if (!current) return;
        const canClose = tabs.length > 1 || current.kind !== "new-tab";
        if (!canClose) return;
        event.preventDefault();
        onCloseTab(current.id);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, tabs, activeTabId, onSelectTab, onCloseTab]);
}
