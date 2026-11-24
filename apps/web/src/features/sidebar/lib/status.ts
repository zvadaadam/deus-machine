import type { Workspace } from "@/features/workspace/types";
import { workspaceChats, type WorkspaceChat } from "@shared/types/workspace";
import type { WorkspaceStatus } from "@shared/enums";

/** A workspace is unread when a chat needs input or has an unseen reply. */
export type DisplayStatus = "idle" | "working" | "error" | "unread";

const rank: Record<DisplayStatus, number> = { error: 4, unread: 3, working: 2, idle: 0 };

// ── Workflow Status () ────────────────────────────────────────
// Separate from DisplayStatus which shows real-time agent activity.
// Rendered as a small icon to the left of the workspace title.

interface WorkflowStatusConfig {
  label: string;
  color: string;
}

export const WORKFLOW_STATUS_CONFIG: Record<WorkspaceStatus, WorkflowStatusConfig> = {
  backlog: { label: "Backlog", color: "text-muted-foreground" },
  "in-progress": { label: "In Progress", color: "text-status-in-progress" },
  "in-review": { label: "In Review", color: "text-status-in-review" },
  done: { label: "Done", color: "text-status-done" },
  canceled: { label: "Canceled", color: "text-muted-foreground" },
};

const startedAt = (chat: WorkspaceChat) =>
  chat.last_user_message_at ? Date.parse(chat.last_user_message_at) : Infinity;

export function getWorkspaceActivity(
  workspace: Workspace,
  unread: Readonly<Record<string, boolean>>
) {
  const chats = workspaceChats(workspace);
  const running = chats.reduce<WorkspaceChat | undefined>((longest, chat) => {
    if (chat.status !== "working") return longest;
    return !longest || startedAt(chat) < startedAt(longest) ? chat : longest;
  }, undefined);
  const working = !!running || workspace.state === "initializing";
  const waiting = chats.find(
    ({ status }) => status === "needs_response" || status === "needs_plan_response"
  );
  let status: DisplayStatus;
  if (workspace.state === "error") status = "error";
  else if (waiting) status = "unread";
  else if (
    chats.some(
      (c) => c.status === "error" && (c.id === workspace.current_session_id || unread[c.id])
    )
  )
    status = "error";
  else if (chats.some((c) => unread[c.id])) status = "unread";
  else status = working ? "working" : "idle";
  return { status, working, running, waiting };
}

export function sortByStatusPriority<T extends Workspace>(
  workspaces: T[],
  unread: Readonly<Record<string, boolean>>
): T[] {
  return workspaces
    .map((workspace) => ({
      workspace,
      priority: rank[getWorkspaceActivity(workspace, unread).status],
      updatedAt: Date.parse(workspace.updated_at),
    }))
    .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)
    .map(({ workspace }) => workspace);
}
