import { useState } from "react";
import { FolderGit2, FolderPlus, Github, Plus } from "lucide-react";
import { SidebarFooter as SidebarFooterUI } from "@/components/ui/sidebar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AIStatusIndicator } from "@/features/ai-status/ui/AIStatusIndicator";
import { ConnectionOrb } from "@/features/connection";
import { capabilities } from "@/platform/capabilities";
import type { SidebarFooterProps } from "../model/types";

/**
 * SidebarFooter — "Add project" + ambient AI provider status indicator.
 * The status indicator renders nothing when all providers are healthy.
 */
export function SidebarFooter({
  onAddRepository,
  onCloneRepository,
  onStartNewProject,
}: SidebarFooterProps) {
  const [open, setOpen] = useState(false);

  return (
    <SidebarFooterUI className="flex flex-row items-center justify-between px-3.5 py-3.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Add project"
            className="text-text-muted hover:text-text-tertiary flex items-center gap-2 transition-colors duration-150"
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span className="text-sm">Add project</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-60 p-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onStartNewProject?.();
            }}
            className="hover:bg-bg-elevated focus-visible:bg-bg-elevated flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors duration-150 focus-visible:outline-none"
          >
            <FolderGit2 className="text-text-muted h-4 w-4 shrink-0" />
            <div className="min-w-0 text-left">
              <p className="text-text-primary text-sm font-medium">Start new project</p>
              <p className="text-text-muted text-xs">Create from scratch or template</p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onCloneRepository?.();
            }}
            className="hover:bg-bg-elevated focus-visible:bg-bg-elevated flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors duration-150 focus-visible:outline-none"
          >
            <Github className="text-text-muted h-4 w-4 shrink-0" />
            <div className="min-w-0 text-left">
              <p className="text-text-primary text-sm font-medium">Clone from GitHub</p>
              <p className="text-text-muted text-xs">Start from a remote repository</p>
            </div>
          </button>
          {capabilities.nativeFolderPicker && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAddRepository?.();
              }}
              className="hover:bg-bg-elevated focus-visible:bg-bg-elevated flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors duration-150 focus-visible:outline-none"
            >
              <FolderPlus className="text-text-muted h-4 w-4 shrink-0" />
              <div className="min-w-0 text-left">
                <p className="text-text-primary text-sm font-medium">Open local project</p>
                <p className="text-text-muted text-xs">Add an existing repository</p>
              </div>
            </button>
          )}
        </PopoverContent>
      </Popover>
      <div className="flex items-center gap-2">
        <ConnectionOrb />
        <AIStatusIndicator />
      </div>
    </SidebarFooterUI>
  );
}
