/**
 * Where a window's workspaces run: on the computer whose backend it talks to
 * (`local`) or in that backend's Deus Cloud (`cloud`) — the words
 * `api.createWorkspace` uses for its `location`. The sidebar lists one
 * location at a time; the rest of the app keeps reading the full list.
 */
import type { RepoGroup, Workspace } from "@/shared/types";

export type WorkspaceLocation = "local" | "cloud";

export function locationOf(workspace: Pick<Workspace, "kind">): WorkspaceLocation {
  return workspace.kind === "cloud" ? "cloud" : "local";
}

/** The sidebar's list: every repository stays (a workspace can be started there), only
 *  the workspaces running elsewhere leave. */
export function filterByLocation(groups: RepoGroup[], location: WorkspaceLocation): RepoGroup[] {
  return groups.map((group) => {
    const workspaces = group.workspaces.filter((w) => locationOf(w) === location);
    return workspaces.length === group.workspaces.length ? group : { ...group, workspaces };
  });
}

export interface FollowState {
  /** The selection already followed, so a refresh of the same row never undoes a switch. */
  followedId: string | null;
  location: WorkspaceLocation;
}

/**
 * The window follows a newly selected workspace to where it runs. Only a change of
 * selection moves it: the same selection seen again (a data refresh) leaves a manual
 * switch alone, and a selection not loaded yet waits for its row.
 */
export function followSelection(
  state: FollowState,
  selectedId: string | null,
  selected: Pick<Workspace, "id" | "kind"> | null
): FollowState {
  if (!selectedId) return state.followedId === null ? state : { ...state, followedId: null };
  if (!selected || selected.id !== selectedId || selected.id === state.followedId) return state;
  return { followedId: selected.id, location: locationOf(selected) };
}

/** On a manual switch: the workspace last selected there, if it is still listed there. */
export function workspaceToRestore(
  groups: RepoGroup[],
  lastSelected: Partial<Record<WorkspaceLocation, string>>,
  target: WorkspaceLocation
): string | null {
  const id = lastSelected[target];
  if (!id) return null;
  const listed = groups.some((group) =>
    group.workspaces.some((w) => w.id === id && w.state !== "archived" && locationOf(w) === target)
  );
  return listed ? id : null;
}

/** Where a new workspace starts: the window's location, but cloud only when this
 *  backend is signed in to Deus Cloud. */
export function composerLocation(
  windowLocation: WorkspaceLocation,
  cloudSignedIn: boolean
): WorkspaceLocation {
  return windowLocation === "cloud" && cloudSignedIn ? "cloud" : "local";
}
