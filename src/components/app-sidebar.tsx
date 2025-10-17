import { PanelLeftClose, PanelLeftOpen, GitBranch, ChevronDown, Settings, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores";
import type { Workspace, DiffStats } from "@/types";

interface Repository {
  repo_id: string;
  repo_name: string;
  workspaces: Workspace[];
}

interface AppSidebarProps {
  repositories: Repository[];
  selectedWorkspaceId: string | null;
  diffStats: Record<string, DiffStats>;
  onWorkspaceClick: (workspace: Workspace) => void;
  onNewWorkspace: (repoId?: string) => void;
  profile?: {
    username: string;
    email?: string;
  };
}

export function AppSidebar({
  repositories,
  selectedWorkspaceId,
  diffStats,
  onWorkspaceClick,
  onNewWorkspace,
  profile = { username: "User" },
}: AppSidebarProps) {
  const navigate = useNavigate();
  const { state, toggleSidebar } = useSidebar();
  const { collapsedRepos, toggleRepoCollapse } = useUIStore();

  const isExpanded = state === "expanded";

  return (
    <Sidebar variant="floating" collapsible="icon">
      {/* Header with Profile and Collapse Button */}
      <SidebarHeader className="border-b border-sidebar-border p-4">
        <div className="flex items-center justify-between w-full">
          {isExpanded ? (
            <>
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Avatar className="h-8 w-8 flex-shrink-0">
                  <AvatarFallback className="text-xs">
                    {profile.username.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{profile.username}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleSidebar}
                className="h-8 w-8 flex-shrink-0"
                title="Collapse sidebar"
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              className="h-8 w-8 mx-auto"
              title="Expand sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          )}
        </div>
      </SidebarHeader>

      {/* Repositories List */}
      <SidebarContent>
        <ScrollArea className="flex-1">
          <SidebarMenu className="p-2">
            {repositories.map((repo) => (
              <RepositoryItem
                key={repo.repo_id}
                repository={repo}
                isCollapsed={collapsedRepos.has(repo.repo_id)}
                selectedWorkspaceId={selectedWorkspaceId}
                diffStats={diffStats}
                onToggleCollapse={() => toggleRepoCollapse(repo.repo_id)}
                onWorkspaceClick={onWorkspaceClick}
                onNewWorkspace={onNewWorkspace}
                sidebarExpanded={isExpanded}
              />
            ))}
          </SidebarMenu>
        </ScrollArea>
      </SidebarContent>

      {/* Footer with Settings */}
      <SidebarFooter className="border-t border-sidebar-border p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => navigate("/settings")}
              tooltip={!isExpanded ? "Settings" : undefined}
            >
              <Settings className="h-4 w-4" />
              {isExpanded && <span>Settings</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

interface RepositoryItemProps {
  repository: Repository;
  isCollapsed: boolean;
  selectedWorkspaceId: string | null;
  diffStats: Record<string, DiffStats>;
  onToggleCollapse: () => void;
  onWorkspaceClick: (workspace: Workspace) => void;
  onNewWorkspace: (repoId?: string) => void;
  sidebarExpanded: boolean;
}

function RepositoryItem({
  repository,
  isCollapsed,
  selectedWorkspaceId,
  diffStats,
  onToggleCollapse,
  onWorkspaceClick,
  onNewWorkspace,
  sidebarExpanded,
}: RepositoryItemProps) {
  return (
    <Collapsible open={!isCollapsed} onOpenChange={onToggleCollapse}>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            className="w-full px-3 py-5"
            tooltip={!sidebarExpanded ? repository.repo_name : undefined}
          >
            <div className="flex items-center justify-between w-full">
              {sidebarExpanded && (
                <span className="text-sm font-medium truncate">
                  {repository.repo_name}
                </span>
              )}
              {sidebarExpanded && (
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-sidebar-foreground/50 transition-transform duration-200 flex-shrink-0",
                    isCollapsed && "-rotate-90"
                  )}
                  style={{ transition: "transform 200ms cubic-bezier(.165, .84, .44, 1)" }}
                />
              )}
            </div>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub className="border-l-0 ml-0 px-0">
            {/* New Workspace Button - At Top, Compact Height */}
            {sidebarExpanded && (
              <SidebarMenuSubItem className="mb-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNewWorkspace(repository.repo_id)}
                  className={cn(
                    "w-full h-8 px-3 -translate-x-px",
                    "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50",
                    "transition-all duration-200"
                  )}
                >
                  <div className="flex items-center gap-3 w-full">
                    <Plus className="h-4 w-4 flex-shrink-0" />
                    <span className="text-sm">New Workspace</span>
                  </div>
                </Button>
              </SidebarMenuSubItem>
            )}

            {repository.workspaces.map((workspace) => (
              <WorkspaceItem
                key={workspace.id}
                workspace={workspace}
                isActive={workspace.id === selectedWorkspaceId}
                diffStats={diffStats[workspace.id]}
                onClick={() => onWorkspaceClick(workspace)}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

interface WorkspaceItemProps {
  workspace: Workspace;
  isActive: boolean;
  diffStats?: DiffStats;
  onClick: () => void;
}

function WorkspaceItem({ workspace, isActive, diffStats, onClick }: WorkspaceItemProps) {
  const getStatusText = (status: string | null | undefined) => {
    if (!status) return "Archived";
    return status.charAt(0).toUpperCase() + status.slice(1);
  };

  const getStatusTextColor = (status: string | null | undefined) => {
    switch (status) {
      case "working":
        return "text-blue-500";
      case "idle":
        return "text-green-500";
      case "compacting":
        return "text-yellow-500";
      default:
        return "text-muted-foreground/70";
    }
  };

  const shouldShimmer = (status: string | null | undefined) => {
    return status === "working" || status === "compacting";
  };

  const hasChanges = diffStats && (diffStats.additions > 0 || diffStats.deletions > 0);

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        onClick={onClick}
        isActive={isActive}
        className={cn(
          "relative py-3 px-3 min-h-[56px]",
          isActive && "bg-sidebar-accent"
        )}
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <GitBranch
            className={cn(
              "h-4 w-4 flex-shrink-0",
              workspace.session_status ? "text-green-500/60" : "text-sidebar-foreground/60"
            )}
          />
          <div className="flex flex-col flex-1 min-w-0 gap-0.5">
            {/* Branch name on top */}
            <span className="text-sm font-medium truncate">
              {workspace.branch}
            </span>
            {/* Directory name and status on bottom */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground truncate">
                {workspace.directory_name}
              </span>
              <span
                className={cn(
                  "text-xs flex-shrink-0",
                  getStatusTextColor(workspace.session_status),
                  shouldShimmer(workspace.session_status) && "animate-shimmer"
                )}
              >
                • {getStatusText(workspace.session_status)}
              </span>
            </div>
          </div>
          {hasChanges && (
            <div className="flex items-center gap-1 text-[10px] flex-shrink-0">
              {diffStats.additions > 0 && <span className="text-green-500">+{diffStats.additions}</span>}
              {diffStats.deletions > 0 && <span className="text-red-500">-{diffStats.deletions}</span>}
            </div>
          )}
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
