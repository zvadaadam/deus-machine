import { FolderPlus, Settings } from "lucide-react";
import { SidebarFooter as SidebarFooterUI } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import type { SidebarFooterProps } from "../model/types";

/**
 * SidebarFooter Component
 * Displays "Add Repository" button
 * Structure mirrors SidebarHeader for consistency
 */
export function SidebarFooter({ onAddRepository, onOpenSettings }: SidebarFooterProps) {
  return (
    <SidebarFooterUI className="flex-row items-center">
      <Button
        variant="ghost"
        onClick={() => onAddRepository?.()}
        aria-label="Add Repository"
        className={cn(
          "h-auto flex-1 justify-start gap-2 rounded-md px-1 py-1.5 has-[>svg]:px-1",
          "text-muted-foreground"
        )}
      >
        <FolderPlus className="h-4 w-4 shrink-0" />
        <span className="text-[13px]">Add repository</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Settings"
        onClick={onOpenSettings}
        className="text-muted-foreground h-8 w-8"
      >
        <Settings className="h-4 w-4" />
      </Button>
    </SidebarFooterUI>
  );
}
