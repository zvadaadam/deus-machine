import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/shared/types";

// Render the hook the way React would, render after render: state and refs
// persist between calls, and a set during render is seen by the next call.
const { slots, cursor } = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: { i: 0 },
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = cursor.i++;
    if (!(i in slots)) slots[i] = initial;
    return [slots[i], (next: unknown) => (slots[i] = next)];
  },
  useRef: (initial: unknown) => {
    const i = cursor.i++;
    if (!(i in slots)) slots[i] = { current: initial };
    return slots[i];
  },
  useCallback: (fn: unknown) => fn,
}));
vi.mock("@/features/workspace/api/workspace.queries", () => ({
  useArchiveWorkspace: () => ({ mutate: vi.fn() }),
  useProjectEnvironment: () => ({ data: undefined }),
}));
vi.mock("@/platform/ws", () => ({ call: vi.fn() }));

import { useWorkspaceActions } from "@/app/layouts/hooks/useWorkspaceActions";
import { prTargetBranch } from "@/features/workspace/lib/prState";

const render = (workspace: Partial<Workspace> | null) => {
  cursor.i = 0;
  const once = () =>
    useWorkspaceActions({
      selectedWorkspace: workspace as Workspace | null,
    });
  once();
  cursor.i = 0;
  // A set during render makes React render again.
  return once().selectedTargetBranch;
};

beforeEach(() => {
  slots.length = 0;
});

describe("a workspace's pull-request target", () => {
  it("is the branch the workspace started from, before the project's default", () => {
    expect(prTargetBranch({ git_target_branch: "master", git_default_branch: "main" })).toBe(
      "master"
    );
    expect(prTargetBranch({ git_target_branch: null, git_default_branch: "trunk" })).toBe("trunk");
    expect(prTargetBranch(null)).toBe("main");
  });

  it("follows the workspace's row when it arrives after the selection", () => {
    // Selected at creation, before the workspaces list has its row.
    expect(render(null)).toBe("main");
    expect(render({ id: "ws-1", git_target_branch: "master", git_default_branch: "main" })).toBe(
      "master"
    );
  });

  it("follows a project default corrected after the workspace was selected", () => {
    expect(render({ id: "ws-1", git_target_branch: null, git_default_branch: "main" })).toBe(
      "main"
    );
    expect(render({ id: "ws-1", git_target_branch: null, git_default_branch: "master" })).toBe(
      "master"
    );
  });
});
