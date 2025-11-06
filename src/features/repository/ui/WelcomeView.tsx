import { useState, useEffect, useRef } from "react";
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
  const [showTopFade, setShowTopFade] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const initialCount = 6;
  const displayedWorkspaces = showAll ? recentWorkspaces : recentWorkspaces.slice(0, initialCount);
  const hasMore = recentWorkspaces.length > initialCount;
  const isEmpty = !isLoading && recentWorkspaces.length === 0;

  // Detect scroll to show/hide top fade gradient
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || isEmpty) return;

    const handleScroll = () => {
      const scrolled = scrollContainer.scrollTop > 100;
      setShowTopFade(scrolled);
    };

    scrollContainer.addEventListener("scroll", handleScroll);
    return () => scrollContainer.removeEventListener("scroll", handleScroll);
  }, [isEmpty]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Unified scroll - everything flows together */}
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col items-center py-16">
          <div className="w-full max-w-2xl px-6">
            {/* Empty state: First-time welcome */}
            {isEmpty && (
              <div className="mb-8 flex flex-col items-center text-center">
                <div className="bg-foreground/5 mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
                  <div className="text-foreground/80 text-2xl font-semibold">BOX</div>
                </div>
                <h1 className="text-foreground mb-2 text-lg font-semibold">Welcome to BOX</h1>
                <p className="text-muted-foreground/70 max-w-md text-sm">
                  Run multiple coding tasks at once.
                </p>
                <p className="text-muted-foreground/60 mt-1 max-w-md text-xs">
                  Let AI handle the details while you focus on what matters.
                </p>
              </div>
            )}

            {/* Filled state: Subtle section label */}
            {!isEmpty && (
              <div className="mb-4">
                <h2 className="text-muted-foreground px-2 text-xs font-semibold tracking-wider uppercase">
                  Add Repository
                </h2>
              </div>
            )}

            {/* Action cards */}
            <div className={isEmpty ? "space-y-12" : ""}>
              <div className="grid grid-cols-2 gap-4">
                <Card
                  role="button"
                  tabIndex={0}
                  className="hover:bg-sidebar-accent/30 border-border/60 group flex cursor-pointer flex-col items-center gap-2.5 p-6 text-center transition-colors duration-300"
                  onClick={onOpenProject}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpenProject?.()}
                >
                  <div className="bg-foreground/5 text-foreground/80 flex h-9 w-9 items-center justify-center rounded-lg">
                    <FolderPlus className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="text-foreground mb-0.5 text-sm font-medium">Open Project</h3>
                    <p className="text-muted-foreground/70 text-xs">Work with a local repository</p>
                  </div>
                </Card>

                <Card
                  role="button"
                  tabIndex={0}
                  className="hover:bg-sidebar-accent/30 border-border/60 group flex cursor-pointer flex-col items-center gap-2.5 p-6 text-center transition-colors duration-300"
                  onClick={onCloneRepository}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onCloneRepository?.()}
                >
                  <div className="bg-foreground/5 text-foreground/80 flex h-9 w-9 items-center justify-center rounded-lg">
                    <Github className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="text-foreground mb-0.5 text-sm font-medium">Clone Repository</h3>
                    <p className="text-muted-foreground/70 text-xs">Start from GitHub</p>
                  </div>
                </Card>
              </div>
            </div>

            {/* Recent Workspaces - only show when not empty */}
            {!isEmpty && (
              <div className="mt-12 space-y-4">
                <div className="flex items-baseline justify-between px-2">
                  <h2 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                    Recent Workspaces
                  </h2>
                  {recentWorkspaces.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onCreateWorkspace}
                      className="hover:bg-sidebar-accent/40 -mr-2"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                {/* Workspace items - clean, minimal, subtle state */}
                {isLoading ? (
                  <div className="space-y-0.5">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="flex items-center justify-between px-2 py-2.5">
                        <div className="min-w-0 flex-1">
                          <Skeleton className="bg-muted/20 mb-2 h-3.5 w-48" />
                          <Skeleton className="bg-muted/15 h-3 w-32" />
                        </div>
                        <Skeleton className="bg-muted/20 ml-4 h-3 w-12 flex-shrink-0" />
                      </div>
                    ))}
                  </div>
                ) : recentWorkspaces.length > 0 ? (
                  <>
                    <div className="space-y-0.5">
                      {displayedWorkspaces.map((workspace) => (
                        <div
                          key={workspace.id}
                          className="hover:bg-sidebar-accent/40 group flex cursor-pointer items-center justify-between rounded-md px-2 py-2.5 transition-colors duration-200"
                          onClick={() => onWorkspaceClick?.(workspace)}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-foreground group-hover:text-foreground/90 text-sm font-medium">
                              {workspace.branch || workspace.directory_name}
                            </div>
                            <div className="text-muted-foreground/50 mt-0.5 truncate text-xs">
                              {workspace.repo_name || "Unknown Repository"}
                            </div>
                          </div>
                          {/* Subtle state indicator - no bright badges, just refined text */}
                          <div
                            className={cn(
                              "ml-4 flex-shrink-0 text-xs font-medium transition-opacity duration-200",
                              workspace.state === "ready" && "text-status-working/60",
                              workspace.state === "initializing" && "text-info/60",
                              workspace.state === "archived" && "text-muted-foreground/40",
                              !["ready", "initializing", "archived"].includes(workspace.state) &&
                                "text-muted-foreground/50"
                            )}
                          >
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
                          className="text-muted-foreground/60 hover:text-foreground hover:bg-sidebar-accent/40 h-7 text-xs"
                        >
                          Show {recentWorkspaces.length - initialCount} more
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="bg-muted/10 mb-3 flex h-10 w-10 items-center justify-center rounded-full">
                      <FolderPlus className="text-muted-foreground/40 h-5 w-5" />
                    </div>
                    <p className="text-muted-foreground/60 mb-3 text-xs">No workspaces yet</p>
                    <Button
                      variant="default"
                      onClick={onCreateWorkspace}
                      className="h-8 gap-1.5 text-xs"
                      size="sm"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create Workspace
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Subtle fade gradient at bottom - whispers "there's more" (only when has content) */}
      {!isEmpty && (
        <div className="from-background pointer-events-none absolute right-0 bottom-0 left-0 h-20 bg-gradient-to-t to-transparent opacity-60" />
      )}

      {/* Top fade gradient when scrolled - whispers "there's more above" */}
      {!isEmpty && (
        <div
          className={cn(
            "from-background pointer-events-none absolute top-0 right-0 left-0 h-20 bg-gradient-to-b to-transparent transition-opacity duration-300",
            showTopFade ? "opacity-60" : "opacity-0"
          )}
        />
      )}
    </div>
  );
}
