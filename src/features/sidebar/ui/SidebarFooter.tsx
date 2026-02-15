import { useState } from "react";
import { FolderPlus, Github, Plus } from "lucide-react";
import { SidebarFooter as SidebarFooterUI } from "@/components/ui/sidebar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { SidebarFooterProps } from "../model/types";

/**
 * SidebarFooter — just "Add project" with a popover for two paths.
 * Settings lives in the header profile area — one entry point, not two.
 */
export function SidebarFooter({ onAddRepository, onCloneRepository }: SidebarFooterProps) {
  const [open, setOpen] = useState(false);

  return (
    <SidebarFooterUI className="px-3.5 py-3.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Add project"
            className="text-text-muted hover:text-text-tertiary flex items-center gap-2 transition-colors duration-150"
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span className="text-[13px]">Add project</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-56 p-1.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onAddRepository?.();
            }}
            className="hover:bg-bg-elevated flex w-full items-center gap-3 rounded-md px-3 py-2.5 transition-colors duration-150"
          >
            <FolderPlus className="text-text-muted h-4 w-4 shrink-0" />
            <div className="min-w-0 text-left">
              <p className="text-text-primary text-sm font-medium">Open local project</p>
              <p className="text-text-muted text-xs">Add an existing repository</p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onCloneRepository?.();
            }}
            className="hover:bg-bg-elevated flex w-full items-center gap-3 rounded-md px-3 py-2.5 transition-colors duration-150"
          >
            <Github className="text-text-muted h-4 w-4 shrink-0" />
            <div className="min-w-0 text-left">
              <p className="text-text-primary text-sm font-medium">Clone from GitHub</p>
              <p className="text-text-muted text-xs">Start from a remote repository</p>
            </div>
          </button>
        </PopoverContent>
      </Popover>
    </SidebarFooterUI>
  );
}
