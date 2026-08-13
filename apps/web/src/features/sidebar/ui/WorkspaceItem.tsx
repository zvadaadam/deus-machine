import React from "react";
import { match } from "ts-pattern";
import { Archive, Loader2 } from "lucide-react";
import NumberFlow from "@number-flow/react";
import { useQueryClient } from "@tanstack/react-query";

import { cn } from "@/shared/lib/utils";
import { formatTimeAgo } from "@/shared/lib/formatters";
import { useWorkingDuration, formatDuration } from "@/shared/hooks";
import { useUnreadStore } from "@/features/session/store/unreadStore";
import { useWorkspaceLayoutStore } from "@/features/workspace/store/workspaceLayoutStore";
import { prefetchWorkspace } from "@/features/workspace/api/prefetch";
import { getDisplayStatus } from "../lib/status";
import { getWorkspaceDisplayName, getWorkspaceSecondaryText } from "../lib/utils";
import type { WorkspaceItemProps } from "../model/types";
import { SidebarRow } from "./SidebarRow";
import { WorkspaceGitIcon } from "./WorkspaceGitIcon";
import { WorkspaceStatusMenu } from "./WorkspaceStatusMenu";

/**
 * WorkspaceItem — single-line sidebar workspace row.
 *
 *   [icon] [name ..............................] [meta]
 *
 * Icon (WorkspaceGitIcon): shape = git/PR lifecycle, color = attention;
 * working/initializing agents show the live pixel grid. Flush left so it
 * aligns with the repo label above.
 *
 * Meta shows the one signal that matters: error → red dot, unread → gold
 * dot, working → live duration, initializing → setup stage, idle → diff
 * stats or relative time. Hover swaps meta for the archive button; the
 * slug hides in the row title attribute.
 */
export const WorkspaceItem = React.memo(function WorkspaceItem({
  workspace,
  isActive,
  diffStats,
  onClick,
  onArchive,
  onStatusChange,
}: WorkspaceItemProps) {
  const isInitializing = workspace.state === "initializing";
  const queryClient = useQueryClient();

  const { duration } = useWorkingDuration({
    status: workspace.session_status,
    latestMessageSentAt: workspace.latest_message_sent_at,
  });

  // Check all sessions in this workspace's tabs for unseen activity,
  // not just current_session_id — the user may have multiple tabs open.
  const activeChatTabSessionId = useWorkspaceLayoutStore(
    (s) => s.layouts[workspace.id]?.activeChatTabSessionId ?? null
  );
  const chatTabSessionIds = useWorkspaceLayoutStore(
    (s) => s.layouts[workspace.id]?.chatTabSessionIds
  );
  const hasUnseenActivity = useUnreadStore((s) => {
    const ids = chatTabSessionIds?.length
      ? chatTabSessionIds
      : workspace.current_session_id
        ? [workspace.current_session_id]
        : [];
    return ids.some((sid) => s.unreadSessionIds[sid]);
  });
  const shouldRefreshPrefetch =
    hasUnseenActivity ||
    workspace.session_status === "working" ||
    (!!activeChatTabSessionId && activeChatTabSessionId !== workspace.current_session_id);

  const displayStatus = getDisplayStatus(workspace, hasUnseenActivity);
  const isSetupRunning = workspace.setup_status === "running";
  const isSetupFailed = workspace.setup_status === "failed";
  const isAttention = displayStatus !== "idle";

  const displayName = getWorkspaceDisplayName(workspace);
  const secondaryText = getWorkspaceSecondaryText(workspace);

  const additions = diffStats?.additions ?? 0;
  const deletions = diffStats?.deletions ?? 0;
  const hasChanges = additions > 0 || deletions > 0;

  // Diff stats only when nothing more urgent claims the cell.
  const showDiff = hasChanges && displayStatus === "idle" && !isSetupFailed && !isSetupRunning;

  // Attention states get a clear dot instead of text: unread gold, error red.
  const statusDotClass =
    isInitializing || isSetupRunning || isSetupFailed
      ? null
      : match(displayStatus)
          .with("unread", () => "bg-accent-gold")
          .with("error", () => "bg-accent-red")
          .otherwise(() => null);

  const metaText = (): string => {
    if (isInitializing) {
      return match(workspace.init_stage)
        .with("worktree", () => "Creating...")
        .with("dependencies", () => "Installing...")
        .with("hooks", () => "Setting up...")
        .with("session", () => "Finalizing...")
        .otherwise(() => "Setting up...");
    }
    if (isSetupRunning) return "Installing...";
    if (isSetupFailed) return "Setup failed";
    return (
      match(displayStatus)
        // error/unread are unreachable here — the dot branch renders instead —
        // but the match stays exhaustive so new statuses fail the typecheck.
        .with("error", () => "")
        .with("unread", () => "")
        .with("working", () => (duration > 0 ? formatDuration(duration, false) : "Working..."))
        .with("idle", () => formatTimeAgo(workspace.updated_at))
        .exhaustive()
    );
  };

  // Error/unread never reach text rendering — they show as dots above.
  const metaClass = isSetupFailed
    ? "text-accent-red-muted"
    : isSetupRunning || isInitializing
      ? "text-text-muted"
      : displayStatus === "working"
        ? "text-text-tertiary"
        : "text-text-disabled";

  const handleArchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    onArchive?.(workspace.id);
  };

  const canArchive = !isInitializing && workspace.state !== "archived" && !!onArchive;

  return (
    <div className={cn(isInitializing && "animate-[fadeInUp_0.25s_cubic-bezier(.215,.61,.355,1)]")}>
      <SidebarRow
        variant="workspace"
        isActive={isActive}
        role="button"
        tabIndex={isInitializing ? -1 : 0}
        data-workspace-id={workspace.id}
        className={cn(isInitializing ? "pointer-events-none" : "cursor-pointer")}
        aria-current={isActive ? "page" : undefined}
        aria-label={`Workspace ${displayName}`}
        aria-busy={isInitializing || undefined}
        title={secondaryText ?? undefined}
        onClick={isInitializing ? undefined : () => onClick(workspace)}
        onMouseEnter={
          isInitializing
            ? undefined
            : () =>
                prefetchWorkspace(queryClient, workspace, {
                  activeSessionId: activeChatTabSessionId,
                  refreshIfCached: shouldRefreshPrefetch,
                })
        }
        onKeyDown={(e) => {
          // Only when the row itself is focused — child buttons (status menu,
          // archive) bubble their key events up here.
          if (e.currentTarget === e.target && e.key === " ") e.preventDefault();
        }}
        onKeyUp={(e) => {
          if (
            e.currentTarget === e.target &&
            !isInitializing &&
            (e.key === "Enter" || e.key === " ")
          ) {
            onClick(workspace);
          }
        }}
      >
        {/* Left: icon + name. Icon is flush left, aligned with the repo label. */}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5",
            isInitializing && "animate-[shimmer_2s_ease-in-out_infinite]"
          )}
        >
          <WorkspaceStatusMenu
            currentStatus={workspace.status}
            onStatusChange={(status) => onStatusChange?.(workspace.id, status)}
          >
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="flex h-5 w-3.5 shrink-0 items-center transition-opacity hover:opacity-80"
              aria-label={`Status: ${workspace.status}`}
            >
              <WorkspaceGitIcon workspace={workspace} displayStatus={displayStatus} />
            </button>
          </WorkspaceStatusMenu>
          <span
            className={cn(
              "truncate text-base",
              isInitializing
                ? "text-text-disabled font-normal"
                : isActive
                  ? "text-text-primary font-medium"
                  : isAttention
                    ? "text-text-primary font-normal"
                    : "text-text-tertiary font-normal"
            )}
          >
            {displayName}
          </span>
        </div>

        {/* Right: one signal. Fades out on hover to make room for archive. */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-xs transition-opacity",
            canArchive && "group-hover/sidebar-row:opacity-0"
          )}
        >
          {showDiff ? (
            <>
              {additions > 0 && (
                <NumberFlow
                  value={additions}
                  prefix="+"
                  className={cn("font-medium", isActive ? "text-accent-green" : "text-text-muted")}
                />
              )}
              {deletions > 0 && (
                <NumberFlow
                  value={deletions}
                  prefix="-"
                  className={cn("font-medium", isActive ? "text-accent-red" : "text-text-muted")}
                />
              )}
            </>
          ) : statusDotClass ? (
            <span
              className={cn("h-2 w-2 rounded-full", statusDotClass)}
              title={displayStatus === "error" ? "Error" : "Needs response"}
              aria-label={displayStatus === "error" ? "Error" : "Unread activity"}
            />
          ) : (
            <span className={cn("flex items-center gap-1", metaClass)}>
              {isSetupRunning && (
                <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
              )}
              {metaText()}
            </span>
          )}
        </div>

        {/* Archive button — hover reveal */}
        {canArchive && (
          <button
            type="button"
            onClick={handleArchive}
            aria-label={`Archive workspace ${displayName}`}
            title="Archive workspace"
            className={cn(
              "text-text-muted hover:text-text-secondary flex h-7 w-7 items-center justify-center rounded-lg",
              "absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity",
              "group-hover/sidebar-row:opacity-100"
            )}
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        )}
      </SidebarRow>
    </div>
  );
});
