import { SidebarMenuItem, SidebarMenuButton } from "@/components/ui/sidebar";
import { formatTimeAgo } from "../../../utils";
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
export function WorkspaceItem({
  workspace,
  diffStats,
  isActive,
  onClick,
}: WorkspaceItemProps) {
  const hasDiff = diffStats && (diffStats.additions > 0 || diffStats.deletions > 0);
  const timeAgo = formatTimeAgo(workspace.updated_at);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={onClick}
        className="flex items-start gap-2 py-2 px-2"
      >
        <span className="text-base flex-shrink-0 mt-0.5">🌿</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2 mb-0.5">
            <span className="text-body-sm font-medium truncate">
              {workspace.branch}
            </span>
            {hasDiff && (
              <div className="flex gap-1 text-caption font-mono flex-shrink-0">
                {diffStats.additions > 0 && (
                  <span className="text-success bg-success/10 px-1.5 py-0.5 rounded border border-success/30">
                    +{diffStats.additions}
                  </span>
                )}
                {diffStats.deletions > 0 && (
                  <span className="text-destructive bg-destructive/10 px-1.5 py-0.5 rounded border border-destructive/20">
                    -{diffStats.deletions}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center text-caption text-muted-foreground gap-1">
            {workspace.session_status === 'working' ? (
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
