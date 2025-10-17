import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { WorkspaceItem } from "./WorkspaceItem";
import type { RepoGroup as RepoGroupType, Workspace, DiffStats } from "../../../types";

interface RepoGroupProps {
  group: RepoGroupType;
  isCollapsed: boolean;
  selectedWorkspaceId: string | null;
  diffStats: Record<string, DiffStats>;
  onToggleCollapse: () => void;
  onWorkspaceClick: (workspace: Workspace) => void;
}

/**
 * Repository group in sidebar using shadcn Sidebar + Collapsible components
 * Shows repository name with collapsible workspace list
 */
export function RepoGroup({
  group,
  isCollapsed,
  selectedWorkspaceId,
  diffStats,
  onToggleCollapse,
  onWorkspaceClick,
}: RepoGroupProps) {
  // Filter to only show ready workspaces in sidebar
  const readyWorkspaces = group.workspaces.filter((w) => w.state === 'ready');

  // Only show repos that have ready workspaces
  if (readyWorkspaces.length === 0) {
    return null;
  }

  return (
    <SidebarGroup>
      <Collapsible open={!isCollapsed} onOpenChange={onToggleCollapse}>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-2 py-1 text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground rounded-md transition-colors duration-200">
            <ChevronDown
              className={`h-4 w-4 transition-transform duration-200 ${
                isCollapsed ? '-rotate-90' : ''
              }`}
            />
            <span className="flex-1 text-left">{group.repo_name}</span>
            <span className="text-xs text-muted-foreground">
              {readyWorkspaces.length}
            </span>
          </CollapsibleTrigger>
        </SidebarGroupLabel>

        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {readyWorkspaces.map((workspace) => (
                <WorkspaceItem
                  key={workspace.id}
                  workspace={workspace}
                  diffStats={diffStats[workspace.id]}
                  isActive={selectedWorkspaceId === workspace.id}
                  onClick={() => onWorkspaceClick(workspace)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}
