import { useMemo } from "react";
import { cn } from "@/shared/lib/utils";
import type { Workspace } from "@/shared/types";
import { workspaceStart } from "@/features/workspace/lib/startState";
import { localFolder } from "@/features/workspace/lib/reach";
import { useWorkspaceStartStore } from "@/features/workspace/store/workspaceStartStore";
import { SessionProvider } from "../context";
import { createOptimisticUserMessage } from "../lib/optimisticMessage";
import type { Message } from "../types";
import { MessageItem } from "./MessageItem";
import { WorkspaceStartComposer } from "./WorkspaceStartComposer";
import { WorkspaceStartGroup } from "./WorkspaceStartGroup";

const NO_SUBAGENTS = new Map<string, Message[]>();

interface WorkspaceStartStateProps {
  workspace: Workspace;
  className?: string;
}

/**
 * Where the chat will be, while the workspace has none yet: it is starting, or
 * it failed to start. Laid out as the transcript it is about to become, in the
 * order it happened: the message that asked for the workspace, as the bubble
 * it will be, then the start's own line under it (WorkspaceStartGroup, the
 * line the chat keeps once it opens). A message typed before the workspace
 * existed is kept, and shown as kept: it sends when the workspace is ready, a
 * retry sends it, deleting offers it back. Under it, the chat's own composer
 * (WorkspaceStartComposer), unless the start failed and cannot be retried.
 */
export function WorkspaceStartState({ workspace, className }: WorkspaceStartStateProps) {
  const start = workspaceStart(workspace);
  const pending = useWorkspaceStartStore((state) => state.pending[workspace.id]);
  // The same message the chat will show once it is sent: text and images alike.
  const waiting = useMemo(
    () =>
      pending &&
      createOptimisticUserMessage({
        sessionId: workspace.id,
        turnId: `waiting-${workspace.id}`,
        content: pending.message,
      }),
    [pending, workspace.id]
  );

  // Nothing typed here could ever be sent to a workspace that cannot be retried.
  const canAsk = start.phase === "starting" || !!start.failure?.recoverable;

  return (
    // The column the chat is (SessionPanel's embedded layout), so the bubble
    // and the composer stay where they are when the chat opens.
    <div
      data-slot="workspace-start-state"
      data-state={start.phase}
      className={cn(
        "relative mx-auto flex min-h-0 w-full max-w-[960px] min-w-0 flex-1 flex-col",
        className
      )}
    >
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 overflow-x-hidden overflow-y-auto px-3 pt-4 md:px-6 md:pt-6">
          <div className="animate-fade-in-up flex w-full min-w-0 flex-col gap-2 pb-8">
            {waiting && (
              <div className="flex flex-col items-end gap-1 pt-8" data-slot="waiting-message">
                <div className="w-full opacity-70">
                  <SessionProvider
                    sessionStatus="idle"
                    workspaceId={workspace.id}
                    workspacePath={localFolder(workspace)}
                    cloud={workspace.kind === "cloud"}
                    subagentMessages={NO_SUBAGENTS}
                  >
                    <MessageItem message={waiting} isLastInTurn />
                  </SessionProvider>
                </div>
                <span className="text-text-muted pr-1 text-xs">
                  {start.phase === "failed"
                    ? start.failure?.recoverable
                      ? "Kept. It sends after a retry."
                      : "Kept."
                    : "Sends when the workspace is ready."}
                </span>
              </div>
            )}

            <div className={cn(waiting && "pt-2")}>
              <WorkspaceStartGroup
                workspaceId={workspace.id}
                repoId={workspace.repository_id}
                start={start}
              />
            </div>
          </div>
        </div>
      </div>

      {canAsk && <WorkspaceStartComposer workspace={workspace} />}
    </div>
  );
}
