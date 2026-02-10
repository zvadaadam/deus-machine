import { FolderPlus, HelpCircle, Settings } from "lucide-react";
import { SidebarFooter as SidebarFooterUI } from "@/components/ui/sidebar";
import type { SidebarFooterProps } from "../model/types";

/**
 * SidebarFooter — V2: Jony Ive
 *
 * Layout: [FolderPlus] [Add repository]  ...  [Help] [Settings]
 * Padding: 14px all sides (matches header rhythm)
 * Icon color: #787878 (neutral-500 zone)
 * Text: #707070, Inter 13px normal
 */
export function SidebarFooter({ onAddRepository, onOpenSettings }: SidebarFooterProps) {
  return (
    <SidebarFooterUI className="flex-row items-center px-3.5 py-3.5">
      <button
        type="button"
        onClick={() => onAddRepository?.()}
        aria-label="Add Repository"
        className="text-text-muted hover:text-text-tertiary flex min-w-0 flex-1 items-center gap-2 transition-colors duration-150"
      >
        <FolderPlus className="h-4 w-4 shrink-0" />
        <span className="text-[13px]">Add repository</span>
      </button>

      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label="Help"
          className="text-text-muted hover:text-text-tertiary flex h-4 w-4 items-center justify-center transition-colors duration-150"
        >
          <HelpCircle className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Settings"
          onClick={onOpenSettings}
          className="text-text-muted hover:text-text-tertiary flex h-4 w-4 items-center justify-center transition-colors duration-150"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </SidebarFooterUI>
  );
}
