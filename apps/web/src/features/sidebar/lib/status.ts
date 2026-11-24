/**
 * Sidebar Status Configuration System
 *
 * Centralized configuration for workspace/session statuses, priorities, and visual styling.
 * Design philosophy: Make it easy to iterate on colors and priorities without touching component code.
 *
 * @see src/features/session/types.ts for SessionStatus type definition
 */

import type { Workspace } from "@/features/workspace/types";
import { workspaceChats, type WorkspaceChat } from "@shared/types/workspace";
import type { WorkspaceStatus } from "@shared/enums";

/** A workspace is unread when a chat needs input or has an unseen reply. */
export type DisplayStatus = "idle" | "working" | "error" | "unread";

/**
 * Priority levels for sorting (higher = more urgent)
 */
enum StatusPriority {
  ERROR = 4, // Critical - something broke
  UNREAD = 3, // Important - needs review / response
  WORKING = 2, // Active - in progress
  IDLE = 0, // Dormant - no activity
}

/**
 * Visual configuration for each status
 *
 * Design System:
 * - badge: Color for notification badges (collapsed sidebar)
 * - border: Border/glow color for active states
 * - text: Text color for status labels
 * - bg: Background color for sections/cards
 *
 * Color Semantics:
 * 🔴 Red (error) = Critical, blocking, needs immediate action
 * 🟡 Amber (unread) = Important, needs attention when ready
 * 🟢 Green (working) = Active, positive, making progress
 * 🟣 Purple (compacting) = Transient, maintenance, ignore
 * ⚪ Gray (idle) = Dormant, background, low priority
 */
interface StatusConfig {
  priority: StatusPriority;
  label: string;
  labelActive: string; // Present continuous form (e.g., "Working...")
  badge: string; // Tailwind classes for badge
  border: string; // Tailwind classes for border/glow
  text: string; // Tailwind classes for text
  bg: string; // Tailwind classes for background
  pulse?: boolean; // Whether to animate/pulse
}

/**
 * Status configuration map
 *
 * IMPORTANT: To change colors, edit this object (no component changes needed)
 */
export const STATUS_CONFIG: Record<DisplayStatus, StatusConfig> = {
  error: {
    priority: StatusPriority.ERROR,
    label: "Error",
    labelActive: "Error",
    badge: "bg-destructive text-destructive-foreground",
    border: "border-destructive/60",
    text: "text-destructive",
    bg: "bg-destructive/10",
    pulse: true,
  },
  unread: {
    priority: StatusPriority.UNREAD,
    label: "Needs Attention",
    labelActive: "Awaiting Input",
    badge: "bg-status-unread text-status-unread-fg",
    border: "border-status-unread/60",
    text: "text-status-unread",
    bg: "bg-status-unread/10",
    pulse: false,
  },
  working: {
    priority: StatusPriority.WORKING,
    label: "Working",
    labelActive: "Working...",
    badge: "bg-primary text-primary-foreground",
    border: "border-primary/60",
    text: "text-primary",
    bg: "bg-primary/10",
    pulse: true,
  },
  idle: {
    priority: StatusPriority.IDLE,
    label: "Idle",
    labelActive: "Idle",
    badge: "bg-muted text-muted-foreground",
    border: "border-muted",
    text: "text-muted-foreground",
    bg: "bg-muted/30",
    pulse: false,
  },
};

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
  return [...workspaces].sort((a, b) => {
    const priorityA = STATUS_CONFIG[getWorkspaceActivity(a, unread).status].priority;
    const priorityB = STATUS_CONFIG[getWorkspaceActivity(b, unread).status].priority;
    return priorityB - priorityA || Date.parse(b.updated_at) - Date.parse(a.updated_at);
  });
}
