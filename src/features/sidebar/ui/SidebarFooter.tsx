import { FolderPlus, HelpCircle, Settings } from "lucide-react";
import { SidebarFooter as SidebarFooterUI } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import type { SidebarFooterProps } from "../model/types";

/**
 * SidebarFooter Component
 * Displays "Add Repository" button
 * Structure mirrors SidebarHeader for consistency
 */
export function SidebarFooter({ onAddRepository, onOpenSettings, onOpenHelp }: SidebarFooterProps) {
  return (
    <SidebarFooterUI className="border-sidebar-border bg-sidebar-accent/30 border-t px-2 py-2">
      <div className="flex items-center gap-2 px-1">
        <Button
          variant="ghost"
          onClick={() => onAddRepository?.()}
          aria-label="Add Repository"
          className={cn(
            "h-auto flex-1 justify-start gap-2 rounded-md px-0 py-1.5",
            "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          )}
        >
          <FolderPlus className="h-4 w-4 shrink-0" />
          <span className="text-[13px]">Add repository</span>
        </Button>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Help"
            onClick={onOpenHelp}
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground h-8 w-8"
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Settings"
            onClick={onOpenSettings}
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground h-8 w-8"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </SidebarFooterUI>
  );
}
