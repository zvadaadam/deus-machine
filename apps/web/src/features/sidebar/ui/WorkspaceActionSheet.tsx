import React from "react";
import { Archive } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { WORKFLOW_STATUSES, type WorkspaceStatus } from "@shared/enums";
import { WORKFLOW_STATUS_CONFIG } from "../lib/status";
import { WorkflowStatusIcon } from "./WorkflowStatusIcon";
import { getWorkspaceDisplayName } from "../lib/utils";
import type { Workspace } from "@/shared/types";

interface WorkspaceActionSheetProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive?: (workspaceId: string) => void;
  onStatusChange?: (workspaceId: string, status: WorkspaceStatus) => void;
}

/**
 * Mobile-only bottom sheet for workspace actions.
 * Opened via long-press on WorkspaceItem.
 * Actions: change workflow status, archive.
 */
export const WorkspaceActionSheet = React.memo(function WorkspaceActionSheet({
  workspace,
  open,
  onOpenChange,
  onArchive,
  onStatusChange,
}: WorkspaceActionSheetProps) {
  const isArchived = workspace.state === "archived";
  const canArchive = !isArchived && !!onArchive;
  const displayName = getWorkspaceDisplayName(workspace);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        hideClose
        className="gap-0 rounded-t-2xl pb-[max(env(safe-area-inset-bottom),_0.5rem)]"
      >
        {/* Accessible title (visually hidden) */}
        <SheetTitle className="sr-only">{displayName}</SheetTitle>

        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="bg-foreground/20 h-1 w-8 rounded-full" />
        </div>

        {/* Workspace name */}
        <div className="px-4 pb-1">
          <p className="text-text-primary truncate text-sm font-medium">{displayName}</p>
        </div>

        {/* Status options */}
        <div className="px-2 py-1">
          {WORKFLOW_STATUSES.map((status) => {
            const config = WORKFLOW_STATUS_CONFIG[status];
            const isActive = status === workspace.status;
            return (
              <button
                key={status}
                type="button"
                onClick={() => {
                  if (!isActive) onStatusChange?.(workspace.id, status);
                  onOpenChange(false);
                }}
                className="hover:bg-foreground/[0.04] active:bg-foreground/[0.08] flex w-full items-center gap-3 rounded-lg px-3 py-2.5"
              >
                <WorkflowStatusIcon status={status} size={16} />
                <span
                  className={cn(
                    "text-sm",
                    isActive ? "text-text-primary font-medium" : "text-text-secondary"
                  )}
                >
                  {config.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Archive */}
        {canArchive && (
          <>
            <div className="border-border mx-4 border-t" />
            <div className="px-2 pt-1 pb-2">
              <button
                type="button"
                onClick={() => {
                  onArchive(workspace.id);
                  onOpenChange(false);
                }}
                className="text-accent-red hover:bg-foreground/[0.04] active:bg-foreground/[0.08] flex w-full items-center gap-3 rounded-lg px-3 py-2.5"
              >
                <Archive className="h-4 w-4" />
                <span className="text-sm">Archive</span>
              </button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
});
