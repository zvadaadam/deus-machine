import { useMemo, useState } from "react";
import { CheckCircle, XCircle, Clock, Minus, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspacesByRepo, useRetrySetup } from "@/features/workspace/api/workspace.queries";
import type { SetupStatus } from "@shared/types/workspace";

const SETUP_STATUS_CONFIG: Record<SetupStatus, { icon: typeof CheckCircle; label: string; className: string }> = {
  completed: { icon: CheckCircle, label: "Setup completed", className: "text-success" },
  failed: { icon: XCircle, label: "Setup failed", className: "text-destructive" },
  running: { icon: Clock, label: "Setup running...", className: "text-warning" },
  none: { icon: Minus, label: "No setup configured", className: "text-muted-foreground" },
};

interface WorkspaceStatusDashboardProps {
  repoId: string | null;
}

export function WorkspaceStatusDashboard({ repoId }: WorkspaceStatusDashboardProps) {
  const { data: repoGroups } = useWorkspacesByRepo();
  const retryMutation = useRetrySetup();
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const workspaces = useMemo(() => {
    if (!repoId || !repoGroups) return [];
    const group = repoGroups.find((g) => g.repo_id === repoId);
    return group?.workspaces ?? [];
  }, [repoId, repoGroups]);

  if (workspaces.length === 0) {
    return (
      <div className="space-y-2">
        <Label className="text-sm">Workspace status</Label>
        <p className="text-muted-foreground text-base">No active workspaces for this repository.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Label className="text-sm">Workspace status</Label>
      <div className="space-y-1.5">
        {workspaces.map((ws) => {
          const config = SETUP_STATUS_CONFIG[ws.setup_status as SetupStatus] ?? SETUP_STATUS_CONFIG.none;
          const StatusIcon = config.icon;
          const isFailed = ws.setup_status === "failed";
          const isRunning = ws.setup_status === "running";

          return (
            <div key={ws.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm">
              {isRunning ? (
                <Loader2 className="text-warning size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
              ) : (
                <StatusIcon className={`size-3.5 shrink-0 ${config.className}`} />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">
                {ws.display_name || ws.directory_name}
              </span>
              <span className={`shrink-0 text-xs ${config.className}`}>{config.label}</span>
              {isFailed && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRetryingId(ws.id);
                        retryMutation.mutate(ws.id, {
                          onSettled: () => setRetryingId(null),
                        });
                      }}
                      disabled={retryMutation.isPending && retryingId === ws.id}
                      className="h-6 w-6 p-0"
                    >
                      {retryMutation.isPending && retryingId === ws.id ? (
                        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
                      ) : (
                        <RotateCw className="size-3" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Retry setup</TooltipContent>
                </Tooltip>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
