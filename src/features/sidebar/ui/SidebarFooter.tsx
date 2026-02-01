import { Plus } from "lucide-react";
import { SidebarFooter as SidebarFooterUI, useSidebar } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import type { SidebarFooterProps } from "../model/types";

/**
 * SidebarFooter Component
 * Displays "Add Repository" button
 * Structure mirrors SidebarHeader for consistency
 */
export function SidebarFooter({ onAddRepository }: SidebarFooterProps) {
  const { state, hoverOpen, isMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !hoverOpen;

  const addRepoTitle = isCollapsed && !isMobile ? "Add Repository" : undefined;

  return (
    <SidebarFooterUI className="p-2">
      <Button
        variant="ghost"
        onClick={() => onAddRepository?.()}
        aria-label="Add Repository"
        title={addRepoTitle}
        className={cn(
          "h-auto w-full justify-start gap-3 rounded-lg p-2",
          "text-muted-foreground",
          "hover:bg-foreground/5 hover:text-foreground"
        )}
      >
        {/* Icon container - 32x32 to match header avatar */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center">
          <Plus className="h-4 w-4" />
        </div>
        <span className="text-sm">Add Repository</span>
      </Button>
    </SidebarFooterUI>
  );
}
