import { useEffect } from "react";
import { uiActions } from "@/shared/stores/uiStore";

interface UseKeyboardShortcutsOptions {
  onRefresh: () => Promise<void>;
  onEscape?: () => void;
  onOpenInApp?: () => void;
  /** ⌃1 / ⌃2: where this window's workspaces run. */
  onSwitchLocation?: (location: "local" | "cloud") => void;
}

export function useKeyboardShortcuts({
  onRefresh,
  onEscape,
  onOpenInApp,
  onSwitchLocation,
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

      // ⌃1 / ⌃2 (the physical Control key alone) - This computer / Deus Cloud
      if (onSwitchLocation && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const location = e.code === "Digit1" ? "local" : e.code === "Digit2" ? "cloud" : undefined;
        if (location) {
          e.preventDefault();
          onSwitchLocation(location);
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
  }, [onRefresh, onEscape, onOpenInApp, onSwitchLocation]);
}
