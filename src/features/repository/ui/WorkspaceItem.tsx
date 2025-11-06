import { SidebarMenuItem, SidebarMenuButton } from "@/components/ui/sidebar";
import { formatTimeAgo } from "@/shared/lib/formatters";
import type { Workspace, DiffStats } from "@/shared/types";

interface WorkspaceItemProps {
  workspace: Workspace;
  diffStats?: DiffStats;
  isActive: boolean;
  onClick: () => void;
}

/**
 * Individual workspace list item in sidebar using shadcn SidebarMenuItem
 * Shows branch name, diff stats, and last updated time
 */
export function WorkspaceItem({ workspace, diffStats, isActive, onClick }: WorkspaceItemProps) {
  const hasDiff = diffStats && (diffStats.additions > 0 || diffStats.deletions > 0);
  const timeAgo = formatTimeAgo(workspace.updated_at);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={onClick}
        className="flex items-start gap-2 px-2 py-2"
      >
        <span className="mt-0.5 flex-shrink-0 text-base">🌿</span>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium">{workspace.branch}</span>
            {hasDiff && (
              <div className="flex flex-shrink-0 gap-1 font-mono text-xs">
                {diffStats.additions > 0 && (
                  <span className="text-success bg-success/10 border-success/30 rounded border px-1.5 py-0.5">
                    +{diffStats.additions}
                  </span>
                )}
                {diffStats.deletions > 0 && (
                  <span className="text-destructive bg-destructive/10 border-destructive/20 rounded border px-1.5 py-0.5">
                    -{diffStats.deletions}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="text-muted-foreground flex items-center gap-1 text-xs">
            {workspace.session_status === "working" ? (
              <span className="text-primary">Working...</span>
            ) : (
              <>
                <span className="truncate">{workspace.directory_name}</span>
                <span>•</span>
                <span>{timeAgo}</span>
              </>
            )}
          </div>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
