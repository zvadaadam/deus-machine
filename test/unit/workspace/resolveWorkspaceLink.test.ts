import { expect, it } from "vitest";
import {
  findOpenWorkspace,
  resolveWorkspaceLink,
  NO_OPEN_WORKSPACE,
} from "@/features/workspace/lib/resolveWorkspaceLink";
import type { RepoGroup, Workspace } from "@shared/types/workspace";

const workspace = { id: "open" } as Workspace;
const groups: RepoGroup[] = [
  { repo_id: "a", repo_name: "One", sort_order: 0, workspaces: [] },
  { repo_id: "b", repo_name: "Two", sort_order: 1, workspaces: [workspace] },
];
const chats = [{ id: "first" }, { id: "second" }];

it("opens the workspace, or the particular open chat the link named", () => {
  expect(findOpenWorkspace(groups, "open")).toBe(workspace);
  expect(resolveWorkspaceLink({ workspaceId: "open" }, groups, [])).toEqual({ workspace });
  expect(resolveWorkspaceLink({ workspaceId: "open", sessionId: "second" }, groups, chats)).toEqual(
    {
      workspace,
      sessionId: "second",
    }
  );
});

it("opens nothing for a workspace missing from the open list", () => {
  expect(findOpenWorkspace(groups, "absent")).toBeUndefined();
  expect(
    resolveWorkspaceLink({ workspaceId: "absent", sessionId: "second" }, groups, chats)
  ).toEqual({
    message: NO_OPEN_WORKSPACE,
  });
});

it("opens the workspace and explains a missing chat", () => {
  expect(resolveWorkspaceLink({ workspaceId: "open", sessionId: "absent" }, groups, chats)).toEqual(
    {
      workspace,
      message: "That chat is no longer open in this workspace.",
    }
  );
});
