/**
 * Keyboard Shortcuts Hook
 *
 * Cmd+\  toggles the session (chat) panel
 * Cmd+]  toggles the content panel
 *
 * Extracted from MainContent to keep the layout component focused on
 * rendering. All shortcuts operate on imperative panel refs.
 */

import { useEffect } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";

interface UseKeyboardShortcutsOptions {
  /** Whether any workspace is selected (shortcuts disabled without one) */
  enabled: boolean;
  /** Chat panel state */
  chatPanelCollapsed: boolean;
  chatPanelRef: React.RefObject<ImperativePanelHandle | null>;
  /** Content panel state */
  contentPanelCollapsed: boolean;
  contentPanelRef: React.RefObject<ImperativePanelHandle | null>;
}

export function useKeyboardShortcuts({
  enabled,
  chatPanelCollapsed,
  chatPanelRef,
  contentPanelCollapsed,
  contentPanelRef,
}: UseKeyboardShortcutsOptions) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      // Cmd+\ — toggle chat panel
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        if (chatPanelCollapsed) {
          chatPanelRef.current?.expand();
        } else {
          chatPanelRef.current?.collapse();
        }
      }

      // Cmd+] — toggle content panel
      if ((e.metaKey || e.ctrlKey) && e.key === "]") {
        e.preventDefault();
        if (contentPanelCollapsed) {
          contentPanelRef.current?.expand();
        } else {
          contentPanelRef.current?.collapse();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, chatPanelCollapsed, chatPanelRef, contentPanelCollapsed, contentPanelRef]);
}
