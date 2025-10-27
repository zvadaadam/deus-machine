/**
 * Sidebar Status Configuration System
 *
 * Centralized configuration for workspace/session statuses, priorities, and visual styling.
 * Design philosophy: Make it easy to iterate on colors and priorities without touching component code.
 *
 * @see src/features/session/types.ts for SessionStatus type definition
 */

import type { SessionStatus } from '@/features/session/types';
import type { Workspace } from '@/features/workspace/types';

/**
 * Display status extends SessionStatus with derived states
 * 'unread' is derived from workspace.unread or session.unread_count
 */
export type DisplayStatus = SessionStatus | 'unread';

/**
 * Priority levels for sorting (higher = more urgent)
 */
export enum StatusPriority {
  ERROR = 4,      // Critical - something broke
  UNREAD = 3,     // Important - needs review
  WORKING = 2,    // Active - in progress
  COMPACTING = 1, // Maintenance - background
  IDLE = 0,       // Dormant - no activity
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
export interface StatusConfig {
  priority: StatusPriority;
  label: string;
  labelActive: string; // Present continuous form (e.g., "Working...")
  badge: string;       // Tailwind classes for badge
  border: string;      // Tailwind classes for border/glow
  text: string;        // Tailwind classes for text
  bg: string;          // Tailwind classes for background
  pulse?: boolean;     // Whether to animate/pulse
}

/**
 * Status configuration map
 *
 * IMPORTANT: To change colors, edit this object (no component changes needed)
 */
export const STATUS_CONFIG: Record<DisplayStatus, StatusConfig> = {
  error: {
    priority: StatusPriority.ERROR,
    label: 'Error',
    labelActive: 'Error',
    badge: 'bg-destructive text-destructive-foreground',
    border: 'border-destructive/50',
    text: 'text-destructive',
    bg: 'bg-destructive/10',
    pulse: true,
  },
  unread: {
    priority: StatusPriority.UNREAD,
    label: 'Needs Review',
    labelActive: 'Unread',
    badge: 'bg-amber-500 text-white dark:bg-amber-600',
    border: 'border-amber-500/50',
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-500/10',
    pulse: false,
  },
  working: {
    priority: StatusPriority.WORKING,
    label: 'Working',
    labelActive: 'Working...',
    badge: 'bg-primary text-primary-foreground',
    border: 'border-primary/50',
    text: 'text-primary',
    bg: 'bg-primary/10',
    pulse: true,
  },
  compacting: {
    priority: StatusPriority.COMPACTING,
    label: 'Compacting',
    labelActive: 'Compacting...',
    badge: 'bg-purple-500 text-white',
    border: 'border-purple-500/50',
    text: 'text-purple-600 dark:text-purple-400',
    bg: 'bg-purple-500/10',
    pulse: true,
  },
  idle: {
    priority: StatusPriority.IDLE,
    label: 'Idle',
    labelActive: 'Idle',
    badge: 'bg-muted text-muted-foreground',
    border: 'border-muted',
    text: 'text-muted-foreground',
    bg: 'bg-muted/30',
    pulse: false,
  },
};

/**
 * Derive display status from workspace data
 *
 * Priority logic:
 * 1. Error (if tool_result.is_error in recent messages) - NOT IMPLEMENTED YET
 * 2. Unread (if workspace.unread > 0 or session.unread > 0)
 * 3. Session status (working, compacting, idle)
 *
 * TODO: Implement error detection by checking latest messages for tool_result.is_error
 * Requires: useMessages hook and message parsing logic
 *
 * @param workspace Workspace data with session info
 * @returns Derived display status for UI rendering
 */
export function getDisplayStatus(workspace: Workspace): DisplayStatus {
  // Check for unread messages (highest non-error priority)
  const hasUnread = (workspace.unread && workspace.unread > 0) ||
                    (workspace.session_unread && workspace.session_unread > 0);

  if (hasUnread) {
    return 'unread';
  }

  // Default to session status
  return workspace.session_status || 'idle';
}

/**
 * Get total unread count for a workspace
 * Combines workspace-level and session-level unread counters
 */
export function getUnreadCount(workspace: Workspace): number {
  const workspaceUnread = workspace.unread || 0;
  const sessionUnread = workspace.session_unread || 0;
  return Math.max(workspaceUnread, sessionUnread);
}

/**
 * Sort workspaces by status priority
 * Higher priority statuses appear first
 *
 * @param workspaces Array of workspaces to sort
 * @returns Sorted array (original array not mutated)
 */
export function sortByStatusPriority<T extends Workspace>(workspaces: T[]): T[] {
  return [...workspaces].sort((a, b) => {
    const statusA = getDisplayStatus(a);
    const statusB = getDisplayStatus(b);
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

/**
 * Group workspaces by display status
 * Used for rendering section headers in expanded sidebar
 *
 * @param workspaces Array of workspaces to group
 * @returns Object with status as keys, workspace arrays as values
 */
export function groupByStatus<T extends Workspace>(
  workspaces: T[]
): Partial<Record<DisplayStatus, T[]>> {
  const groups: Partial<Record<DisplayStatus, T[]>> = {};

  workspaces.forEach(workspace => {
    const status = getDisplayStatus(workspace);
    if (!groups[status]) {
      groups[status] = [];
    }
    groups[status]!.push(workspace);
  });

  return groups;
}

/**
 * Get aggregate status counts for a repository
 * Used for collapsed sidebar status indicators
 *
 * @param workspaces Workspaces in a repository
 * @returns Count of each status type
 */
export function getStatusCounts(workspaces: Workspace[]): Record<DisplayStatus, number> {
  const counts: Record<DisplayStatus, number> = {
    error: 0,
    unread: 0,
    working: 0,
    compacting: 0,
    idle: 0,
  };

  workspaces.forEach(workspace => {
    const status = getDisplayStatus(workspace);
    counts[status]++;
  });

  return counts;
}

/**
 * Get total unread count for a repository
 * Sums unread across all workspaces
 */
export function getRepoUnreadCount(workspaces: Workspace[]): number {
  return workspaces.reduce((sum, workspace) => {
    return sum + getUnreadCount(workspace);
  }, 0);
}

/**
 * Get highest priority status for a repository
 * Used for collapsed sidebar badge color
 *
 * @param workspaces Workspaces in a repository
 * @returns The highest priority status present
 */
export function getRepoPriorityStatus(workspaces: Workspace[]): DisplayStatus {
  let highestPriority = StatusPriority.IDLE;
  let highestStatus: DisplayStatus = 'idle';

  workspaces.forEach(workspace => {
    const status = getDisplayStatus(workspace);
    const priority = STATUS_CONFIG[status].priority;

    if (priority > highestPriority) {
      highestPriority = priority;
      highestStatus = status;
    }
  });

  return highestStatus;
}
