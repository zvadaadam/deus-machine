import { useState } from "react";
import { FolderPlus, Github, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/shared/lib/utils";
import type { Workspace } from "@/shared/types";

interface WelcomeViewProps {
  recentWorkspaces?: Workspace[];
  isLoading?: boolean;
  onCreateWorkspace?: () => void;
  onOpenProject?: () => void;
  onCloneRepository?: () => void;
  onWorkspaceClick?: (workspace: Workspace) => void;
}

/**
 * WelcomeView - Minimalist dashboard welcome screen
 * Design philosophy: Ruthless simplification, unified visual spine, subtle interactions
 * One consistent width column, no borders, clear hierarchy, refined details
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
    <div className="relative flex flex-col flex-1 min-h-0">
      {/* Unified scroll - everything flows together */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="flex flex-col items-center py-16">
          <div className="w-full max-w-2xl px-6 space-y-12">
            {/* Action cards - clean, simple, breathing room */}
            <div className="grid grid-cols-2 gap-4">
          <Card
            role="button"
            tabIndex={0}
            className="p-6 flex flex-col items-center text-center gap-2.5 hover:bg-sidebar-accent/30 cursor-pointer transition-colors duration-300 border-border/60 group"
            onClick={onOpenProject}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpenProject?.()}
          >
            <div className="w-9 h-9 rounded-lg bg-foreground/5 flex items-center justify-center text-foreground/80">
              <FolderPlus className="w-4.5 h-4.5" />
            </div>
            <div>
              <h3 className="font-medium text-sm text-foreground mb-0.5">Open Project</h3>
              <p className="text-xs text-muted-foreground/70">From your local machine</p>
            </div>
          </Card>

          <Card
            role="button"
            tabIndex={0}
            className="p-6 flex flex-col items-center text-center gap-2.5 hover:bg-sidebar-accent/30 cursor-pointer transition-colors duration-300 border-border/60 group"
            onClick={onCloneRepository}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onCloneRepository?.()}
          >
            <div className="w-9 h-9 rounded-lg bg-foreground/5 flex items-center justify-center text-foreground/80">
              <Github className="w-4.5 h-4.5" />
            </div>
            <div>
              <h3 className="font-medium text-sm text-foreground mb-0.5">Clone Repository</h3>
              <p className="text-xs text-muted-foreground/70">From GitHub</p>
            </div>
          </Card>
        </div>

            {/* Recent Workspaces - no border, trust the space */}
            <div className="space-y-4">
            <div className="flex items-baseline justify-between px-2">
              <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Recent Workspaces</h2>
              {recentWorkspaces.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCreateWorkspace}
                  className="hover:bg-sidebar-accent/40 -mr-2"
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>

            {/* Workspace items - clean, minimal, subtle state */}
            {isLoading ? (
            <div className="space-y-0.5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between px-2 py-2.5">
                  <div className="flex-1 min-w-0">
                    <Skeleton className="h-3.5 w-48 mb-2 bg-muted/20" />
                    <Skeleton className="h-3 w-32 bg-muted/15" />
                  </div>
                  <Skeleton className="h-3 w-12 ml-4 flex-shrink-0 bg-muted/20" />
                </div>
              ))}
            </div>
          ) : recentWorkspaces.length > 0 ? (
            <>
              <div className="space-y-0.5">
                {displayedWorkspaces.map((workspace) => (
                  <div
                    key={workspace.id}
                    className="flex items-center justify-between px-2 py-2.5 rounded-md hover:bg-sidebar-accent/40 cursor-pointer transition-colors duration-200 group"
                    onClick={() => onWorkspaceClick?.(workspace)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground group-hover:text-foreground/90">
                        {workspace.branch || workspace.directory_name}
                      </div>
                      <div className="text-xs text-muted-foreground/50 truncate mt-0.5">
                        {workspace.repo_name || 'Unknown Repository'}
                      </div>
                    </div>
                    {/* Subtle state indicator - no bright badges, just refined text */}
                    <div className={cn(
                      "text-xs font-medium ml-4 flex-shrink-0 transition-opacity duration-200",
                      workspace.state === 'ready' && "text-green-600/60 dark:text-green-400/50",
                      workspace.state === 'initializing' && "text-blue-600/60 dark:text-blue-400/50",
                      workspace.state === 'archived' && "text-muted-foreground/40",
                      !['ready', 'initializing', 'archived'].includes(workspace.state) && "text-muted-foreground/50"
                    )}>
                      {workspace.state}
                    </div>
                  </div>
                ))}
              </div>

              {hasMore && !showAll && (
                <div className="flex justify-center pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAll(true)}
                    className="text-xs text-muted-foreground/60 hover:text-foreground hover:bg-sidebar-accent/40 h-7"
                  >
                    Show {recentWorkspaces.length - initialCount} more
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-10 h-10 rounded-full bg-muted/10 flex items-center justify-center mb-3">
                <FolderPlus className="w-5 h-5 text-muted-foreground/40" />
              </div>
              <p className="text-xs text-muted-foreground/60 mb-3">No workspaces yet</p>
              <Button
                variant="default"
                onClick={onCreateWorkspace}
                className="gap-1.5 h-8 text-xs"
                size="sm"
              >
                <Plus className="w-3.5 h-3.5" />
                Create Workspace
              </Button>
              </div>
            )}
            </div>
          </div>
        </div>
      </div>

      {/* Subtle fade gradient at bottom - whispers "there's more" */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-background to-transparent opacity-60" />
    </div>
  );
}
