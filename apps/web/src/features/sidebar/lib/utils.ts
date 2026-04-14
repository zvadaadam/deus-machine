/**
 * Sidebar utility functions
 * Extracted from AppSidebar.tsx for better organization
 *
 * For status-related utilities (colors, priorities, sorting),
 * @see status.ts
 */

import type { Workspace } from "@/features/workspace/types";
import { getDisplayStatus } from "./status";

/**
 * Clean repository display name by removing username prefix
 * @param repoName - Full repository name (e.g., "zvadaadam/overlay" or "deus-machine")
 * @returns Clean display name (e.g., "overlay" or "deus-machine")
 */
export function getCleanRepoName(repoName: string): string {
  // Check if repo name contains username prefix (format: "username/repo")
  const parts = repoName.split("/");
  if (parts.length === 2) {
    // Return just the repo name without username
    return parts[1];
  }
  // Return as-is if no prefix
  return repoName;
}

/**
 * Smart display name for workspace sidebar row.
 *
 * Priority:
 *   1. workspace.title — AI-generated summary (after first turn), PR title, or user rename
 *   2. workspace.slug  — celestial name (clean, human-readable)
 *   3. workspace.git_branch — raw branch name as absolute fallback
 *   4. "New workspace" — nothing available yet (during early init)
 */
export function getWorkspaceDisplayName(workspace: {
  title: string | null;
  slug: string;
  git_branch: string | null;
}): string {
  if (workspace.title) return workspace.title;
  if (workspace.slug) return workspace.slug;
  return workspace.git_branch || "New workspace";
}

/**
 * Secondary line text for the workspace sidebar row.
 *
 * When a title is displayed (AI-generated, PR title, or user rename),
 * show the slug as context. When slug IS the primary name, return null.
 */
export function getWorkspaceSecondaryText(workspace: {
  title: string | null;
  slug: string;
}): string | null {
  // Show slug as secondary only when title is the primary display name
  if (workspace.title && workspace.slug) return workspace.slug;
  return null;
}

// ── Recency-based workspace splitting ────────────────────────────────────

/** Minimum workspace count before stale hiding kicks in */
const STALE_HIDE_MIN_WORKSPACES = 5;
/** Always show at least this many workspaces (backfill from stale if needed) */
const MIN_VISIBLE = 3;
/** Don't bother with "Show N more" if fewer than this would be hidden */
const MIN_STALE_TO_HIDE = 2;
/** Days after which an idle workspace is considered stale */
const STALE_DAYS = 7;

/**
 * Split workspaces into visible and stale (hidden by default).
 *
 * Rules:
 * - Only activates when there are >= STALE_HIDE_MIN_WORKSPACES
 * - Active workspaces (working, error, unread) are always visible
 * - The currently selected workspace is always visible
 * - Idle workspaces updated > STALE_DAYS ago are stale
 * - Always shows at least MIN_VISIBLE workspaces (backfills from stale)
 * - Never hides fewer than MIN_STALE_TO_HIDE (avoids "Show 1 more")
 *
 * @returns [visible, stale] — two arrays, already in the same order as input
 */
export function splitByRecency<T extends Workspace>(
  workspaces: T[],
  selectedWorkspaceId: string | null | undefined
): [visible: T[], stale: T[]] {
  if (workspaces.length < STALE_HIDE_MIN_WORKSPACES) {
    return [workspaces, []];
  }

  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const visibleIds = new Set<string>();

  for (const ws of workspaces) {
    const status = getDisplayStatus(ws);
    const isActive = status !== "idle";
    const isSelected = ws.id === selectedWorkspaceId;
    const isRecent = new Date(ws.updated_at).getTime() >= cutoff;

    if (isActive || isSelected || isRecent) {
      visibleIds.add(ws.id);
    }
  }

  // Backfill from stale so the repo never looks empty
  if (visibleIds.size < MIN_VISIBLE) {
    for (const ws of workspaces) {
      if (visibleIds.size >= MIN_VISIBLE) break;
      if (!visibleIds.has(ws.id)) visibleIds.add(ws.id);
    }
  }

  // Re-derive from original array to preserve sort order
  const visible = workspaces.filter((ws) => visibleIds.has(ws.id));
  const stale = workspaces.filter((ws) => !visibleIds.has(ws.id));

  // Don't bother hiding if only 1 would be hidden ("Show 1 more" is silly)
  if (stale.length < MIN_STALE_TO_HIDE) {
    return [workspaces, []];
  }

  return [visible, stale];
}
