import { useState } from "react";
import { FolderPlus, Github, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Workspace } from "@/types";

interface WelcomeViewProps {
  recentWorkspaces?: Workspace[];
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
    <div className="h-full flex flex-col overflow-hidden">
      {/* Top Section - Fixed */}
      <div className="flex-shrink-0 p-8 max-w-4xl mx-auto w-full">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground mb-1">Welcome to OpenDevs</h1>
          <p className="text-body-sm text-muted-foreground">
            Get started by opening a project or cloning a repository
          </p>
        </div>

        {/* Action Buttons */}
        <div className="grid grid-cols-2 gap-4 mb-10">
        <Card
          className="p-5 flex items-center gap-4 hover:bg-sidebar-accent/40 cursor-pointer transition-all duration-200 border-2 hover:border-primary/20 group"
          onClick={onOpenProject}
        >
          <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:scale-105 transition-transform duration-200">
            <FolderPlus className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-foreground mb-0.5">Open Project</h3>
            <p className="text-body-sm text-muted-foreground">From your local machine</p>
          </div>
        </Card>

        <Card
          className="p-5 flex items-center gap-4 hover:bg-sidebar-accent/40 cursor-pointer transition-all duration-200 border-2 hover:border-primary/20 group"
          onClick={onCloneRepository}
        >
          <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:scale-105 transition-transform duration-200">
            <Github className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-foreground mb-0.5">Clone Repository</h3>
            <p className="text-body-sm text-muted-foreground">From GitHub</p>
          </div>
        </Card>
      </div>
      </div>

      {/* Recent Workspaces Header - Fixed */}
      <div className="flex-shrink-0 border-t border-border/40">
        <div className="max-w-4xl mx-auto px-8 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-body font-semibold text-muted-foreground">Recent Workspaces</h2>
            {recentWorkspaces.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCreateWorkspace}
                className="gap-2"
              >
                <Plus className="w-4 h-4" />
                Create Workspace
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Workspace Items - Scrollable Only */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-4xl mx-auto px-8 pb-8">
          {recentWorkspaces.length > 0 ? (
            <>
              <div className="space-y-1">
                {displayedWorkspaces.map((workspace) => (
                  <div
                    key={workspace.id}
                    className="flex items-center justify-between p-3 rounded-lg hover:bg-sidebar-accent/60 cursor-pointer transition-all duration-200 group"
                    onClick={() => onWorkspaceClick?.(workspace)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-foreground group-hover:text-primary transition-colors">
                        {workspace.branch || workspace.directory_name}
                      </div>
                      <div className="text-body-sm text-muted-foreground truncate">
                        {workspace.repo_name || 'Unknown Repository'}
                      </div>
                    </div>
                    <Badge variant={getStateBadgeVariant(workspace.state)} className="ml-3 flex-shrink-0">
                      {workspace.state}
                    </Badge>
                  </div>
                ))}
              </div>

              {hasMore && !showAll && (
                <div className="mt-4 flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAll(true)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Load more ({recentWorkspaces.length - initialCount} more)
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 rounded-full bg-muted/20 flex items-center justify-center mb-4">
                <FolderPlus className="w-8 h-8 text-muted-foreground/50" />
              </div>
              <p className="text-body text-muted-foreground mb-4">No workspaces yet</p>
              <Button
                variant="default"
                onClick={onCreateWorkspace}
                className="gap-2"
              >
                <Plus className="w-4 h-4" />
                Create Your First Workspace
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
