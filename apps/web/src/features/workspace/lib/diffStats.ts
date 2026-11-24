/**
 * The sidebar's diff numbers: which workspaces it asks again, and when an open
 * cloud workspace's are read again. The backend answers a cloud workspace's numbers
 * with zeros while its channel is not open or its computer is not awake (it never
 * wakes a sleeping computer for a number), so they are read again at the two moments
 * they can become real: its channel opening (`connectCloudWorkspace` answers once it
 * is open) and its computer waking.
 */
import type { DiffStats, Workspace } from "@/shared/types";
import { getWorkspaceActivity } from "@/features/sidebar/lib/status";
import type { CloudPresence } from "./cloudPresence";

export function isWorkspaceWorking(workspace?: Workspace | null): boolean {
  return !!workspace && getWorkspaceActivity(workspace, {}).working;
}

/**
 * The workspaces to ask for: those with no number yet, and those working. Every
 * other cached number is used as it is.
 */
export function diffStatsToAsk(
  workspaces: Workspace[],
  cached: (id: string) => DiffStats | undefined
): string[] {
  const ask = workspaces
    .filter((workspace) => !cached(workspace.id) || isWorkspaceWorking(workspace))
    .map((workspace) => workspace.id);
  return [...new Set(ask)];
}

/** The cloud workspace that is open, and where its computer stands. */
export interface OpenCloudWorkspace {
  workspaceId: string;
  presence: CloudPresence;
}

/**
 * The open cloud workspace's computer just woke (asleep or waking, then awake, the
 * same workspace both times): its numbers are read again.
 */
export function wokeUp(
  previous: OpenCloudWorkspace | null,
  current: OpenCloudWorkspace | null
): boolean {
  if (!previous || !current || previous.workspaceId !== current.workspaceId) return false;
  return (
    (previous.presence === "asleep" || previous.presence === "waking") &&
    current.presence === "awake"
  );
}
