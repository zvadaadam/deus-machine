import { describe, expect, it } from "vitest";
import {
  chosenOrganization,
  cloudRowState,
  composerOrganization,
  composerPlace,
  filterByPlace,
  followSelection,
  followWindowOrganization,
  organizationRowHint,
  organizationRowState,
  pendingCloudOutcome,
  placeKey,
  placeOf,
  placeRows,
  rowSwitches,
  THIS_COMPUTER,
  visiblePlace,
  workspaceToRestore,
  type CloudRowState,
  type ComposerOrganization,
  type FollowState,
  type Organizations,
  type Place,
} from "@/features/sidebar/lib/location";
import type { RepoGroup, Workspace } from "@/shared/types";

const ws = (
  id: string,
  kind: Workspace["kind"],
  state: Workspace["state"] = "ready",
  organization_id: string | null = null
) => ({ id, kind, state, organization_id, repository_id: "repo" }) as Workspace;

const CLOUD: Place = { location: "cloud", organizationId: null };
const inOrg = (organizationId: string): Place => ({ location: "cloud", organizationId });

const groups: RepoGroup[] = [
  {
    repo_id: "repo",
    repo_name: "deus",
    sort_order: 0,
    workspaces: [
      ws("local-a", "worktree"),
      ws("cloud-a", "cloud"),
      ws("old", "worktree", "archived"),
    ],
  },
  { repo_id: "cloud-only", repo_name: "api", sort_order: 1, workspaces: [ws("cloud-b", "cloud")] },
  {
    repo_id: "empty",
    repo_name: "docs",
    sort_order: 2,
    git_origin_url: "git@github.com:acme/docs.git",
    has_folder: true,
    workspaces: [],
  },
];

// Two organizations: Acme (the default, set up here) and Beta (set up too), and a
// workspace in each, one naming none (Acme's, the default), one naming an organization
// the list does not have.
const orgs: Organizations = {
  available: true,
  defaultOrganizationId: "acme",
  items: [
    { id: "acme", name: "Acme", role: "owner", ready: true },
    { id: "beta", name: "Beta", role: "member", ready: true },
  ],
};
const orgGroups: RepoGroup[] = [
  {
    repo_id: "repo",
    repo_name: "deus",
    sort_order: 0,
    workspaces: [
      ws("local-a", "worktree"),
      ws("in-acme", "cloud", "ready", "acme"),
      ws("in-beta", "cloud", "ready", "beta"),
      ws("unnamed", "cloud"),
      ws("gone-org", "cloud", "ready", "left"),
    ],
  },
];

const ids = (list: RepoGroup[]) => list.map((g) => [g.repo_id, g.workspaces.map((w) => w.id)]);

describe("placeOf (where a workspace runs)", () => {
  it("is this computer for a local workspace, and the one cloud with no list", () => {
    expect(placeOf(ws("l", "worktree"), orgs)).toEqual(THIS_COMPUTER);
    expect(placeOf(ws("c", "cloud", "ready", "beta"), undefined)).toEqual(CLOUD);
    expect(placeOf(ws("c", "cloud", "ready", "beta"), { ...orgs!, items: [] })).toEqual(CLOUD);
  });

  it("is the workspace's organization, else the default one", () => {
    expect(placeOf(ws("c", "cloud", "ready", "beta"), orgs)).toEqual(inOrg("beta"));
    expect(placeOf(ws("c", "cloud"), orgs)).toEqual(inOrg("acme"));
    // An organization the list does not name: shown in the default one, never nowhere.
    expect(placeOf(ws("c", "cloud", "ready", "left"), orgs)).toEqual(inOrg("acme"));
  });

  it("keys places by organization", () => {
    expect([THIS_COMPUTER, CLOUD, inOrg("beta")].map(placeKey)).toEqual([
      "local",
      "cloud",
      "cloud:beta",
    ]);
  });
});

describe("chosenOrganization (the organization a window in the cloud shows)", () => {
  it("is the one last chosen when listed, else the default, else the first, else none", () => {
    expect(chosenOrganization("beta", orgs)).toBe("beta");
    expect(chosenOrganization("gone", orgs)).toBe("acme");
    expect(chosenOrganization(null, orgs)).toBe("acme");
    expect(chosenOrganization(null, { ...orgs!, defaultOrganizationId: "elsewhere" })).toBe("acme");
    expect(chosenOrganization("beta", undefined)).toBeNull();
  });
});

describe("filterByPlace", () => {
  it("lists only the place's workspaces and keeps every repository", () => {
    expect(ids(filterByPlace(groups, THIS_COMPUTER, undefined))).toEqual([
      ["repo", ["local-a", "old"]],
      ["cloud-only", []],
      ["empty", []],
    ]);
    expect(ids(filterByPlace(groups, CLOUD, undefined))).toEqual([
      ["repo", ["cloud-a"]],
      ["cloud-only", ["cloud-b"]],
      ["empty", []],
    ]);
  });

  it("lists an organization's cloud workspaces only", () => {
    expect(ids(filterByPlace(orgGroups, inOrg("acme"), orgs))).toEqual([
      ["repo", ["in-acme", "unnamed", "gone-org"]],
    ]);
    expect(ids(filterByPlace(orgGroups, inOrg("beta"), orgs))).toEqual([["repo", ["in-beta"]]]);
    expect(ids(filterByPlace(orgGroups, THIS_COMPUTER, orgs))).toEqual([["repo", ["local-a"]]]);
  });

  it("lists on this computer the projects with a folder, in the cloud those on GitHub", () => {
    const projects: RepoGroup[] = [
      // A folder here, on GitHub: runs in both places.
      {
        repo_id: "both",
        repo_name: "both",
        sort_order: 0,
        git_origin_url: "https://github.com/acme/both",
        has_folder: true,
        workspaces: [],
      },
      // Added from GitHub, no folder here: the cloud only.
      {
        repo_id: "cloud",
        repo_name: "cloud",
        sort_order: 1,
        git_origin_url: "https://github.com/acme/cloud",
        has_folder: false,
        workspaces: [],
      },
      // A folder with no remote, or one not on GitHub: this computer only.
      { repo_id: "plain", repo_name: "plain", sort_order: 2, has_folder: true, workspaces: [] },
      {
        repo_id: "gitlab",
        repo_name: "gitlab",
        sort_order: 3,
        git_origin_url: "https://gitlab.com/acme/lab",
        has_folder: true,
        workspaces: [],
      },
      // Not GitHub but with a cloud workspace (made before the rule): listed in the cloud.
      {
        repo_id: "kept",
        repo_name: "kept",
        sort_order: 4,
        has_folder: true,
        workspaces: [ws("kept-cloud", "cloud")],
      },
      // No folder, but a local workspace from before: listed on this computer.
      {
        repo_id: "left",
        repo_name: "left",
        sort_order: 5,
        git_origin_url: "https://github.com/acme/left",
        has_folder: false,
        workspaces: [ws("left-local", "worktree", "archived")],
      },
    ];
    expect(ids(filterByPlace(projects, THIS_COMPUTER, undefined))).toEqual([
      ["both", []],
      ["plain", []],
      ["gitlab", []],
      ["kept", []],
      ["left", ["left-local"]],
    ]);
    expect(ids(filterByPlace(projects, CLOUD, undefined))).toEqual([
      ["both", []],
      ["cloud", []],
      ["kept", ["kept-cloud"]],
      ["left", []],
    ]);
    expect(ids(filterByPlace(projects, inOrg("beta"), orgs))).toEqual([
      ["both", []],
      ["cloud", []],
      ["left", []],
    ]);
  });

  it("takes a group that does not say (the hosted web's) to have a folder", () => {
    const hosted: RepoGroup[] = [
      { repo_id: "x", repo_name: "x", sort_order: 0, workspaces: [ws("c", "cloud")] },
    ];
    expect(ids(filterByPlace(hosted, CLOUD, undefined))).toEqual([["x", ["c"]]]);
    expect(ids(filterByPlace(hosted, THIS_COMPUTER, undefined))).toEqual([["x", []]]);
  });

  it("keeps a group's identity when nothing in it was filtered", () => {
    const local = filterByPlace(groups, THIS_COMPUTER, undefined);
    expect(local[2]).toBe(groups[2]);
    expect(local[0]).not.toBe(groups[0]);
    expect(groups[0].workspaces).toHaveLength(3);
  });
});

describe("followSelection", () => {
  const local: FollowState = { followedId: null, followedKey: null, place: THIS_COMPUTER };

  it("moves the window to a newly selected workspace's place", () => {
    expect(followSelection(local, "cloud-a", ws("cloud-a", "cloud"), undefined)).toEqual({
      followedId: "cloud-a",
      followedKey: "cloud",
      place: CLOUD,
    });
    expect(
      followSelection(
        { followedId: "cloud-a", followedKey: "cloud", place: CLOUD },
        "local-a",
        ws("local-a", "worktree"),
        undefined
      )
    ).toEqual({ followedId: "local-a", followedKey: "local", place: THIS_COMPUTER });
  });

  it("moves the window to the selected workspace's organization", () => {
    const inAcme: FollowState = {
      followedId: "in-acme",
      followedKey: "cloud:acme",
      place: inOrg("acme"),
    };
    expect(
      followSelection(inAcme, "in-beta", ws("in-beta", "cloud", "ready", "beta"), orgs).place
    ).toEqual(inOrg("beta"));
  });

  it("never undoes a manual switch when the same selection is seen again", () => {
    // Followed cloud-a, then the user switched to local by hand; a data refresh re-renders.
    const switched: FollowState = {
      followedId: "cloud-a",
      followedKey: "cloud",
      place: THIS_COMPUTER,
    };
    expect(followSelection(switched, "cloud-a", ws("cloud-a", "cloud"), undefined)).toBe(switched);
  });

  it("follows the same selection again once its organization becomes known", () => {
    // Selected before the list arrived: the one cloud. The list names its organization.
    const early = followSelection(
      local,
      "in-beta",
      ws("in-beta", "cloud", "ready", "beta"),
      undefined
    );
    expect(early.place).toEqual(CLOUD);
    const known = followSelection(early, "in-beta", ws("in-beta", "cloud", "ready", "beta"), orgs);
    expect(known.place).toEqual(inOrg("beta"));
    expect(followSelection(known, "in-beta", ws("in-beta", "cloud", "ready", "beta"), orgs)).toBe(
      known
    );
  });

  it("waits for a selection whose row has not loaded", () => {
    expect(followSelection(local, "cloud-a", null, undefined)).toBe(local);
  });

  it("forgets the followed selection when it is cleared, so selecting it again follows", () => {
    const cleared = followSelection(
      { followedId: "cloud-a", followedKey: "cloud", place: THIS_COMPUTER },
      null,
      null,
      undefined
    );
    expect(cleared).toEqual({ followedId: null, followedKey: null, place: THIS_COMPUTER });
    expect(followSelection(cleared, "cloud-a", ws("cloud-a", "cloud"), undefined).place).toEqual(
      CLOUD
    );
  });
});

describe("workspaceToRestore (manual switch)", () => {
  it("returns the workspace last selected in the target place", () => {
    const memory = { local: "local-a", cloud: "cloud-b" };
    expect(workspaceToRestore(groups, memory, CLOUD, undefined)).toBe("cloud-b");
    expect(workspaceToRestore(groups, memory, THIS_COMPUTER, undefined)).toBe("local-a");
  });

  it("remembers each organization apart", () => {
    const memory = { "cloud:acme": "in-acme", "cloud:beta": "in-beta" };
    expect(workspaceToRestore(orgGroups, memory, inOrg("acme"), orgs)).toBe("in-acme");
    expect(workspaceToRestore(orgGroups, memory, inOrg("beta"), orgs)).toBe("in-beta");
    // A remembered id that runs in another organization is not restored into this one.
    expect(
      workspaceToRestore(orgGroups, { "cloud:beta": "in-acme" }, inOrg("beta"), orgs)
    ).toBeNull();
  });

  it("clears the selection when nothing was selected there or it is gone", () => {
    expect(workspaceToRestore(groups, {}, CLOUD, undefined)).toBeNull();
    expect(workspaceToRestore(groups, { cloud: "deleted" }, CLOUD, undefined)).toBeNull();
    expect(workspaceToRestore(groups, { local: "old" }, THIS_COMPUTER, undefined)).toBeNull();
    // A remembered id that now runs elsewhere is not restored into the wrong list.
    expect(workspaceToRestore(groups, { local: "cloud-a" }, THIS_COMPUTER, undefined)).toBeNull();
  });
});

describe("composerPlace (new workspaces default to the window's place)", () => {
  it("starts in the window's organization when it is ready", () => {
    expect(composerPlace(inOrg("beta"), orgs)).toEqual(inOrg("beta"));
    expect(composerPlace(THIS_COMPUTER, orgs)).toEqual(THIS_COMPUTER);
  });

  it("stays local when the window's organization is not set up here", () => {
    const betaNotReady = {
      ...orgs!,
      items: orgs!.items.map((org) => ({ ...org, ready: org.id === "acme" })),
    };
    expect(composerPlace(inOrg("beta"), betaNotReady)).toEqual(THIS_COMPUTER);
    expect(composerPlace(inOrg("acme"), betaNotReady)).toEqual(inOrg("acme"));
  });

  it("with no list, starts in the cloud only when it is available", () => {
    const none = { available: true, defaultOrganizationId: null, items: [] };
    expect(composerPlace(CLOUD, none)).toEqual(CLOUD);
    expect(composerPlace(CLOUD, { ...none, available: false })).toEqual(THIS_COMPUTER);
    expect(composerPlace(CLOUD, undefined)).toEqual(THIS_COMPUTER);
  });
});

describe("the composer's organization (its own, following the window's)", () => {
  const start = (windowOrganizationId: string | null): ComposerOrganization => ({
    windowOrganizationId,
    choice: null,
  });

  it("is the window's until the composer chooses one, then its own choice", () => {
    expect(composerOrganization(start("acme"), orgs)).toBe("acme");
    expect(composerOrganization({ windowOrganizationId: "acme", choice: "beta" }, orgs)).toBe(
      "beta"
    );
  });

  it("is the window's when the list no longer names the choice, or there is no list", () => {
    expect(composerOrganization({ windowOrganizationId: "acme", choice: "left" }, orgs)).toBe(
      "acme"
    );
    expect(composerOrganization({ windowOrganizationId: null, choice: "beta" }, undefined)).toBe(
      null
    );
  });

  it("drops the choice when the window's organization changes, and only then", () => {
    const chosen: ComposerOrganization = { windowOrganizationId: "acme", choice: "beta" };
    expect(followWindowOrganization(chosen, "acme")).toBe(chosen);
    expect(followWindowOrganization(chosen, "beta")).toEqual(start("beta"));
    // The list arriving names the window's organization for the first time: followed.
    expect(followWindowOrganization(start(null), "acme")).toEqual(start("acme"));
  });
});

describe("organizationRowHint (the words every menu of organizations uses)", () => {
  it("says nothing for a ready one, and what choosing it does otherwise", () => {
    expect(
      (["ready", "set-up", "setting-up", "unavailable"] as const).map(organizationRowHint)
    ).toEqual([null, "Set up", "Setting up…", "Not set up"]);
  });
});

describe("visiblePlace (a cloud this computer cannot reach is not where the window sits)", () => {
  const unreachable = { available: false, defaultOrganizationId: null, items: [] };
  const stored = (organizationId: string | null = null) => ({
    location: "cloud" as const,
    organizationId,
  });

  it("shows this computer when the stored cloud cannot be reached", () => {
    expect(visiblePlace(stored(), unreachable, null)).toEqual(THIS_COMPUTER);
    expect(visiblePlace(stored(), unreachable, ws("local-a", "worktree"))).toEqual(THIS_COMPUTER);
  });

  it("stays in the cloud while a cloud workspace is selected there", () => {
    expect(visiblePlace(stored(), unreachable, ws("cloud-a", "cloud"))).toEqual(CLOUD);
  });

  it("keeps the stored place while the cloud's state is unknown, or it is reachable", () => {
    expect(visiblePlace(stored(), undefined, null)).toEqual(CLOUD);
    expect(visiblePlace(stored("beta"), undefined, null)).toEqual(CLOUD);
    expect(visiblePlace({ location: "local", organizationId: "beta" }, orgs, null)).toEqual(
      THIS_COMPUTER
    );
    expect(visiblePlace(THIS_COMPUTER, orgs, ws("cloud-a", "cloud"))).toEqual(THIS_COMPUTER);
  });

  it("is in the chosen organization", () => {
    expect(visiblePlace(stored("beta"), orgs, null)).toEqual(inOrg("beta"));
    expect(visiblePlace(stored("gone"), orgs, null)).toEqual(inOrg("acme"));
    expect(visiblePlace(stored(), orgs, null)).toEqual(inOrg("acme"));
  });
});

describe("placeRows (the location menu)", () => {
  const rows = (organizations: Organizations, withComputer = true) =>
    placeRows({
      organizations,
      withComputer,
      cloudRow: "ready",
      organizationRow: (org) => (org.ready ? "ready" : "unavailable"),
    });

  it("lists this computer, then each organization in the list's order, with ⌃1…", () => {
    const list = rows(orgs);
    expect(list.map((row) => [row.kind, row.key, row.shortcut])).toEqual([
      ["local", "local", "⌃1"],
      ["organization", "cloud:acme", "⌃2"],
      ["organization", "cloud:beta", "⌃3"],
    ]);
    expect(list[2]).toMatchObject({ name: "Beta", place: inOrg("beta"), state: "ready" });
  });

  it("has the one cloud row with no list", () => {
    expect(rows(undefined).map((row) => [row.kind, row.key, row.shortcut])).toEqual([
      ["local", "local", "⌃1"],
      ["cloud", "cloud", "⌃2"],
    ]);
  });

  it("has no computer row on the hosted web, where the first organization is ⌃1", () => {
    expect(rows(orgs, false).map((row) => [row.key, row.shortcut])).toEqual([
      ["cloud:acme", "⌃1"],
      ["cloud:beta", "⌃2"],
    ]);
  });

  it("gives the first nine rows a shortcut and no more", () => {
    const many = {
      available: true,
      defaultOrganizationId: null,
      items: Array.from({ length: 10 }, (_, i) => ({
        id: `o${i}`,
        name: `O${i}`,
        role: "owner",
        ready: i !== 3,
      })),
    };
    const list = rows(many);
    expect(list.map((row) => row.shortcut).slice(7)).toEqual(["⌃8", "⌃9", null, null]);
    expect(list.filter((row) => !rowSwitches(row)).map((row) => row.key)).toEqual(["cloud:o3"]);
  });
});

describe("organizationRowState (an organization's row)", () => {
  const withKey = { signedIn: true, hasPlatformKey: true };
  const minting = { signedIn: true, hasPlatformKey: false };
  const failed = { ...minting, platformKeyError: "Couldn't create a device key" };
  const row = (ready: boolean, session = withKey, retrying = false, canSetUp = true) =>
    organizationRowState({ ready, session, retrying, canSetUp });

  it("switches when the organization is ready", () => {
    expect(row(true)).toBe("ready");
    expect(row(true, withKey, false, false)).toBe("ready");
  });

  it("reads Not set up, disabled, where only the desktop app can set it up", () => {
    expect(row(false, withKey, false, false)).toBe("unavailable");
  });

  it("offers Set up on the desktop, and waits while a setup runs", () => {
    expect(row(false)).toBe("set-up");
    expect(row(false, failed)).toBe("set-up");
    expect(row(false, withKey, true)).toBe("setting-up");
    // Just signed in: the keys made after sign-in are on the way.
    expect(row(false, minting)).toBe("setting-up");
  });
});

describe("pendingCloudOutcome (a sign-in or setup started from the menu)", () => {
  const signedInNoKey = {
    available: false,
    defaultOrganizationId: "acme",
    items: orgs!.items.map((o) => ({ ...o, ready: false })),
  };
  const betaNotReady = {
    ...orgs!,
    items: orgs!.items.map((o) => (o.id === "beta" ? { ...o, ready: false } : o)),
  };
  const signedOut = { available: false, defaultOrganizationId: null, items: [] };
  const from = { place: "local", selectedId: "local-a" };
  const intent = (organizationId: string | null) => ({ organizationId, from });
  /** The window as it is now, and the menu's rows: a setup running, or not. */
  const now = (
    organizations: Organizations,
    {
      cloudRow = "ready",
      settingUp = false,
      here = from,
    }: {
      cloudRow?: CloudRowState;
      settingUp?: boolean;
      here?: { place: string; selectedId: string | null };
    } = {}
  ) => ({
    organizations,
    cloudRow,
    here,
    organizationRow: (org: { ready: boolean }) =>
      organizationRowState({
        ready: org.ready,
        session: { signedIn: true, hasPlatformKey: true },
        retrying: settingUp,
        canSetUp: true,
      }),
  });

  it("moves to the organization it set up once it is ready", () => {
    expect(pendingCloudOutcome(intent("beta"), now(betaNotReady, { settingUp: true }))).toBe(
      "wait"
    );
    expect(pendingCloudOutcome(intent("beta"), now(orgs))).toEqual(inOrg("beta"));
  });

  it("waits while nothing is known yet, or the keys made after sign-in are on the way", () => {
    expect(pendingCloudOutcome(intent("beta"), now(undefined))).toBe("wait");
    const minting = {
      ...now(signedInNoKey),
      organizationRow: (org: { ready: boolean }) =>
        organizationRowState({
          ready: org.ready,
          session: { signedIn: true, hasPlatformKey: false },
          retrying: false,
          canSetUp: true,
        }),
    };
    expect(pendingCloudOutcome(intent("beta"), minting)).toBe("wait");
  });

  it("ends when its organization is back to Set up: the setup is over and did not make it ready", () => {
    expect(pendingCloudOutcome(intent("beta"), now(betaNotReady))).toBe("end");
  });

  it("ends when its organization is no longer listed: signed out, or no longer a member", () => {
    expect(pendingCloudOutcome(intent("beta"), now(signedOut))).toBe("end");
    const acmeOnly = { ...orgs!, items: orgs!.items.filter((o) => o.id === "acme") };
    expect(pendingCloudOutcome(intent("beta"), now(acmeOnly))).toBe("end");
  });

  it("ends when the person went elsewhere: another place, another workspace, or Home", () => {
    for (const here of [
      { place: "cloud:acme", selectedId: "local-a" },
      { place: "local", selectedId: "local-b" },
      { place: "local", selectedId: null },
    ]) {
      expect(pendingCloudOutcome(intent("beta"), now(orgs, { here }))).toBe("end");
      expect(pendingCloudOutcome(intent(null), now(orgs, { here }))).toBe("end");
    }
  });

  it("moves to the cloud once a sign-in reaches it", () => {
    expect(pendingCloudOutcome(intent(null), now(undefined, { cloudRow: "signing-in" }))).toBe(
      "wait"
    );
    expect(pendingCloudOutcome(intent(null), now(signedInNoKey, { cloudRow: "setting-up" }))).toBe(
      "wait"
    );
    expect(pendingCloudOutcome(intent(null), now(orgs))).toEqual(CLOUD);
  });

  it("ends when the setup failed", () => {
    expect(pendingCloudOutcome(intent(null), now(signedInNoKey, { cloudRow: "retry" }))).toBe(
      "end"
    );
  });
});

describe("cloudRowState (the location menu's cloud row)", () => {
  const signedOut = { signedIn: false, hasPlatformKey: false };
  const keyless = { signedIn: true, hasPlatformKey: false };
  const withKey = { signedIn: true, hasPlatformKey: true };
  const failed = { ...keyless, platformKeyError: "Couldn't create a device key" };
  const desktop = { signingIn: false, canSignIn: true };
  const browser = { session: undefined, signingIn: false, canSignIn: false };

  it("switches when the cloud can be reached, or nothing is known yet", () => {
    expect(cloudRowState({ ...desktop, available: true, session: withKey })).toBe("ready");
    expect(cloudRowState({ ...desktop, available: undefined, session: undefined })).toBe("ready");
    expect(cloudRowState({ ...browser, available: true })).toBe("ready");
    expect(cloudRowState({ ...browser, available: undefined })).toBe("ready");
  });

  it("cannot be chosen signed out where this window cannot sign in", () => {
    expect(cloudRowState({ ...browser, available: false })).toBe("unavailable");
  });

  it("signs in from the desktop app when signed out", () => {
    expect(cloudRowState({ ...desktop, available: false, session: signedOut })).toBe("sign-in");
  });

  it("waits while the sign-in runs, and while this computer's key is made", () => {
    expect(
      cloudRowState({ ...desktop, signingIn: true, available: false, session: signedOut })
    ).toBe("signing-in");
    expect(cloudRowState({ ...desktop, available: false, session: keyless })).toBe("setting-up");
  });

  it("offers Retry when the key failed, the keychain is locked, or the backend lacks the key", () => {
    expect(cloudRowState({ ...desktop, available: false, session: failed })).toBe("retry");
    const locked = { ...keyless, vaultLocked: true };
    expect(cloudRowState({ ...desktop, available: false, session: locked })).toBe("retry");
    expect(cloudRowState({ ...desktop, available: false, session: withKey })).toBe("retry");
  });

  it("waits while a Retry runs", () => {
    expect(cloudRowState({ ...desktop, retrying: true, available: false, session: failed })).toBe(
      "setting-up"
    );
  });

  it("follows a sign-in: signed out, signing in, setting up, ready", () => {
    // The backend's pushed `available`, the desktop's own session, the menu's sign-in.
    type Session = Parameters<typeof cloudRowState>[0]["session"] & object;
    const row = (available: boolean | undefined, session: Session, signingIn: boolean) =>
      cloudRowState({ available, session, signingIn, canSignIn: true });
    expect([
      row(false, signedOut, false),
      row(false, signedOut, true),
      row(false, keyless, true),
      row(false, keyless, false),
      row(true, withKey, false),
    ]).toEqual(["sign-in", "signing-in", "signing-in", "setting-up", "ready"]);
    expect(row(false, failed, false)).toBe("retry");
  });
});
