import { motion } from "framer-motion";
import { CircularPixelGrid } from "@/features/session/ui/CircularPixelGrid";
import { WorkflowStatusIcon } from "@/features/sidebar/ui/WorkflowStatusIcon";
import { getWorkspaceDisplayName, getWorkspaceSecondaryText } from "@/features/sidebar/lib/utils";
import { getDisplayStatus } from "@/features/sidebar/lib/status";
import { cn } from "@/shared/lib/utils";
import { formatTimeAgo } from "@/shared/lib/formatters";
import { EASE_OUT_QUART } from "@/shared/lib/animation";
import type { RepoGroup, Workspace } from "@/shared/types";

const RECENT_WORKSPACE_LIMIT = 14;

interface RecentWorkspaceItem {
  workspace: Workspace;
  activityAt: string;
}

interface RecentWorkspaceGroup {
  label: string;
  items: RecentWorkspaceItem[];
}

function parseAppDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getWorkspaceActivityDate(workspace: Workspace): Date {
  const latestMessageDate = parseAppDate(workspace.latest_message_sent_at);
  const workspaceDate = parseAppDate(workspace.updated_at);
  return latestMessageDate ?? workspaceDate ?? new Date(0);
}

function getDayKey(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function getDayLabel(date: Date, now: Date = new Date()): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000)
  );

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export function buildRecentWorkspaceGroups(repoGroups: RepoGroup[]): RecentWorkspaceGroup[] {
  const recentItems = repoGroups
    .flatMap((group) =>
      group.workspaces
        .filter((workspace) => workspace.state !== "archived")
        .map((workspace) => {
          const activityDate = getWorkspaceActivityDate(workspace);
          return {
            workspace,
            activityAt: activityDate.toISOString(),
            activityMs: activityDate.getTime(),
          };
        })
    )
    .sort((a, b) => b.activityMs - a.activityMs)
    .slice(0, RECENT_WORKSPACE_LIMIT);

  const groups: RecentWorkspaceGroup[] = [];
  const indexByDay = new Map<string, RecentWorkspaceGroup>();

  for (const item of recentItems) {
    const date = new Date(item.activityAt);
    const dayKey = getDayKey(date);
    let group = indexByDay.get(dayKey);
    if (!group) {
      group = { label: getDayLabel(date), items: [] };
      indexByDay.set(dayKey, group);
      groups.push(group);
    }
    group.items.push({ workspace: item.workspace, activityAt: item.activityAt });
  }

  return groups;
}

function RecentWorkspaceStatusIcon({ workspace }: { workspace: Workspace }) {
  if (workspace.state === "initializing") {
    return <CircularPixelGrid variant="working" size={14} resolution={8} />;
  }

  const displayStatus = getDisplayStatus(workspace);

  if (displayStatus === "working") {
    return <CircularPixelGrid variant="working" size={14} resolution={8} />;
  }

  if (displayStatus === "error") {
    return <span className="bg-accent-red h-2 w-2 rounded-full" />;
  }

  if (displayStatus === "unread") {
    return <span className="bg-accent-gold h-2 w-2 rounded-full" />;
  }

  return <WorkflowStatusIcon status={workspace.status} size={14} />;
}

function getRecentWorkspaceMeta(workspace: Workspace): string {
  const secondary = getWorkspaceSecondaryText(workspace);
  const repoName = workspace.repo_name;
  if (secondary && repoName) return `${secondary} · ${repoName}`;
  return secondary ?? repoName ?? workspace.git_branch ?? "Workspace";
}

export function RecentWorkspaces({
  groups,
  selectedWorkspaceId,
  onWorkspaceClick,
}: {
  groups: RecentWorkspaceGroup[];
  selectedWorkspaceId?: string | null;
  onWorkspaceClick?: (workspace: Workspace) => void;
}) {
  if (!groups.length || !onWorkspaceClick) return null;

  return (
    <motion.div
      key="recent-workspaces"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.24, delay: 0.1, ease: EASE_OUT_QUART }}
      className="mt-5 w-full max-w-[700px] px-4 sm:px-6"
    >
      <div className="flex flex-col gap-5">
        {groups.map((group) => (
          <section key={group.label} aria-label={`${group.label} workspaces`}>
            <h2 className="text-text-muted mb-2 px-1 text-xs font-medium">{group.label}</h2>
            <div className="flex flex-col gap-0.5">
              {group.items.map(({ workspace, activityAt }) => {
                const isActive = workspace.id === selectedWorkspaceId;
                const displayName = getWorkspaceDisplayName(workspace);
                const meta = getRecentWorkspaceMeta(workspace);

                return (
                  <button
                    key={workspace.id}
                    type="button"
                    onClick={() => onWorkspaceClick(workspace)}
                    className={cn(
                      "group/recent-workspace flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors duration-150",
                      "hover:bg-bg-raised/60 focus-visible:ring-primary/35 focus:outline-none focus-visible:ring-2",
                      isActive && "bg-bg-raised/70"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded",
                        isActive ? "text-text-primary" : "text-text-muted"
                      )}
                      aria-hidden
                    >
                      <RecentWorkspaceStatusIcon workspace={workspace} />
                    </span>

                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className={cn(
                          "truncate text-sm font-medium",
                          isActive ? "text-text-primary" : "text-text-secondary"
                        )}
                      >
                        {displayName}
                      </span>
                      <span className="text-text-disabled truncate text-xs">{meta}</span>
                    </span>

                    <span className="text-text-muted shrink-0 text-xs tabular-nums">
                      {formatTimeAgo(activityAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </motion.div>
  );
}
