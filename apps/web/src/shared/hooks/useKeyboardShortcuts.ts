import { useEffect } from "react";
import { uiActions } from "@/shared/stores/uiStore";

interface UseKeyboardShortcutsOptions {
  onRefresh: () => Promise<void>;
  onEscape?: () => void;
  onOpenInApp?: () => void;
  /** ⌃1…⌃9: the location menu's row at that index (0 for ⌃1). */
  onSwitchPlace?: (index: number) => void;
}

export function useKeyboardShortcuts({
  onRefresh,
  onEscape,
  onOpenInApp,
  onSwitchPlace,
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

      // ⌃1…⌃9 (the physical Control key alone) - This computer, then each organization
      if (onSwitchPlace && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
        if (digit) {
          e.preventDefault();
          onSwitchPlace(Number(digit) - 1);
          return;
        }
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
  }, [onRefresh, onEscape, onOpenInApp, onSwitchPlace]);
}
