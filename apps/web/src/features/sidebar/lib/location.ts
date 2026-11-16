/**
 * Where a window's workspaces run: on the computer whose backend it talks to
 * (`local`) or in that backend's Deus Cloud (`cloud`) — the words
 * `api.createWorkspace` uses for its `location`. In the cloud the window is in
 * one organization when the backend's list names them (`cloudOrganizations`);
 * without a list there is one nameless cloud. The sidebar lists one place at a
 * time; the rest of the app keeps reading the full list.
 */
import { match } from "ts-pattern";
import { githubRepoSlug } from "@shared/git-origin";
import type { DeusCloudSessionStatus } from "@shared/types/deus-cloud-auth";
import type { CloudOrganizations } from "@shared/types/environment-secrets";
import type { RepoGroup, Workspace } from "@/shared/types";
import { getDisplayStatus } from "./status";

export type WorkspaceLocation = "local" | "cloud";

/** A workspace's `kind` ("worktree" | "cloud") in the location's words. */
export function locationOf(workspace: { kind?: string | null }): WorkspaceLocation {
  return workspace.kind === "cloud" ? "cloud" : "local";
}

/** The cloud's name when no organization can be named. */
export const CLOUD_LABEL = "Deus Cloud";

/**
 * A place a window can be: this computer, or the cloud. In the cloud,
 * `organizationId` is the organization, or null where none is named (no list yet,
 * signed out, a developer key), which means the one cloud.
 */
export interface Place {
  location: WorkspaceLocation;
  organizationId: string | null;
}

export const THIS_COMPUTER: Place = { location: "local", organizationId: null };

/** A place as a key: `local`, `cloud`, or `cloud:<organization>`. */
export function placeKey(place: Place): string {
  if (place.location === "local") return "local";
  return place.organizationId ? `cloud:${place.organizationId}` : "cloud";
}

/** What the rules read of `cloudOrganizations`; undefined until it arrives. */
export type Organizations =
  | Pick<CloudOrganizations, "available" | "defaultOrganizationId" | "items">
  | undefined;

type CloudWorkspace = Pick<Workspace, "kind" | "organization_id">;

/** The list names organizations: the menu has a row for each, the sidebar filters by them. */
export function namesOrganizations(organizations: Organizations): boolean {
  return (organizations?.items.length ?? 0) > 0;
}

/** The default organization, if the list names it, else the first listed; null with no list. */
function defaultOrganization(organizations: Organizations): string | null {
  const items = organizations?.items ?? [];
  const named = items.find((org) => org.id === organizations?.defaultOrganizationId);
  return (named ?? items[0])?.id ?? null;
}

/**
 * The organization a window in the cloud shows: the one last chosen, if the list names
 * it, else the default one, else the first listed; with no list, none.
 */
export function chosenOrganization(
  stored: string | null,
  organizations: Organizations
): string | null {
  if (stored && organizations?.items.some((org) => org.id === stored)) return stored;
  return defaultOrganization(organizations);
}

/**
 * Where a workspace runs. A cloud workspace's organization is its own, else the
 * default one (rows from before organizations were recorded); one the list does not
 * name is shown in the default one, so it is never listed nowhere.
 */
export function placeOf(workspace: CloudWorkspace, organizations: Organizations): Place {
  if (locationOf(workspace) === "local") return THIS_COMPUTER;
  if (!namesOrganizations(organizations)) return { location: "cloud", organizationId: null };
  return {
    location: "cloud",
    organizationId: chosenOrganization(
      workspace.organization_id ?? organizations?.defaultOrganizationId ?? null,
      organizations
    ),
  };
}

const samePlace = (a: Place, b: Place) => placeKey(a) === placeKey(b);

/**
 * Where the window is: the stored place, except that a cloud this backend cannot
 * reach (`available === false`) is not a place a window sits, unless a cloud
 * workspace is selected. Not known yet keeps the stored place. In the cloud, the
 * organization is the chosen one. The stored value is never changed here, so the
 * window returns to the cloud once it is reachable.
 */
export function visiblePlace(
  stored: { location: WorkspaceLocation; organizationId: string | null },
  organizations: Organizations,
  selected: Pick<Workspace, "kind"> | null | undefined
): Place {
  if (stored.location === "local") return THIS_COMPUTER;
  const unreachable = organizations?.available === false;
  if (unreachable && selected?.kind !== "cloud") return THIS_COMPUTER;
  return {
    location: "cloud",
    organizationId: chosenOrganization(stored.organizationId, organizations),
  };
}

/**
 * The location menu's cloud row when there is no list to name organizations: what it
 * says, and what choosing it (or ⌃2) does.
 * - `ready`: switch to the cloud (also while nothing is known yet).
 * - `unavailable`: signed out where only the desktop app can sign in; "Not signed in",
 *   disabled.
 * - `signing-in`: the browser sign-in is running; "Signing in…", nothing.
 * - `setting-up`: signed in, this computer's cloud key is being made; "Setting up…",
 *   nothing.
 * - `retry`: signed in, but the key failed, the keychain is locked, or the backend
 *   lacks the key; "Retry" makes it again.
 * - `sign-in`: signed out; "Sign in".
 */
export type CloudRowState =
  | "ready"
  | "unavailable"
  | "signing-in"
  | "setting-up"
  | "retry"
  | "sign-in";

/** What the desktop's own session says about this computer's cloud. */
type CloudSession = Pick<
  DeusCloudSessionStatus,
  "signedIn" | "hasPlatformKey" | "platformKeyError" | "vaultLocked"
>;

export function cloudRowState({
  available,
  session,
  signingIn,
  retrying = false,
  canSignIn,
}: {
  /** The backend's `available`; undefined until its value arrives. */
  available: boolean | undefined;
  session: CloudSession | undefined;
  /** The sign-in started from the menu is running. */
  signingIn: boolean;
  /** A Retry started from the menu is running. */
  retrying?: boolean;
  /** This window can sign in (the desktop app). */
  canSignIn: boolean;
}): CloudRowState {
  if (!canSignIn) return available === false ? "unavailable" : "ready";
  if (signingIn) return "signing-in";
  if (available !== false) return "ready";
  if (retrying) return "setting-up";
  if (!session?.signedIn) return "sign-in";
  if (session.platformKeyError || session.vaultLocked || session.hasPlatformKey) return "retry";
  return "setting-up";
}

/**
 * An organization's row.
 * - `ready`: this backend can act there; choosing it switches.
 * - `set-up`: on the desktop, it is not set up on this computer; "Set up" runs the
 *   cloud setup again, and the window moves there once it is ready.
 * - `setting-up`: that setup, or the one after sign-in, is running; "Setting up…".
 * - `unavailable`: not set up, where only the desktop app can set it up; "Not set
 *   up", disabled.
 */
export type OrganizationRowState = "ready" | "set-up" | "setting-up" | "unavailable";

export function organizationRowState({
  ready,
  session,
  retrying,
  canSetUp,
}: {
  ready: boolean;
  session: CloudSession | undefined;
  /** A setup started from the menu is running. */
  retrying: boolean;
  /** This window can set the cloud up (the desktop app). */
  canSetUp: boolean;
}): OrganizationRowState {
  if (ready) return "ready";
  if (!canSetUp) return "unavailable";
  if (retrying) return "setting-up";
  // Signed in with no key yet and nothing wrong: the keys made after sign-in are on the way.
  const minting =
    session?.signedIn &&
    !session.hasPlatformKey &&
    !session.platformKeyError &&
    !session.vaultLocked;
  return minting ? "setting-up" : "set-up";
}

/** What an organization that cannot be chosen yet says, in every menu that lists it. */
export function organizationRowHint(state: OrganizationRowState): string | null {
  return match(state)
    .with("ready", () => null)
    .with("set-up", () => "Set up")
    .with("setting-up", () => "Setting up…")
    .with("unavailable", () => "Not set up")
    .exhaustive();
}

/** A row of the location menu. `shortcut` is its ⌃ digit (the first nine rows). */
export type PlaceRow =
  | { kind: "local"; key: string; place: Place; shortcut: string | null }
  | { kind: "cloud"; key: string; place: Place; state: CloudRowState; shortcut: string | null }
  | {
      kind: "organization";
      key: string;
      place: Place;
      name: string;
      state: OrganizationRowState;
      shortcut: string | null;
    };

/**
 * The location menu's rows: this computer first (where there is one), then one row
 * per organization in the list's order, or the one cloud row when there is no list.
 */
export function placeRows({
  organizations,
  withComputer,
  cloudRow,
  organizationRow,
}: {
  organizations: Organizations;
  /** The window's backend is a computer (not the hosted web). */
  withComputer: boolean;
  cloudRow: CloudRowState;
  organizationRow: (organization: { id: string; ready: boolean }) => OrganizationRowState;
}): PlaceRow[] {
  const shortcut = (index: number) => (index < 9 ? `⌃${index + 1}` : null);
  const first = withComputer ? 1 : 0;
  const cloud: PlaceRow[] = namesOrganizations(organizations)
    ? organizations!.items.map((org, index) => {
        const place: Place = { location: "cloud", organizationId: org.id };
        return {
          kind: "organization",
          key: placeKey(place),
          place,
          name: org.name,
          state: organizationRow(org),
          shortcut: shortcut(first + index),
        };
      })
    : [
        {
          kind: "cloud",
          key: "cloud",
          place: { location: "cloud", organizationId: null },
          state: cloudRow,
          shortcut: shortcut(first),
        },
      ];
  if (!withComputer) return cloud;
  return [{ kind: "local", key: "local", place: THIS_COMPUTER, shortcut: shortcut(0) }, ...cloud];
}

/** Whether choosing the row switches to its place (otherwise it does what it says). */
export function rowSwitches(row: PlaceRow): boolean {
  return match(row)
    .with({ kind: "local" }, () => true)
    .with({ kind: "cloud" }, (cloud) => cloud.state === "ready")
    .with({ kind: "organization" }, (org) => org.state === "ready")
    .exhaustive();
}

/**
 * Whether a project can run in a place: on this computer when it has a folder
 * here, in the cloud when its origin is on GitHub. A group that does not say
 * whether it has a folder (the hosted web's) is taken to have one.
 */
export function projectRunsIn(
  group: Pick<RepoGroup, "has_folder" | "git_origin_url">,
  location: WorkspaceLocation
): boolean {
  return match(location)
    .with("local", () => group.has_folder !== false)
    .with("cloud", () => githubRepoSlug(group.git_origin_url ?? "") !== null)
    .exhaustive();
}

/**
 * "New workspace from a pull request or branch" makes a local workspace from
 * the project's GitHub repository: offered only with the window on this
 * computer, for a project with a folder here. (In the cloud, the composer's
 * branch picker starts a workspace from a branch.)
 */
export function offersNewFromBranch(
  windowLocation: WorkspaceLocation,
  project: Pick<RepoGroup, "has_folder" | "git_origin_url">
): boolean {
  return (
    windowLocation === "local" &&
    projectRunsIn(project, "local") &&
    githubRepoSlug(project.git_origin_url ?? "") !== null
  );
}

/**
 * The sidebar's list: the projects that can run in the place (a workspace can be
 * started there) and any project with a workspace in it, each with only the
 * place's workspaces.
 */
export function filterByPlace(
  groups: RepoGroup[],
  place: Place,
  organizations: Organizations
): RepoGroup[] {
  return groups.flatMap((group) => {
    const workspaces = group.workspaces.filter((w) => samePlace(placeOf(w, organizations), place));
    if (workspaces.length === 0 && !projectRunsIn(group, place.location)) return [];
    return [workspaces.length === group.workspaces.length ? group : { ...group, workspaces }];
  });
}

export interface FollowState {
  /** The selection already followed, and the place it was in, so a refresh of the same
   *  row never undoes a switch. */
  followedId: string | null;
  followedKey: string | null;
  place: Place;
}

/**
 * The window follows a newly selected workspace to where it runs. Only a change of
 * selection moves it, or the same selection found in another place (its organization
 * became known): the same selection seen again (a data refresh) leaves a manual
 * switch alone, and a selection not loaded yet waits for its row.
 */
export function followSelection(
  state: FollowState,
  selectedId: string | null,
  selected: (CloudWorkspace & Pick<Workspace, "id">) | null,
  organizations: Organizations
): FollowState {
  if (!selectedId) {
    return state.followedId === null ? state : { ...state, followedId: null, followedKey: null };
  }
  if (!selected || selected.id !== selectedId) return state;
  const place = placeOf(selected, organizations);
  const key = placeKey(place);
  if (selected.id === state.followedId && key === state.followedKey) return state;
  return { followedId: selected.id, followedKey: key, place };
}

/** On a manual switch: the workspace last selected there, if it is still listed there. */
export function workspaceToRestore(
  groups: RepoGroup[],
  lastSelected: Partial<Record<string, string>>,
  target: Place,
  organizations: Organizations
): string | null {
  const id = lastSelected[placeKey(target)];
  if (!id) return null;
  const listed = groups.some((group) =>
    group.workspaces.some(
      (w) => w.id === id && w.state !== "archived" && samePlace(placeOf(w, organizations), target)
    )
  );
  return listed ? id : null;
}

/**
 * Where a new workspace starts: the window's place, but the cloud only when the
 * window's organization is ready (or, with no list, when the cloud is available).
 */
export function composerPlace(windowPlace: Place, organizations: Organizations): Place {
  if (windowPlace.location !== "cloud") return THIS_COMPUTER;
  if (namesOrganizations(organizations)) {
    const org = organizations!.items.find((o) => o.id === windowPlace.organizationId);
    return org?.ready ? windowPlace : THIS_COMPUTER;
  }
  return organizations?.available ? windowPlace : THIS_COMPUTER;
}

/**
 * The composer's switch is on only where a create would be accepted: once its
 * organization is known not to be ready (or, with no list, the cloud known not
 * available), it is this computer. Turning it on again is the access gate's, once the
 * organization is ready and its verdict is a go.
 */
export function composerSwitch(
  location: WorkspaceLocation,
  cloudReady: boolean | undefined
): WorkspaceLocation {
  return location === "cloud" && cloudReady === false ? "local" : location;
}

/**
 * The composer's organization, its own state: a choice made in the composer, and the
 * window's organization it was made against. The window's changing resets the choice.
 */
export interface ComposerOrganization {
  windowOrganizationId: string | null;
  choice: string | null;
}

/** The window's organization changed: the composer follows it, dropping its own choice. */
export function followWindowOrganization(
  state: ComposerOrganization,
  windowOrganizationId: string | null
): ComposerOrganization {
  if (state.windowOrganizationId === windowOrganizationId) return state;
  return { windowOrganizationId, choice: null };
}

/** The organization a composer creates in: its own choice if the list names it, else the window's. */
export function composerOrganization(
  state: ComposerOrganization,
  organizations: Organizations
): string | null {
  const { choice } = state;
  if (choice && organizations?.items.some((org) => org.id === choice)) return choice;
  return state.windowOrganizationId;
}

/** Where the window was, by the person's own doing: its place and its selected workspace. */
export interface WindowWhere {
  /** `placeKey` of the stored place. */
  place: string;
  selectedId: string | null;
}

/**
 * A sign-in or a setup started from the menu: take the window to `organizationId`
 * (or, with none, the cloud) once it is reachable, unless the person went somewhere
 * else first. `from` is where the window was when it started.
 */
export interface CloudIntent {
  organizationId: string | null;
  from: WindowWhere;
}

/**
 * A sign-in or a setup started from the menu, as the backend's value or the window
 * changes: the place to move the window to once it is reachable (an organization set
 * up, or, with none named, the cloud), `end` once it no longer applies, or `wait`. It
 * ends when the person went elsewhere (switched place, selected another workspace or
 * none), when its organization is not listed (signed out, or no longer a member), when
 * that organization is back to "Set up" (its setup is over and did not make it ready),
 * and when the cloud setup failed (the one cloud row would offer Retry).
 */
export function pendingCloudOutcome(
  pending: CloudIntent,
  {
    organizations,
    cloudRow,
    organizationRow,
    here,
  }: {
    organizations: Organizations;
    cloudRow: CloudRowState;
    /** What an organization's row in the menu says now. */
    organizationRow: (organization: { id: string; ready: boolean }) => OrganizationRowState;
    here: WindowWhere;
  }
): Place | "wait" | "end" {
  if (pending.from.place !== here.place || pending.from.selectedId !== here.selectedId) {
    return "end";
  }
  if (pending.organizationId) {
    if (!organizations) return "wait";
    const org = organizations.items.find((o) => o.id === pending.organizationId);
    if (!org) return "end";
    if (org.ready) return { location: "cloud", organizationId: org.id };
    return organizationRow(org) === "set-up" ? "end" : "wait";
  }
  if (organizations?.available === true) return { location: "cloud", organizationId: null };
  if (cloudRow === "retry") return "end";
  return "wait";
}

/**
 * Activity a place's rows do not show while the sidebar lists another place: a
 * workspace whose agent is working, or whose reply is unread. Across a place's
 * workspaces, unread outranks working.
 */
export type PlaceActivity = "unread" | "working";

/**
 * A workspace's activity by the sidebar row's own signals: unread when any of its
 * chats (its tabs, else its current chat) has an unseen reply or needs an answer,
 * working while its agent runs.
 */
export function workspaceActivity(
  workspace: Workspace,
  tabSessionIds: string[] | undefined,
  unreadSessionIds: Partial<Record<string, boolean>>
): PlaceActivity | null {
  const sessionIds = tabSessionIds?.length
    ? tabSessionIds
    : workspace.current_session_id
      ? [workspace.current_session_id]
      : [];
  const unseen = sessionIds.some((id) => unreadSessionIds[id]);
  return match(getDisplayStatus(workspace, unseen))
    .with("unread", () => "unread" as const)
    .with("working", () => "working" as const)
    .with("idle", "error", () => null)
    .exhaustive();
}

/** Each place's activity, by place key; a place with none is absent. Archived workspaces are not counted. */
export function placeActivity(
  groups: RepoGroup[],
  organizations: Organizations,
  activityOf: (workspace: Workspace) => PlaceActivity | null
): Partial<Record<string, PlaceActivity>> {
  const byPlace: Partial<Record<string, PlaceActivity>> = {};
  for (const workspace of groups.flatMap((group) => group.workspaces)) {
    if (workspace.state === "archived") continue;
    const activity = activityOf(workspace);
    if (!activity) continue;
    const key = placeKey(placeOf(workspace, organizations));
    if (byPlace[key] !== "unread") byPlace[key] = activity;
  }
  return byPlace;
}

/** What the header's trigger shows: the strongest activity in a place other than the window's. */
export function activityElsewhere(
  activity: Partial<Record<string, PlaceActivity>>,
  currentKey: string
): PlaceActivity | null {
  let found: PlaceActivity | null = null;
  for (const [key, value] of Object.entries(activity)) {
    if (key === currentKey || !value) continue;
    if (value === "unread") return "unread";
    found = value;
  }
  return found;
}
