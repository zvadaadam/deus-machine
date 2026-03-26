import { describe, expect, it } from "vitest";
import {
  applySessionStatusToRepoGroups,
  applyWorkspaceProgressToRepoGroups,
  isTerminalWorkspaceProgressStep,
} from "@/features/workspace/lib/dashboardRealtime";
import type { RepoGroup } from "@shared/types/workspace";

function createRepoGroups(): RepoGroup[] {
  return [
    {
      repo_id: "repo-1",
      repo_name: "Repo One",
      sort_order: 1,
      workspaces: [
        {
          id: "ws-1",
          repository_id: "repo-1",
          slug: "alpha",
          title: null,
          git_branch: "feature/alpha",
          git_target_branch: "main",
          state: "initializing",
          current_session_id: "session-1",
          session_status: "working",
          model: null,
          latest_message_sent_at: null,
          updated_at: "2026-03-10T00:00:00.000Z",
          repo_name: "Repo One",
          root_path: "/repo-1",
          workspace_path: "/repo-1/.deus/alpha",
          git_default_branch: "main",
          setup_status: "none",
          init_stage: "worktree",
          error_message: null,
          pr_url: null,
          pr_number: null,
        },
        {
          id: "ws-2",
          repository_id: "repo-1",
          slug: "beta",
          title: null,
          git_branch: "feature/beta",
          git_target_branch: "main",
          state: "ready",
          current_session_id: "session-2",
          session_status: "idle",
          model: null,
          latest_message_sent_at: null,
          updated_at: "2026-03-10T00:00:00.000Z",
          repo_name: "Repo One",
          root_path: "/repo-1",
          workspace_path: "/repo-1/.deus/beta",
          git_default_branch: "main",
          setup_status: "none",
          init_stage: null,
          error_message: null,
          pr_url: null,
          pr_number: null,
        },
      ],
    },
  ];
}

describe("dashboardRealtime", () => {
  describe("isTerminalWorkspaceProgressStep", () => {
    it("treats done and error-prefixed steps as terminal", () => {
      expect(isTerminalWorkspaceProgressStep("done")).toBe(true);
      expect(isTerminalWorkspaceProgressStep("error")).toBe(true);
      expect(isTerminalWorkspaceProgressStep("error:hooks")).toBe(true);
      expect(isTerminalWorkspaceProgressStep("dependencies")).toBe(false);
    });
  });

  describe("applyWorkspaceProgressToRepoGroups", () => {
    it("patches init_stage for the matching workspace only", () => {
      const repoGroups = createRepoGroups();

      const next = applyWorkspaceProgressToRepoGroups(repoGroups, {
        workspaceId: "ws-1",
        step: "dependencies",
      });

      expect(next).not.toBe(repoGroups);
      expect(next?.[0].workspaces[0].init_stage).toBe("dependencies");
      expect(next?.[0].workspaces[1].init_stage).toBeNull();
    });

    it("returns the same reference when nothing changes", () => {
      const repoGroups = createRepoGroups();

      const next = applyWorkspaceProgressToRepoGroups(repoGroups, {
        workspaceId: "missing",
        step: "dependencies",
      });

      expect(next).toBe(repoGroups);
    });
  });

  describe("applySessionStatusToRepoGroups", () => {
    it("updates by workspaceId when provided", () => {
      const repoGroups = createRepoGroups();

      const next = applySessionStatusToRepoGroups(repoGroups, {
        id: "unknown-session",
        workspaceId: "ws-2",
        status: "working",
      });

      expect(next?.[0].workspaces[1].session_status).toBe("working");
      expect(next?.[0].workspaces[0].session_status).toBe("working");
    });

    it("falls back to current_session_id when workspaceId is absent", () => {
      const repoGroups = createRepoGroups();

      const next = applySessionStatusToRepoGroups(repoGroups, {
        id: "session-2",
        status: "needs_response",
      });

      expect(next?.[0].workspaces[1].session_status).toBe("needs_response");
      expect(next?.[0].workspaces[0].session_status).toBe("working");
    });

    it("returns the same reference when the status is already current", () => {
      const repoGroups = createRepoGroups();

      const next = applySessionStatusToRepoGroups(repoGroups, {
        id: "session-2",
        status: "idle",
      });

      expect(next).toBe(repoGroups);
    });
  });
});
