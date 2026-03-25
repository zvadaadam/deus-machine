import { useEffect } from "react";
import { uiActions } from "@/shared/stores/uiStore";
import type { Workspace } from "@/shared/types";

interface UseKeyboardShortcutsOptions {
  onRefresh: () => Promise<void>;
  onEscape?: () => void;
  onOpenInApp?: () => void;
  selectedWorkspace: Workspace | null;
  modalStates?: {
    showNewWorkspaceModal?: boolean;
    selectedFile?: string | null;
    showSystemPromptModal?: boolean;
  };
}

export function useKeyboardShortcuts({
  onRefresh,
  onEscape,
  onOpenInApp,
  selectedWorkspace,
  modalStates = {},
}: UseKeyboardShortcutsOptions) {
  useEffect(() => {
    async function handleKeyDown(e: KeyboardEvent) {
      // ⌘K or Ctrl+K - Toggle command palette
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        uiActions.toggleCommandPalette();
        return;
      }

      // ⌘O or Ctrl+O - Open in last-used app
      if ((e.metaKey || e.ctrlKey) && e.key === "o" && onOpenInApp) {
        e.preventDefault();
        onOpenInApp();
        return;
      }

      // ⌘R or Ctrl+R - Refresh workspace data
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        if (import.meta.env.DEV) console.log("🔄 Refreshing workspace data...");
        await onRefresh();
      }

      // ESC - Close modals
      if (e.key === "Escape" && onEscape) {
        onEscape();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onRefresh, onEscape, onOpenInApp, selectedWorkspace, modalStates]);
}
