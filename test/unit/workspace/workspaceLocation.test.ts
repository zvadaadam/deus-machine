import { describe, expect, it } from "vitest";
import {
  composerLocation,
  filterByLocation,
  followSelection,
  workspaceToRestore,
  type FollowState,
} from "@/features/sidebar/lib/location";
import { createOptimisticWorkspace } from "@/features/workspace/lib/workspace.utils";
import type { RepoGroup, Workspace } from "@/shared/types";

const ws = (id: string, kind: Workspace["kind"], state: Workspace["state"] = "ready") =>
  ({ id, kind, state, repository_id: "repo" }) as Workspace;

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
  { repo_id: "empty", repo_name: "docs", sort_order: 2, workspaces: [] },
];

const ids = (list: RepoGroup[]) => list.map((g) => [g.repo_id, g.workspaces.map((w) => w.id)]);

describe("filterByLocation", () => {
  it("lists only the location's workspaces and keeps every repository", () => {
    expect(ids(filterByLocation(groups, "local"))).toEqual([
      ["repo", ["local-a", "old"]],
      ["cloud-only", []],
      ["empty", []],
    ]);
    expect(ids(filterByLocation(groups, "cloud"))).toEqual([
      ["repo", ["cloud-a"]],
      ["cloud-only", ["cloud-b"]],
      ["empty", []],
    ]);
  });

  it("keeps a group's identity when nothing in it was filtered", () => {
    const local = filterByLocation(groups, "local");
    expect(local[2]).toBe(groups[2]);
    expect(local[0]).not.toBe(groups[0]);
    expect(groups[0].workspaces).toHaveLength(3);
  });
});

describe("followSelection", () => {
  const local: FollowState = { followedId: null, location: "local" };

  it("moves the window to a newly selected workspace's location", () => {
    expect(followSelection(local, "cloud-a", ws("cloud-a", "cloud"))).toEqual({
      followedId: "cloud-a",
      location: "cloud",
    });
    expect(
      followSelection(
        { followedId: "cloud-a", location: "cloud" },
        "local-a",
        ws("local-a", "worktree")
      )
    ).toEqual({ followedId: "local-a", location: "local" });
  });

  it("never undoes a manual switch when the same selection is seen again", () => {
    // Followed cloud-a, then the user switched to local by hand; a data refresh re-renders.
    const switched: FollowState = { followedId: "cloud-a", location: "local" };
    expect(followSelection(switched, "cloud-a", ws("cloud-a", "cloud"))).toBe(switched);
  });

  it("waits for a selection whose row has not loaded", () => {
    expect(followSelection(local, "cloud-a", null)).toBe(local);
  });

  it("forgets the followed selection when it is cleared, so selecting it again follows", () => {
    const cleared = followSelection({ followedId: "cloud-a", location: "local" }, null, null);
    expect(cleared).toEqual({ followedId: null, location: "local" });
    expect(followSelection(cleared, "cloud-a", ws("cloud-a", "cloud")).location).toBe("cloud");
  });
});

describe("workspaceToRestore (manual switch)", () => {
  it("returns the workspace last selected in the target location", () => {
    expect(workspaceToRestore(groups, { local: "local-a", cloud: "cloud-b" }, "cloud")).toBe(
      "cloud-b"
    );
    expect(workspaceToRestore(groups, { local: "local-a", cloud: "cloud-b" }, "local")).toBe(
      "local-a"
    );
  });

  it("clears the selection when nothing was selected there or it is gone", () => {
    expect(workspaceToRestore(groups, {}, "cloud")).toBeNull();
    expect(workspaceToRestore(groups, { cloud: "deleted" }, "cloud")).toBeNull();
    expect(workspaceToRestore(groups, { local: "old" }, "local")).toBeNull();
    // A remembered id that now runs elsewhere is not restored into the wrong list.
    expect(workspaceToRestore(groups, { local: "cloud-a" }, "local")).toBeNull();
  });
});

describe("composerLocation (new workspaces default to the window's location)", () => {
  it("starts in the cloud only when the window is there and Deus Cloud is signed in", () => {
    expect(composerLocation("cloud", true)).toBe("cloud");
    expect(composerLocation("local", true)).toBe("local");
  });

  it("stays local when Deus Cloud is not signed in (or not known yet)", () => {
    expect(composerLocation("cloud", false)).toBe("local");
    expect(composerLocation("local", false)).toBe("local");
  });
});

describe("createOptimisticWorkspace", () => {
  it("gives the placeholder the requested location's kind", () => {
    expect(createOptimisticWorkspace("repo", "deus").kind).toBe("worktree");
    expect(createOptimisticWorkspace("repo", "deus", "local").kind).toBe("worktree");
    expect(createOptimisticWorkspace("repo", "deus", "cloud").kind).toBe("cloud");
    expect(
      filterByLocation(
        [
          {
            repo_id: "repo",
            repo_name: "deus",
            sort_order: 0,
            workspaces: [createOptimisticWorkspace("repo", "deus", "cloud")],
          },
        ],
        "local"
      )[0].workspaces
    ).toEqual([]);
  });
});
