import { useEffect } from "react";
import type { WorkspacePanelMode } from "@/features/workspace/store/workspaceLayoutStore";

/** Cmd+\ toggles workspace focus; Cmd+] toggles workspace visibility. */
export function usePanelShortcuts({
  enabled,
  mode,
  onModeChange,
}: {
  enabled: boolean;
  mode: WorkspacePanelMode;
  onModeChange: (mode: WorkspacePanelMode) => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "\\") {
        event.preventDefault();
        onModeChange(mode === "content" ? "split" : "content");
      } else if (event.key === "]") {
        event.preventDefault();
        onModeChange(mode === "chat" ? "split" : "chat");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, mode, onModeChange]);
}
