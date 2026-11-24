import { describe, expect, it } from "vitest";
import {
  activityElsewhere,
  locationOf,
  offersNewFromBranch,
  placeActivity,
  type Organizations,
} from "@/features/sidebar/lib/location";
import { getWorkspaceActivity, sortByStatusPriority } from "@/features/sidebar/lib/status";
import { splitByRecency } from "@/features/sidebar/lib/utils";
import type { RepoGroup, Workspace } from "@/shared/types";

const chat = (
  id: string,
  status: NonNullable<Workspace["session_status"]> = "idle",
  last_user_message_at: string | null = null
) => ({ id, status, error_category: null, last_user_message_at });

const ws = (id: string, fields: Partial<Workspace> = {}) =>
  ({
    id,
    kind: "worktree",
    state: "ready",
    organization_id: null,
    repository_id: "repo",
    session_status: "idle",
    current_session_id: `s-${id}`,
    chats: [chat(`s-${id}`, fields.session_status ?? "idle")],
    updated_at: "2026-01-01T00:00:00Z",
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

describe("the workspace's activity", () => {
  it.each([
    ["a current chat working", [chat("s-a", "working")], {}, "working", true],
    ["a sibling working", [chat("s-a"), chat("b", "working")], {}, "working", true],
    ["a finished sibling", [chat("s-a"), chat("b")], { b: true }, "unread", false],
    ["an unseen reply beside work", [chat("b"), chat("c", "working")], { b: true }, "unread", true],
    [
      "a question beside work",
      [chat("b", "needs_response"), chat("c", "working")],
      {},
      "unread",
      true,
    ],
    [
      "a plan beside an error",
      [chat("s-a", "error"), chat("b", "needs_plan_response")],
      {},
      "unread",
      false,
    ],
    ["a seen sibling error", [chat("b", "error")], {}, "idle", false],
    ["an unseen sibling error", [chat("b", "error")], { b: true }, "error", false],
    ["a current error", [chat("s-a", "error")], {}, "error", false],
  ] as const)("%s", (_label, chats, unread, status, working) => {
    expect(getWorkspaceActivity(ws("a", { chats: [...chats] }), unread)).toMatchObject({
      status,
      working,
    });
  });

  it("keeps failed starts ahead of chat attention and counts a starting workspace as working", () => {
    expect(
      getWorkspaceActivity(ws("a", { state: "error", chats: [chat("s-a", "needs_response")] }), {})
    ).toMatchObject({ status: "error", working: false });
    expect(getWorkspaceActivity(ws("a", { state: "initializing", chats: [] }), {})).toMatchObject({
      status: "working",
      working: true,
    });
  });

  it("sorts by a sibling's unread reply and keeps that workspace out of Show more", () => {
    const workspaces = ["a", "b", "c", "d", "e", "f"].map((id) => ws(id));
    const last = workspaces.at(-1)!;
    last.chats = [chat("s-f"), chat("sibling")];
    const unread = { sibling: true };
    expect(sortByStatusPriority(workspaces, unread)[0]).toBe(last);
    expect(splitByRecency(workspaces, null, unread)[0]).toContain(last);
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
  const unread = { "s-acme-unread": true };

  it("marks each place by its strongest activity, archived workspaces aside", () => {
    expect(placeActivity(groups, orgs, unread)).toEqual({
      "cloud:acme": "unread",
      "cloud:beta": "working",
    });
  });

  it("puts a dot on the trigger only for places other than the window's", () => {
    const activity = placeActivity(groups, orgs, unread);
    expect(activityElsewhere(activity, "local")).toBe("unread");
    expect(activityElsewhere(activity, "cloud:acme")).toBe("working");
    expect(activityElsewhere({ "cloud:acme": "unread" }, "cloud:acme")).toBeNull();
    expect(activityElsewhere({}, "local")).toBeNull();
  });

  it("finds a reply finishing on this computer while the window is in the cloud", () => {
    const local: RepoGroup[] = [
      { repo_id: "r", repo_name: "r", sort_order: 0, workspaces: [ws("here")] },
    ];
    const activity = placeActivity(local, orgs, { "s-here": true });
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
