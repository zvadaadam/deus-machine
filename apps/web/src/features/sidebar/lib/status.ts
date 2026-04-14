/**
 * Sidebar Status Configuration System
 *
 * Centralized configuration for workspace/session statuses, priorities, and visual styling.
 * Design philosophy: Make it easy to iterate on colors and priorities without touching component code.
 *
 * @see src/features/session/types.ts for SessionStatus type definition
 */

import type { Workspace } from "@/features/workspace/types";
import type { WorkspaceStatus } from "@shared/enums";

/**
 * Display status extends SessionStatus with derived states.
 * 'unread' is derived from needs_response / needs_plan_response session status.
 */
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

/**
 * Derive display status from workspace data
 *
 * Priority logic:
 * 1. Error — session in error state
 * 2. Unread — agent needs user response OR has unseen activity
 * 3. Working — agent actively processing
 * 4. Idle — dormant
 *
 * @param workspace Workspace data with session info
 * @param hasUnseenActivity Whether the session has activity the user hasn't viewed yet
 * @returns Derived display status for UI rendering
 */
export function getDisplayStatus(workspace: Workspace, hasUnseenActivity = false): DisplayStatus {
  const status = workspace.session_status;

  if (status === "error") return "error";
  if (status === "needs_response" || status === "needs_plan_response") return "unread";
  if (status === "working") return "working";
  if (hasUnseenActivity) return "unread";
  return "idle";
}

/**
 * Sort workspaces by status priority
 * Higher priority statuses appear first
 *
 * @param workspaces Array of workspaces to sort
 * @param unreadWorkspaceIds Optional set of workspace IDs with unseen activity
 * @returns Sorted array (original array not mutated)
 */
export function sortByStatusPriority<T extends Workspace>(
  workspaces: T[],
  unreadWorkspaceIds?: Set<string>
): T[] {
  return [...workspaces].sort((a, b) => {
    const hasUnreadA = !!unreadWorkspaceIds?.has(a.id);
    const hasUnreadB = !!unreadWorkspaceIds?.has(b.id);
    const statusA = getDisplayStatus(a, hasUnreadA);
    const statusB = getDisplayStatus(b, hasUnreadB);
    const priorityA = STATUS_CONFIG[statusA].priority;
    const priorityB = STATUS_CONFIG[statusB].priority;

    // Higher priority first
    if (priorityA !== priorityB) {
      return priorityB - priorityA;
    }

    // Same priority: sort by latest activity (most recent first)
    const timeA = new Date(a.updated_at).getTime();
    const timeB = new Date(b.updated_at).getTime();
    return timeB - timeA;
  });
}
