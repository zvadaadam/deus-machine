/**
 * Where this window is: this computer, or the cloud (in one organization when the
 * backend's list names them). One hook owns it for MainLayout: the stored choice,
 * the backend's pushed value (`cloudOrganizations`), the place the window shows,
 * the menu's rows, the sidebar's filter, following the selection, and switching
 * (by a row, or ⌃1…⌃9). Switching is a view filter: it tears nothing down, so
 * agents in the other places keep running.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { match } from "ts-pattern";
import { toast } from "sonner";
import { capabilities } from "@/platform/capabilities";
import { retryProvision } from "@/platform/native/deus-cloud";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useCloudOrganizations } from "@/shared/hooks/useCloudOrganizations";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { useDeusCloudSignIn } from "@/shared/hooks/useDeusCloudSignIn";
import type { RepoGroup, Workspace } from "@/shared/types";
import { useUnreadStore } from "@/features/session/store/unreadStore";
import { useWorkspaceLayoutStore } from "@/features/workspace/store/workspaceLayoutStore";
import {
  cloudRowState,
  filterByPlace,
  placeActivity,
  workspaceActivity,
  followSelection,
  organizationRowState,
  placeKey,
  placeRows,
  visiblePlace,
  workspaceToRestore,
  type Organizations,
  type Place,
  type PlaceActivity,
  type PlaceRow,
} from "../lib/location";
import {
  finishCloudSignIn,
  retryCloudSetup,
  startCloudSignIn,
  useSidebarStore,
} from "../store/sidebarStore";

export interface WindowPlace {
  place: Place;
  organizations: Organizations;
  /** The menu's rows, and the key of the one the window is in. */
  rows: PlaceRow[];
  current: string;
  /** Working or unread workspaces, by place key: the menu's dots. */
  activity: Partial<Record<string, PlaceActivity>>;
  /** The sidebar's list: the place's workspaces only. */
  repositories: RepoGroup[];
  /** Choose a row: switch there, or do what it says (sign in, set up, nothing). */
  choose: (row: PlaceRow) => void;
  /** ⌃1…⌃9: the row at that index, if any. */
  chooseIndex: (index: number) => void;
}

export function useWindowPlace({
  repoGroups,
  selectedWorkspaceId,
  selectedWorkspace,
  openWorkspace,
  selectWorkspace,
}: {
  repoGroups: RepoGroup[];
  selectedWorkspaceId: string | null;
  selectedWorkspace: Workspace | null;
  /** Open a workspace the way a sidebar row does. */
  openWorkspace: (workspace: Workspace) => void;
  selectWorkspace: (id: string | null) => void;
}): WindowPlace {
  // The hosted web app has only the cloud: no computer row, and always in the cloud.
  const webDirect = isCloudDirectWebMode();
  const organizations = useCloudOrganizations();
  const session = useDeusCloudSession().data;
  const signIn = useDeusCloudSignIn();
  const startSignIn = signIn.mutateAsync;
  const storedLocation = useSidebarStore((s) => s.location);
  const storedOrganization = useSidebarStore((s) => s.cloudOrganizationId);
  const retrying = useSidebarStore((s) => s.cloudSetupRetrying);
  const pending = useSidebarStore((s) => s.cloudPending);
  // Where the window is by the person's doing: the stored place and the selection. A
  // sign-in or setup started from the menu ends once either changes.
  const storedKey = placeKey({
    location: storedLocation,
    organizationId: storedLocation === "cloud" ? storedOrganization : null,
  });
  const where = useMemo(
    () => ({ place: storedKey, selectedId: selectedWorkspaceId }),
    [storedKey, selectedWorkspaceId]
  );

  const canSetUp = capabilities.deusCloudSignIn;
  const cloudRow = cloudRowState({
    available: webDirect ? true : organizations?.available,
    session,
    signingIn: signIn.isPending,
    retrying,
    canSignIn: canSetUp,
  });
  const organizationRow = useCallback(
    (org: { ready: boolean }) =>
      organizationRowState({ ready: org.ready, session, retrying, canSetUp }),
    [session, retrying, canSetUp]
  );
  const rows = useMemo(
    () => placeRows({ organizations, withComputer: !webDirect, cloudRow, organizationRow }),
    [organizations, webDirect, cloudRow, organizationRow]
  );

  // A cloud it cannot reach is not where the window sits; the stored choice stays.
  const place = visiblePlace(
    { location: webDirect ? "cloud" : storedLocation, organizationId: storedOrganization },
    organizations,
    selectedWorkspace
  );
  const current = placeKey(place);
  const placeLocation = place.location;
  const placeOrganization = place.organizationId;
  const repositories = useMemo(
    () =>
      filterByPlace(
        repoGroups,
        { location: placeLocation, organizationId: placeOrganization },
        organizations
      ),
    [repoGroups, placeLocation, placeOrganization, organizations]
  );

  // The sidebar lists one place; the menu marks the others' working and unread workspaces.
  const unreadSessionIds = useUnreadStore((s) => s.unreadSessionIds);
  const layouts = useWorkspaceLayoutStore((s) => s.layouts);
  const activity = useMemo(
    () =>
      placeActivity(repoGroups, organizations, (workspace) =>
        workspaceActivity(workspace, layouts[workspace.id]?.chatTabSessionIds, unreadSessionIds)
      ),
    [repoGroups, organizations, layouts, unreadSessionIds]
  );

  // The place follows a newly selected workspace (from anywhere), so the sidebar
  // always contains it; a refresh of the same selection never undoes a manual switch.
  const follow = useRef<{ followedId: string | null; followedKey: string | null }>({
    followedId: null,
    followedKey: null,
  });
  useEffect(() => {
    const store = useSidebarStore.getState();
    const stored: Place = { location: store.location, organizationId: store.cloudOrganizationId };
    const state = { ...follow.current, place: stored };
    const next = followSelection(state, selectedWorkspaceId, selectedWorkspace, organizations);
    if (next === state) return;
    follow.current = { followedId: next.followedId, followedKey: next.followedKey };
    if (next.followedId && next.followedKey) {
      store.rememberSelection(next.followedKey, next.followedId);
    }
    store.setPlace(next.place);
  }, [selectedWorkspaceId, selectedWorkspace, organizations]);

  // A manual switch: back to the workspace last selected there this session, through
  // the row-click path, or Home.
  const latest = useRef({ repoGroups, organizations, current });
  useEffect(() => {
    latest.current = { repoGroups, organizations, current };
  });
  const switchTo = useCallback(
    (target: Place) => {
      const { repoGroups: groups, organizations: orgs, current: here } = latest.current;
      const store = useSidebarStore.getState();
      store.setPlace(target);
      // A place naming no organization is the one last chosen.
      const resolved = visiblePlace(
        {
          location: target.location,
          organizationId: useSidebarStore.getState().cloudOrganizationId,
        },
        orgs,
        null
      );
      if (placeKey(resolved) === here) return;
      const restoreId = workspaceToRestore(groups, store.lastSelectedByPlace, resolved, orgs);
      const restore = restoreId
        ? groups.flatMap((g) => g.workspaces).find((w) => w.id === restoreId)
        : undefined;
      if (restore) openWorkspace(restore);
      else selectWorkspace(null);
    },
    [openWorkspace, selectWorkspace]
  );

  const whereRef = useRef(where);
  useEffect(() => {
    whereRef.current = where;
  });
  const setUp = useCallback((organizationId: string | null) => {
    void retryCloudSetup(retryProvision, organizationId, { from: whereRef.current }).then(
      (result) => {
        if (!result.ok) toast.error(result.error ?? "Cloud setup failed");
      }
    );
  }, []);

  const choose = useCallback(
    (row: PlaceRow) =>
      match(row)
        .with({ kind: "local" }, (local) => switchTo(local.place))
        .with({ kind: "cloud" }, (cloud) =>
          match(cloud.state)
            .with("ready", () => switchTo(cloud.place))
            .with("sign-in", () => void startCloudSignIn(() => startSignIn(), whereRef.current))
            .with("retry", () => setUp(null))
            .with("unavailable", "signing-in", "setting-up", () => undefined)
            .exhaustive()
        )
        .with({ kind: "organization" }, (org) =>
          match(org.state)
            .with("ready", () => switchTo(org.place))
            .with("set-up", () => setUp(org.place.organizationId))
            .with("unavailable", "setting-up", () => undefined)
            .exhaustive()
        )
        .exhaustive(),
    [switchTo, startSignIn, setUp]
  );
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  });
  const chooseIndex = useCallback(
    (index: number) => {
      const row = rowsRef.current[index];
      if (row) choose(row);
    },
    [choose]
  );

  // A sign-in or setup started from the menu: the window moves once the pushed value
  // says the place it waits for is reachable; it ends once the person went elsewhere.
  useEffect(() => {
    finishCloudSignIn({ organizations, cloudRow, organizationRow, here: where }, switchTo);
  }, [pending, organizations, cloudRow, organizationRow, where, switchTo]);

  return { place, organizations, rows, current, activity, repositories, choose, chooseIndex };
}
