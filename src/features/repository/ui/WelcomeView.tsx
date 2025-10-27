import { useState } from "react";
import { FolderPlus, Github, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Workspace } from "@/shared/types";

interface WelcomeViewProps {
  recentWorkspaces?: Workspace[];
  isLoading?: boolean;
  onCreateWorkspace?: () => void;
  onOpenProject?: () => void;
  onCloneRepository?: () => void;
  onWorkspaceClick?: (workspace: Workspace) => void;
}

function getStateBadgeVariant(state: string): "ready" | "working" | "secondary" | "default" {
  switch (state) {
    case 'ready':
      return 'ready';
    case 'initializing':
      return 'working';
    case 'archived':
      return 'secondary';
    default:
      return 'default';
  }
}

/**
 * WelcomeView - Dashboard welcome screen when no workspace is selected
 * Cursor-style layout: action buttons at top, recent workspaces below
 * Following design inspiration from Cursor, Linear, Vercel
 */
export function WelcomeView({
  recentWorkspaces = [],
  isLoading = false,
  onCreateWorkspace,
  onOpenProject,
  onCloneRepository,
  onWorkspaceClick,
}: WelcomeViewProps) {
  const [showAll, setShowAll] = useState(false);
  const initialCount = 6;
  const displayedWorkspaces = showAll ? recentWorkspaces : recentWorkspaces.slice(0, initialCount);
  const hasMore = recentWorkspaces.length > initialCount;

  return (
    <div className="flex flex-col flex-1 min-h-0 transition-colors duration-200">
      {/* Centered action cards with title - better proportions */}
      <div className="flex items-center justify-center px-6 pt-16 pb-8">
        <div className="w-full max-w-md">
          {/* More prominent centered title */}
          <h2 className="text-base font-semibold text-center text-foreground mb-6">Get started</h2>

          {/* Action cards - more square proportions */}
          <div className="grid grid-cols-2 gap-4">
            <Card
              role="button"
              tabIndex={0}
              className="p-5 flex flex-col items-center text-center gap-3 hover:bg-sidebar-accent/40 cursor-pointer transition-[background-color,border-color] duration-200 ease-out hover:border-primary/20 group"
              onClick={onOpenProject}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpenProject?.()}
            >
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:scale-105 transition-transform duration-200 ease-out">
                <FolderPlus className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground text-sm mb-1">Open Project</h3>
                <p className="text-xs text-muted-foreground leading-snug">From your local machine</p>
              </div>
            </Card>

            <Card
              role="button"
              tabIndex={0}
              className="p-5 flex flex-col items-center text-center gap-3 hover:bg-sidebar-accent/40 cursor-pointer transition-[background-color,border-color] duration-200 ease-out hover:border-primary/20 group"
              onClick={onCloneRepository}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onCloneRepository?.()}
            >
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:scale-105 transition-transform duration-200 ease-out">
                <Github className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground text-sm mb-1">Clone Repository</h3>
                <p className="text-xs text-muted-foreground leading-snug">From GitHub</p>
              </div>
            </Card>
          </div>
        </div>
      </div>

      {/* Recent Workspaces Header - Better spacing */}
      <div className="flex-shrink-0 border-t border-border/40 transition-colors duration-200">
        <div className="max-w-4xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Recent Workspaces</h2>
            {recentWorkspaces.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCreateWorkspace}
                className="gap-1.5 h-7 px-2"
              >
                <Plus className="w-3.5 h-3.5" />
                <span className="text-xs">Create</span>
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Workspace Items - Better balanced spacing */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-4xl mx-auto px-6 pb-6">
          {isLoading ? (
            <div className="space-y-px">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between px-2 py-1.5">
                  <div className="flex-1 min-w-0">
                    <Skeleton className="h-4 w-48 mb-2" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-5 w-16 ml-2 flex-shrink-0" />
                </div>
              ))}
            </div>
          ) : recentWorkspaces.length > 0 ? (
            <>
              <div className="space-y-px">
                {displayedWorkspaces.map((workspace) => (
                  <div
                    key={workspace.id}
                    className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-sidebar-accent/60 cursor-pointer transition-[background-color,color] duration-200 ease-out group"
                    onClick={() => onWorkspaceClick?.(workspace)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground group-hover:text-primary transition-colors duration-200 ease-out">
                        {workspace.branch || workspace.directory_name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {workspace.repo_name || 'Unknown Repository'}
                      </div>
                    </div>
                    <Badge variant={getStateBadgeVariant(workspace.state)} className="ml-2 flex-shrink-0">
                      {workspace.state}
                    </Badge>
                  </div>
                ))}
              </div>

              {hasMore && !showAll && (
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAll(true)}
                    className="text-xs text-muted-foreground hover:text-foreground h-7"
                  >
                    Load more ({recentWorkspaces.length - initialCount} more)
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-full bg-muted/20 flex items-center justify-center mb-3">
                <FolderPlus className="w-6 h-6 text-muted-foreground/50" />
              </div>
              <p className="text-xs text-muted-foreground mb-3">No workspaces yet</p>
              <Button
                variant="default"
                onClick={onCreateWorkspace}
                className="gap-1.5 h-8 text-xs"
                size="sm"
              >
                <Plus className="w-3.5 h-3.5" />
                Create Your First Workspace
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
