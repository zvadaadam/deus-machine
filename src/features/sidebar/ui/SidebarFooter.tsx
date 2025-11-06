import { Plus } from "lucide-react";
import {
  SidebarFooter as SidebarFooterUI,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import type { SidebarFooterProps } from "../model/types";

/**
 * SidebarFooter Component
 * Displays "Add Repository" button
 */
export function SidebarFooter({ onAddRepository }: SidebarFooterProps) {
  return (
    <SidebarFooterUI className="p-0">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onAddRepository?.()}
        className={cn(
          "w-full h-8 px-2",
          "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent",
          "transition-colors duration-200 ease-out",
          "group-data-[collapsible=icon]:hidden"
        )}
      >
        <div className="flex items-center gap-3 w-full">
          <Plus className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm">Add Repository</span>
        </div>
      </Button>
      <SidebarMenu className="hidden group-data-[collapsible=icon]:block">
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() => onAddRepository?.()}
            tooltip="Add Repository"
            aria-label="Add Repository"
          >
            <Plus className="h-4 w-4" />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooterUI>
  );
}
