import { FolderPlus, Github, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Workspace } from "@/types";

interface WelcomeViewProps {
  recentWorkspaces?: Workspace[];
  onCreateWorkspace?: () => void;
  onAddRepository?: () => void;
  onCloneRepository?: () => void;
  onWorkspaceClick?: (workspace: Workspace) => void;
}

/**
 * WelcomeView - Dashboard welcome screen when no workspace is selected
 * Cursor-style layout: action buttons at top, recent workspaces below
 * Following design inspiration from Cursor, Linear, Vercel
 */
export function WelcomeView({
  recentWorkspaces = [],
  onCreateWorkspace,
  onAddRepository,
  onCloneRepository,
  onWorkspaceClick,
}: WelcomeViewProps) {
  return (
    <div className="h-full flex flex-col p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground mb-1">Welcome to OpenDevs</h1>
        <p className="text-body-sm text-muted-foreground">
          Get started by adding a repository or creating a workspace
        </p>
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-4 mb-10">
        <Card
          className="p-5 flex items-center gap-4 hover:bg-sidebar-accent/40 cursor-pointer transition-all duration-200 border-2 hover:border-primary/20 group"
          onClick={onAddRepository}
        >
          <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:scale-105 transition-transform duration-200">
            <FolderPlus className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-foreground mb-0.5">Add Repository</h3>
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

      {/* Recent Workspaces */}
      <div className="flex-1">
        <div className="flex items-center justify-between mb-4">
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

        {recentWorkspaces.length > 0 ? (
          <div className="space-y-2">
            {recentWorkspaces.slice(0, 10).map((workspace) => (
              <div
                key={workspace.id}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-sidebar-accent/60 cursor-pointer transition-all duration-200 group"
                onClick={() => onWorkspaceClick?.(workspace)}
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground group-hover:text-primary transition-colors">
                    {workspace.directory_name}
                  </div>
                  <div className="text-body-sm text-muted-foreground truncate font-mono">
                    {workspace.root_path ? `${workspace.root_path}/.conductor` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
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
  );
}
