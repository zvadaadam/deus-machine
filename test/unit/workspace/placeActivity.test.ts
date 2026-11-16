import { describe, expect, it } from "vitest";
import {
  activityElsewhere,
  locationOf,
  offersNewFromBranch,
  placeActivity,
  workspaceActivity,
  type Organizations,
} from "@/features/sidebar/lib/location";
import type { RepoGroup, Workspace } from "@/shared/types";

const ws = (id: string, fields: Partial<Workspace> = {}) =>
  ({
    id,
    kind: "worktree",
    state: "ready",
    organization_id: null,
    repository_id: "repo",
    session_status: "idle",
    current_session_id: `s-${id}`,
    ...fields,
  }) as Workspace;

const orgs: Organizations = {
  available: true,
  defaultOrganizationId: "acme",
  items: [
    { id: "acme", name: "Acme", role: "owner", ready: true },
    { id: "beta", name: "Beta", role: "member", ready: true },
  ],
};

describe("workspaceActivity (the sidebar row's own signals)", () => {
  it.each([
    ["idle", ws("a"), undefined, {}, null],
    ["working", ws("a", { session_status: "working" }), undefined, {}, "working"],
    ["needs an answer", ws("a", { session_status: "needs_response" }), undefined, {}, "unread"],
    ["an unseen reply in its current chat", ws("a"), undefined, { "s-a": true }, "unread"],
    ["an unseen reply in another tab", ws("a"), ["s-a", "t2"], { t2: true }, "unread"],
    [
      "working with an earlier unseen reply: working, as its row shows",
      ws("a", { session_status: "working" }),
      undefined,
      { "s-a": true },
      "working",
    ],
    ["a failed workspace is not activity", ws("a", { state: "error" }), undefined, {}, null],
  ] as const)("%s", (_name, workspace, tabs, unread, expected) => {
    expect(workspaceActivity(workspace, tabs as string[] | undefined, unread)).toBe(expected);
  });
});

describe("placeActivity and activityElsewhere (the header menu's dots)", () => {
  const groups: RepoGroup[] = [
    {
      repo_id: "repo",
      repo_name: "deus",
      sort_order: 0,
      workspaces: [
        ws("local-idle"),
        ws("acme-working", { kind: "cloud", organization_id: "acme", session_status: "working" }),
        ws("acme-unread", { kind: "cloud", organization_id: "acme" }),
        ws("beta-working", { kind: "cloud", organization_id: "beta", session_status: "working" }),
        ws("beta-archived", {
          kind: "cloud",
          organization_id: "beta",
          state: "archived",
          session_status: "needs_response",
        }),
      ],
    },
  ];
  const activityOf = (w: Workspace) => workspaceActivity(w, undefined, { "s-acme-unread": true });

  it("marks each place by its strongest activity, archived workspaces aside", () => {
    expect(placeActivity(groups, orgs, activityOf)).toEqual({
      "cloud:acme": "unread",
      "cloud:beta": "working",
    });
  });

  it("puts a dot on the trigger only for places other than the window's", () => {
    const activity = placeActivity(groups, orgs, activityOf);
    expect(activityElsewhere(activity, "local")).toBe("unread");
    expect(activityElsewhere(activity, "cloud:acme")).toBe("working");
    expect(activityElsewhere({ "cloud:acme": "unread" }, "cloud:acme")).toBeNull();
    expect(activityElsewhere({}, "local")).toBeNull();
  });

  it("finds a reply finishing on this computer while the window is in the cloud", () => {
    const local: RepoGroup[] = [
      { repo_id: "r", repo_name: "r", sort_order: 0, workspaces: [ws("here")] },
    ];
    const activity = placeActivity(local, orgs, (w) =>
      workspaceActivity(w, undefined, { "s-here": true })
    );
    expect(activity).toEqual({ local: "unread" });
    expect(activityElsewhere(activity, "cloud:acme")).toBe("unread");
  });
});

describe("offersNewFromBranch (a workspace from a pull request or branch is local)", () => {
  const github = { git_origin_url: "git@github.com:acme/app.git", has_folder: true };
  it.each([
    ["this computer, a GitHub project with a folder", "local", github, true],
    ["the cloud, the same project", "cloud", github, false],
    ["this computer, no folder here", "local", { ...github, has_folder: false }, false],
    [
      "this computer, not on GitHub",
      "local",
      { git_origin_url: "https://gitlab.com/a/b.git", has_folder: true },
      false,
    ],
    ["this computer, no remote", "local", { git_origin_url: null, has_folder: true }, false],
  ] as const)("%s", (_name, location, project, expected) => {
    expect(offersNewFromBranch(location, project)).toBe(expected);
  });
});

describe("locationOf (kind in the location's words)", () => {
  it("is cloud only for a cloud workspace", () => {
    expect(locationOf({ kind: "cloud" })).toBe("cloud");
    expect(locationOf({ kind: "worktree" })).toBe("local");
    expect(locationOf({})).toBe("local");
  });
});
