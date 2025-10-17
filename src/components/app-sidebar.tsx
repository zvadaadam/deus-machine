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
import { TextShimmer } from "@/components/ui/text-shimmer";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores";
import type { Workspace, DiffStats } from "@/types";

// Helper function to get initials from repository name
function getRepoInitials(repoName: string): string {
  const parts = repoName.split(/[-_\s]/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return repoName.slice(0, 2).toUpperCase();
}

// Helper function to generate consistent color from string
function getRepoColor(repoName: string): { bg: string; text: string } {
  const colors = [
    { bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400' },
    { bg: 'bg-purple-500/10', text: 'text-purple-600 dark:text-purple-400' },
    { bg: 'bg-pink-500/10', text: 'text-pink-600 dark:text-pink-400' },
    { bg: 'bg-green-500/10', text: 'text-green-600 dark:text-green-400' },
    { bg: 'bg-yellow-500/10', text: 'text-yellow-600 dark:text-yellow-400' },
    { bg: 'bg-orange-500/10', text: 'text-orange-600 dark:text-orange-400' },
    { bg: 'bg-red-500/10', text: 'text-red-600 dark:text-red-400' },
    { bg: 'bg-cyan-500/10', text: 'text-cyan-600 dark:text-cyan-400' },
    { bg: 'bg-indigo-500/10', text: 'text-indigo-600 dark:text-indigo-400' },
    { bg: 'bg-teal-500/10', text: 'text-teal-600 dark:text-teal-400' },
  ];
  let hash = 0;
  for (let i = 0; i < repoName.length; i++) {
    hash = repoName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

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
          <SidebarMenu className="py-2 px-2">
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
  const hasRunningWorkspace = repository.workspaces.some(
    (ws) => ws.session_status === "working"
  );

  return (
    <Collapsible open={!isCollapsed} onOpenChange={onToggleCollapse}>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            className={cn("w-full", sidebarExpanded ? "px-3 py-5" : "px-0 py-6")}
            tooltip={!sidebarExpanded ? repository.repo_name : undefined}
          >
            <div className={cn("flex items-center w-full", sidebarExpanded ? "justify-between" : "justify-center")}>
              {!sidebarExpanded && (
                <div className="relative">
                  {(() => {
                    const repoColor = getRepoColor(repository.repo_name);
                    return (
                      <div className={cn(
                        "h-9 w-9 flex items-center justify-center text-xs font-semibold",
                        "rounded-[8px]",
                        repoColor.bg,
                        repoColor.text
                      )}>
                        {getRepoInitials(repository.repo_name)}
                      </div>
                    );
                  })()}
                  {hasRunningWorkspace && (
                    <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
                    </span>
                  )}
                </div>
              )}
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
          <SidebarMenuSub className="border-l-0 mx-0 px-0">
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
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    return `${diffDays}d`;
  };

  const getStatusText = (status: string | null | undefined) => {
    if (!status) return "Archived";
    if (status === "idle") return formatTime(workspace.updated_at);
    const capitalized = status.charAt(0).toUpperCase() + status.slice(1);
    return shouldShimmer(status) ? `${capitalized}...` : capitalized;
  };

  const getStatusTextColor = (status: string | null | undefined) => {
    switch (status) {
      case "working":
        return "text-blue-500";
      case "idle":
        return "text-muted-foreground/70";
      case "compacting":
        return "text-yellow-500";
      default:
        return "text-rose-400";
    }
  };

  const shouldShimmer = (status: string | null | undefined) => {
    return status === "working" || status === "compacting";
  };

  const hasChanges = diffStats && (diffStats.additions > 0 || diffStats.deletions > 0);

  return (
    <SidebarMenuSubItem>
      <div className="grid grid-cols-[1fr_auto] items-center gap-2 py-3 px-2 min-h-[56px] rounded-md hover:bg-sidebar-accent cursor-pointer" onClick={onClick}>
        <div className="flex items-center gap-3 min-w-0 overflow-hidden">
          <GitBranch
            className={cn(
              "h-4 w-4 flex-shrink-0",
              workspace.session_status ? "text-green-500/60" : "text-sidebar-foreground/60"
            )}
          />
          <div className="flex flex-col min-w-0 gap-0.5">
            {/* Branch name on top */}
            <span className="text-sm font-medium truncate">
              {workspace.branch}
            </span>
            {/* Directory name and status on bottom */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs text-muted-foreground truncate">
                {workspace.directory_name}
              </span>
              <span className="text-xs text-muted-foreground/70 flex-shrink-0">•</span>
              {shouldShimmer(workspace.session_status) ? (
                <TextShimmer
                  as="span"
                  duration={2}
                  className={cn(
                    "text-xs flex-shrink-0",
                    workspace.session_status === "working"
                      ? "[--base-color:theme(colors.blue.600)] [--base-gradient-color:theme(colors.blue.200)] dark:[--base-color:theme(colors.blue.700)] dark:[--base-gradient-color:theme(colors.blue.400)]"
                      : "[--base-color:theme(colors.yellow.600)] [--base-gradient-color:theme(colors.yellow.200)] dark:[--base-color:theme(colors.yellow.700)] dark:[--base-gradient-color:theme(colors.yellow.400)]"
                  )}
                >
                  {getStatusText(workspace.session_status)}
                </TextShimmer>
              ) : (
                <span
                  className={cn(
                    "text-xs flex-shrink-0",
                    getStatusTextColor(workspace.session_status)
                  )}
                >
                  {getStatusText(workspace.session_status)}
                </span>
              )}
            </div>
          </div>
        </div>
        {hasChanges && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {diffStats.additions > 0 && (
              <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium border border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400 whitespace-nowrap">
                +{diffStats.additions}
              </span>
            )}
            {diffStats.deletions > 0 && (
              <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 whitespace-nowrap">
                -{diffStats.deletions}
              </span>
            )}
          </div>
        )}
      </div>
    </SidebarMenuSubItem>
  );
}
