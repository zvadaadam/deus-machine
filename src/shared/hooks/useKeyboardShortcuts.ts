import { useEffect } from "react";
import type { Workspace } from "@/shared/types";

interface UseKeyboardShortcutsOptions {
  onRefresh: () => Promise<void>;
  onEscape?: () => void;
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
  selectedWorkspace,
  modalStates = {},
}: UseKeyboardShortcutsOptions) {
  useEffect(() => {
    async function handleKeyDown(e: KeyboardEvent) {
      // ⌘R or Ctrl+R - Refresh workspace data
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        console.log("🔄 Refreshing workspace data...");
        await onRefresh();
      }

      // ESC - Close modals
      if (e.key === "Escape" && onEscape) {
        onEscape();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onRefresh, onEscape, selectedWorkspace, modalStates]);
}
