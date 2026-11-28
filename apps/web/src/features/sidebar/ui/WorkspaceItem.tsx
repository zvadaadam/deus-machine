import React from "react";
import { match } from "ts-pattern";
import { Archive, Cloud, CloudOff, ClockFading, FolderOpen, Link, Loader2 } from "lucide-react";
import NumberFlow from "@number-flow/react";
import { useQueryClient } from "@tanstack/react-query";

import { cn } from "@/shared/lib/utils";
import { cloudPresence } from "@/features/workspace/lib/cloudPresence";
import { wakeCloudWorkspace } from "@/features/workspace/api/wakeCloudWorkspace";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { formatTimeAgo } from "@/shared/lib/formatters";
import { useWorkingDuration, formatDuration } from "@/shared/hooks";
import { useAutomationForWorkspace } from "@/features/automations";
import { useUnreadStore } from "@/features/session/store/unreadStore";
import { useWorkspaceLayoutStore } from "@/features/workspace/store/workspaceLayoutStore";
import { prefetchWorkspace } from "@/features/workspace/api/prefetch";
import { canRecoverStart } from "@/features/workspace/lib/startState";
import { workspaceRowStatus } from "../lib/status";
import { getWorkspaceDisplayName, getWorkspaceSecondaryText } from "../lib/utils";
import type { WorkspaceItemProps } from "../model/types";
import { SidebarRow } from "./SidebarRow";
import { CoordinatorMark, MakeCoordinator } from "@/features/workspace/ui/CoordinatorRole";
import { WorkspaceGitIcon, WorkspaceAttention } from "./WorkspaceGitIcon";
import { WorkspaceHoverCard } from "./WorkspaceHoverCard";
import { WorkspaceStatusChoices, WorkspaceStatusMenu } from "./WorkspaceStatusMenu";
import { ContextMenu, ContextMenuItem, ContextMenuSub } from "@/components/ui/context-menu";
import { AnimatedTitle } from "@/components/ui/animated-title";
import { copyWorkspaceLink } from "@/features/workspace/lib/workspaceAddress";
import { WorkflowStatusIcon } from "./WorkflowStatusIcon";

/** The same presence as the header and panels; only recoverable states offer wake. */
function CloudLivenessIcon({ workspace }: { workspace: WorkspaceItemProps["workspace"] }) {
  const presence = cloudPresence(workspace);
  if (presence === "waking" || presence === "provisioning") {
    return <Loader2 className="text-text-muted h-3 w-3 shrink-0 animate-spin" />;
  }
  const description = match(presence)
    .with("awake", () => "Cloud computer online")
    .with("asleep", () => `Cloud computer ${workspace.init_stage}`)
    .with("unavailable", () => "Cloud computer unavailable")
    .with("error", () => "Cloud computer failed")
    .exhaustive();
  const Icon = presence === "error" || presence === "unavailable" ? CloudOff : Cloud;
  const icon = (
    <Icon
      className={cn("h-3 w-3", presence === "awake" ? "text-accent-green" : "text-text-disabled")}
    />
  );
  // Web-direct wakes on send; it has no explicit wake transport.
  if (isCloudDirectWebMode() || presence === "error") {
    return (
      <span
        title={
          description +
          (presence === "asleep" || presence === "unavailable"
            ? " — send a message to wake it"
            : "")
        }
        aria-label="Cloud workspace status"
        className="flex shrink-0 items-center"
      >
        {icon}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void wakeCloudWorkspace(workspace.id);
      }}
      title={`${description} — click to ${presence === "awake" ? "refresh" : presence === "unavailable" ? "try again" : "wake"}`}
      aria-label="Cloud workspace status"
      className="flex shrink-0 cursor-pointer items-center"
    >
      {icon}
    </button>
  );
}

export const WorkspaceItem = React.memo(function WorkspaceItem({
  workspace,
  isActive,
  diffStats,
  onClick,
  onArchive,
  onStatusChange,
}: WorkspaceItemProps) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Provenance: automation-born workspaces carry a zap beside the name.
  const automation = useAutomationForWorkspace(workspace.id);
  const queryClient = useQueryClient();

  const unread = useUnreadStore((s) => s.unreadSessionIds);
  const { status, working, running, isInitializing, isFailed, start, attention, description } =
    React.useMemo(() => workspaceRowStatus(workspace, unread), [workspace, unread]);
  const { duration } = useWorkingDuration({
    status: running?.status,
    latestMessageSentAt: running?.last_user_message_at,
  });
  const activeChatTabSessionId = useWorkspaceLayoutStore(
    (s) => s.layouts[workspace.id]?.activeChatTabSessionId ?? null
  );
  const shouldRefreshPrefetch =
    status !== "idle" ||
    (!!activeChatTabSessionId && activeChatTabSessionId !== workspace.current_session_id);

  const displayName = getWorkspaceDisplayName(workspace);
  const secondaryText = getWorkspaceSecondaryText(workspace);
  const label = `Workspace ${displayName}, ${description}`;

  const additions = diffStats?.additions ?? 0;
  const deletions = diffStats?.deletions ?? 0;
  const showDiff = status === "idle" && (additions > 0 || deletions > 0);
  const metaText =
    start ??
    (running
      ? duration > 0
        ? formatDuration(duration, false)
        : "Working..."
      : formatTimeAgo(workspace.updated_at));
  const icon = <WorkspaceGitIcon workspace={workspace} displayStatus={status} working={working} />;

  const handleArchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    onArchive?.(workspace.id);
  };

  const canArchive =
    !isInitializing && !canRecoverStart(workspace) && workspace.state !== "archived" && !!onArchive;

  const row = (
    <SidebarRow
      variant="workspace"
      isActive={isActive}
      role="button"
      tabIndex={0}
      data-workspace-id={workspace.id}
      className="cursor-pointer"
      aria-current={isActive ? "page" : undefined}
      aria-label={label}
      aria-busy={isInitializing || undefined}
      // A failed row's hover should say WHY — the red state without the
      // stored error_message reads as "the agent errored".
      title={(isFailed ? (workspace.error_message ?? secondaryText) : secondaryText) ?? undefined}
      onClick={() => onClick(workspace)}
      onMouseEnter={() =>
        prefetchWorkspace(queryClient, workspace, {
          activeSessionId: activeChatTabSessionId,
          refreshIfCached: shouldRefreshPrefetch,
        })
      }
      onKeyDown={(e) => {
        if (e.currentTarget === e.target && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          if (!e.repeat) onClick(workspace);
        }
      }}
    >
      {/* Left: icon + name. Icon is flush left, aligned with the repo label. */}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5",
          isInitializing && "animate-shimmer"
        )}
      >
        {onStatusChange ? (
          <WorkspaceStatusMenu
            currentStatus={workspace.status}
            onStatusChange={(status) => onStatusChange(workspace.id, status)}
          >
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="control-interaction flex h-5 w-3.5 shrink-0 items-center hover:opacity-80"
              aria-label={`Status: ${workspace.status}`}
            >
              {icon}
            </button>
          </WorkspaceStatusMenu>
        ) : (
          // No status mutation on this build (web-direct: workflow status is
          // Mac-side state) — the icon stays, the menu doesn't.
          <span className="flex h-5 w-3.5 shrink-0 items-center">{icon}</span>
        )}
        <span
          className={cn(
            "truncate text-base",
            isActive
              ? "text-text-primary font-medium"
              : status !== "idle"
                ? "text-text-primary font-normal"
                : "text-text-tertiary font-normal"
          )}
        >
          <AnimatedTitle text={displayName} entityId={workspace.id} />
        </span>
        {workspace.role === "coordinator" && <CoordinatorMark />}
        {workspace.kind === "cloud" && <CloudLivenessIcon workspace={workspace} />}
        {automation && (
          <span
            title={`Runs of automation "${automation.name}" land here`}
            className="flex shrink-0 items-center"
          >
            <ClockFading className="text-text-muted h-3 w-3" />
          </span>
        )}
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
        ) : attention ? (
          <WorkspaceAttention status={status} attention={attention} />
        ) : (
          <span
            className={cn(
              "text-text-disabled flex items-center gap-1",
              running && "text-text-tertiary",
              isInitializing && "text-text-muted",
              isFailed && "text-accent-red-muted"
            )}
          >
            {metaText}
          </span>
        )}
      </div>

      {/* On touch, Archive has its own space beside the row's status. */}
      {canArchive && (
        <button
          type="button"
          onClick={handleArchive}
          aria-label={`Archive workspace ${displayName}`}
          title="Archive workspace"
          className={cn(
            "control-interaction text-text-muted hover:text-text-secondary flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
            "absolute inset-y-0 right-1 my-auto opacity-0 pointer-coarse:static pointer-coarse:opacity-100",
            "group-hover/sidebar-row:opacity-100 focus-visible:opacity-100"
          )}
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      )}
    </SidebarRow>
  );

  const trigger = (
    <div className={cn(isInitializing && "animate-fade-in-up")}>
      <WorkspaceHoverCard
        hidePreview={isInitializing || menuOpen}
        workspace={workspace}
        displayStatus={status}
        workingChatId={running?.id}
        diffStats={diffStats}
        workingDuration={duration > 0 ? formatDuration(duration, false) : null}
      >
        {row}
      </WorkspaceHoverCard>
    </div>
  );
  return (
    <ContextMenu trigger={trigger} onOpenChange={setMenuOpen}>
      {!isActive && (
        <ContextMenuItem onSelect={() => onClick(workspace)}>
          <FolderOpen />
          Open workspace
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => copyWorkspaceLink({ workspaceId: workspace.id })}>
        <Link />
        Copy link
      </ContextMenuItem>
      <MakeCoordinator workspace={workspace} />
      {onStatusChange && (
        <ContextMenuSub
          label={
            <>
              <span aria-hidden="true">
                <WorkflowStatusIcon status={workspace.status} />
              </span>
              Set status
            </>
          }
        >
          <WorkspaceStatusChoices
            Item={ContextMenuItem}
            currentStatus={workspace.status}
            onStatusChange={(status) => onStatusChange(workspace.id, status)}
          />
        </ContextMenuSub>
      )}
      {canArchive && (
        <ContextMenuItem onSelect={() => onArchive(workspace.id)}>
          <Archive />
          Archive workspace
        </ContextMenuItem>
      )}
    </ContextMenu>
  );
});
