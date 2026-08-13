import React from "react";
import { match } from "ts-pattern";
import { GitBranch } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { cn } from "@/shared/lib/utils";
import { formatTimeAgo } from "@/shared/lib/formatters";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { queryKeys } from "@/shared/api/queryKeys";
import { SessionService, type PaginatedMessages } from "@/features/session/api/session.service";
import type { Workspace, DiffStats } from "@/shared/types";
import type { DisplayStatus } from "../lib/status";
import { getWorkspaceDisplayName, getWorkspaceSecondaryText } from "../lib/utils";
import { WorkspaceGitIcon, derivePrLifecycle } from "./WorkspaceGitIcon";

/** Compact human label for the PR chip — PR fields only, so a manual
 * backlog/canceled workflow override never hides an existing PR. */
function prChipLabel(workspace: Workspace): string | null {
  if (!workspace.pr_number) return null;
  const label = match(derivePrLifecycle(workspace))
    .with("merged", () => "Merged")
    .with("closed", () => "Closed")
    .with("conflicts", () => "Conflicts")
    .with("draft", () => "Draft")
    .with("changes_requested", () => "Changes requested")
    .with("open", () => (workspace.pr_review_status === "approved" ? "Approved" : "Open"))
    .with("linked", () => "PR")
    .with("local", () => null)
    .exhaustive();
  return label ? `#${workspace.pr_number} ${label}` : null;
}

/** Latest in-flight tool call from the cached session messages, if any. */
function findLiveTool(data: PaginatedMessages | undefined): string | null {
  if (!data?.messages?.length) return null;
  for (let m = data.messages.length - 1; m >= 0; m--) {
    const parts = data.messages[m].parts;
    if (!parts?.length) continue;
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p];
      if (part.type !== "TOOL") continue;
      if (part.state.status === "RUNNING" || part.state.status === "PENDING") {
        const detail =
          part.title ?? (part.state.status === "RUNNING" ? part.state.title : undefined);
        return detail ? `${part.toolName} · ${detail}` : part.toolName;
      }
      // Most recent tool already finished — nothing is in flight.
      return null;
    }
  }
  return null;
}

/** Rendered only while the card is open — one cache subscription per open card. */
function LiveActivityLine({ sessionId }: { sessionId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.sessions.messages(sessionId),
    queryFn: () => SessionService.fetchMessages(sessionId),
    // Unselected sessions receive no part push events, so poll briefly while
    // the card is open — this component only mounts for working workspaces.
    refetchInterval: 2_000,
    refetchOnWindowFocus: false,
  });
  const liveTool = findLiveTool(data);
  if (!liveTool) return null;

  return (
    <div className="bg-bg-base flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5">
      <span className="bg-accent-green h-[5px] w-[5px] shrink-0 animate-pulse rounded-full motion-reduce:animate-none" />
      <span className="text-text-tertiary text-2xs truncate font-mono">{liveTool}</span>
    </div>
  );
}

interface WorkspaceHoverCardProps {
  workspace: Workspace;
  displayStatus: DisplayStatus;
  diffStats?: DiffStats;
  /** Live working duration, already formatted (e.g. "4:29"). */
  workingDuration?: string | null;
  children: React.ReactNode;
}

/**
 * Workspace preview card — opens 500ms after hovering a sidebar row.
 *
 * Anatomy (see design/sidebar-redesign.pen, "Hover card" board):
 * slug + title · live tool-call line while the agent works · chips for
 * PR state, CI, and diff · footer with branch → target and last activity.
 * Read-only: clicking anywhere still just opens the workspace.
 */
export function WorkspaceHoverCard({
  workspace,
  displayStatus,
  diffStats,
  workingDuration,
  children,
}: WorkspaceHoverCardProps) {
  const displayName = getWorkspaceDisplayName(workspace);
  const secondaryText = getWorkspaceSecondaryText(workspace);
  const isWorking = displayStatus === "working";

  const prLabel = prChipLabel(workspace);
  const showCi =
    workspace.pr_state === "open" &&
    !!workspace.pr_ci_status &&
    workspace.pr_ci_status !== "unknown";
  const additions = diffStats?.additions ?? 0;
  const deletions = diffStats?.deletions ?? 0;
  const hasChanges = additions > 0 || deletions > 0;

  const branch = workspace.git_branch;
  const targetBranch = workspace.git_target_branch || workspace.git_default_branch || "main";
  const timeText =
    isWorking && workingDuration ? workingDuration : formatTimeAgo(workspace.updated_at);

  return (
    <HoverCard openDelay={500} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="right" collisionPadding={12} className="flex w-64 flex-col gap-2">
        {/* Head: identity + state icon */}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {secondaryText && <span className="text-text-muted text-2xs">{secondaryText}</span>}
            <span className="text-text-primary truncate text-base font-semibold">
              {displayName}
            </span>
          </div>
          <WorkspaceGitIcon workspace={workspace} displayStatus={displayStatus} />
        </div>

        {isWorking && workspace.current_session_id && (
          <LiveActivityLine sessionId={workspace.current_session_id} />
        )}

        {/* Chips: PR · CI · diff */}
        {(prLabel || showCi || hasChanges) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {prLabel && (
              <span className="bg-bg-raised text-text-secondary text-2xs rounded-full px-2 py-0.5 font-medium">
                {prLabel}
              </span>
            )}
            {showCi && (
              <span className="bg-bg-raised text-text-secondary text-2xs flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    match(workspace.pr_ci_status)
                      .with("passing", () => "bg-accent-green")
                      .with("failing", () => "bg-accent-red")
                      .otherwise(() => "bg-accent-gold")
                  )}
                />
                CI
              </span>
            )}
            {hasChanges && (
              <span className="bg-bg-raised text-2xs rounded-full px-2 py-0.5 font-medium">
                {additions > 0 && <span className="text-accent-green">+{additions}</span>}
                {additions > 0 && deletions > 0 && " "}
                {deletions > 0 && <span className="text-accent-red">−{deletions}</span>}
              </span>
            )}
          </div>
        )}

        {/* Footer: branch → target · time */}
        <div className="flex items-center justify-between gap-2">
          {branch ? (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch className="text-text-disabled h-2.5 w-2.5 shrink-0" />
              <span className="text-text-muted text-2xs truncate font-mono">
                {branch} → {targetBranch}
              </span>
            </span>
          ) : (
            <span />
          )}
          <span className="text-text-disabled text-2xs shrink-0">{timeText}</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
