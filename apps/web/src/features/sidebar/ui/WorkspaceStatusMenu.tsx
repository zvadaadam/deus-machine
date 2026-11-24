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

export function WorkspaceStatusChoices({
  Item = DropdownMenuItem,
  currentStatus,
  onStatusChange,
}: Omit<WorkspaceStatusMenuProps, "children"> & { Item?: typeof DropdownMenuItem }) {
  return WORKFLOW_STATUSES.map((status) => (
    <Item
      key={status}
      onSelect={() => {
        if (status !== currentStatus) onStatusChange(status);
      }}
    >
      <span aria-hidden="true">
        <WorkflowStatusIcon status={status} />
      </span>
      <span className={status === currentStatus ? "font-medium" : undefined}>
        {WORKFLOW_STATUS_CONFIG[status].label}
      </span>
    </Item>
  ));
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
        <WorkspaceStatusChoices currentStatus={currentStatus} onStatusChange={onStatusChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
