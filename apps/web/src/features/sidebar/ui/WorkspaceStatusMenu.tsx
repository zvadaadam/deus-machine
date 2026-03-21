import React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WORKFLOW_STATUSES, type WorkspaceStatus } from "@shared/enums";
import { WORKFLOW_STATUS_CONFIG } from "../lib/status";
import { WorkflowStatusIcon } from "./WorkflowStatusIcon";

interface WorkspaceStatusMenuProps {
  currentStatus: WorkspaceStatus;
  onStatusChange: (status: WorkspaceStatus) => void;
  children: React.ReactNode;
}

/**
 * Dropdown menu for changing workspace workflow status.
 * Wraps a trigger element (the status icon) with a menu of all statuses.
 */
export const WorkspaceStatusMenu = React.memo(function WorkspaceStatusMenu({
  currentStatus,
  onStatusChange,
  children,
}: WorkspaceStatusMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        {WORKFLOW_STATUSES.map((status) => {
          const config = WORKFLOW_STATUS_CONFIG[status];
          const isActive = status === currentStatus;
          return (
            <DropdownMenuItem
              key={status}
              onClick={(e) => {
                e.stopPropagation();
                if (!isActive) onStatusChange(status);
              }}
              className="flex items-center gap-2"
            >
              <WorkflowStatusIcon status={status} size={14} />
              <span className={isActive ? "font-medium" : undefined}>{config.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
