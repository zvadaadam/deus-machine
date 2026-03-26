import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRun, mockPrepare, mockDb, mockExecFileSync } = vi.hoisted(() => {
  const mockRun = vi.fn(() => ({ changes: 1 }));
  const mockPrepare = vi.fn(() => ({ run: mockRun }));
  const mockDb = { prepare: mockPrepare };
  const mockExecFileSync = vi.fn();
  return { mockRun, mockPrepare, mockDb, mockExecFileSync };
});

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn(() => mockDb),
}));

vi.mock("child_process", () => ({
  execFileSync: mockExecFileSync,
}));

import {
  deriveWorkspaceTitleFromUserMessage,
  isPlaceholderWorkspaceBranch,
  promoteWorkspaceTitleFromPr,
  syncWorkspaceBranchAndTitle,
} from "../../../src/services/workspace-title.service";

describe("workspace-title.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepare.mockReturnValue({ run: mockRun });
    mockExecFileSync.mockReturnValue("feature/fix-title-promotion\n");
  });

  describe("deriveWorkspaceTitleFromUserMessage", () => {
    it("summarizes the first prompt into a short single-line title", () => {
      expect(
        deriveWorkspaceTitleFromUserMessage(
          "Fix the websocket reconnect bug on mobile safari after sleep mode."
        )
      ).toBe("Fix the websocket reconnect bug on mobile safari after sleep mode");
    });

    it("collapses whitespace and trims markdown noise", () => {
      expect(
        deriveWorkspaceTitleFromUserMessage("  -   Update   the   workspace   title   flow  \n\n")
      ).toBe("Update the workspace title flow");
    });

    it("returns null for empty prompts", () => {
      expect(deriveWorkspaceTitleFromUserMessage("   \n\t  ")).toBeNull();
    });
  });

  describe("isPlaceholderWorkspaceBranch", () => {
    it("treats slug-shaped branches as placeholders", () => {
      expect(isPlaceholderWorkspaceBranch("cursor-agent/pollux", "pollux")).toBe(true);
      expect(isPlaceholderWorkspaceBranch("pollux", "pollux")).toBe(true);
    });

    it("treats renamed branches as meaningful", () => {
      expect(isPlaceholderWorkspaceBranch("cursor-agent/fix-workspace-title", "pollux")).toBe(
        false
      );
    });
  });

  describe("syncWorkspaceBranchAndTitle", () => {
    it("promotes first-prompt titles to the renamed branch", () => {
      const changed = syncWorkspaceBranchAndTitle(
        {
          id: "ws-1",
          slug: "pollux",
          git_branch: "cursor-agent/pollux",
          title: "Fix websocket reconnect on mobile safari",
          title_source: "first_prompt",
        },
        "/tmp/workspace"
      );

      expect(changed).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE workspaces"));
      expect(mockRun).toHaveBeenCalledWith(
        "feature/fix-title-promotion",
        "feature/fix-title-promotion",
        "branch",
        "ws-1"
      );
    });

    it("updates branch metadata without overwriting manual titles", () => {
      const changed = syncWorkspaceBranchAndTitle(
        {
          id: "ws-2",
          slug: "pollux",
          git_branch: "cursor-agent/pollux",
          title: "Manually curated title",
          title_source: "manual",
        },
        "/tmp/workspace"
      );

      expect(changed).toBe(true);
      expect(mockRun).toHaveBeenCalledWith(
        "feature/fix-title-promotion",
        "Manually curated title",
        "manual",
        "ws-2"
      );
    });

    it("does not promote placeholder branches", () => {
      mockExecFileSync.mockReturnValue("cursor-agent/pollux\n");

      const changed = syncWorkspaceBranchAndTitle(
        {
          id: "ws-3",
          slug: "pollux",
          git_branch: "cursor-agent/pollux",
          title: "Fix title flow",
          title_source: "first_prompt",
        },
        "/tmp/workspace"
      );

      expect(changed).toBe(false);
      expect(mockPrepare).not.toHaveBeenCalled();
    });

    it("keeps branch-sourced titles in sync with later branch renames", () => {
      const changed = syncWorkspaceBranchAndTitle(
        {
          id: "ws-4",
          slug: "pollux",
          git_branch: "feature/old-name",
          title: "feature/old-name",
          title_source: "branch",
        },
        "/tmp/workspace"
      );

      expect(changed).toBe(true);
      expect(mockRun).toHaveBeenCalledWith(
        "feature/fix-title-promotion",
        "feature/fix-title-promotion",
        "branch",
        "ws-4"
      );
    });
  });

  describe("promoteWorkspaceTitleFromPr", () => {
    it("promotes branch and prompt titles to the PR title", () => {
      const changed = promoteWorkspaceTitleFromPr(
        {
          id: "ws-5",
          title: "feature/fix-title-promotion",
          title_source: "branch",
        },
        "Fix workspace title promotion"
      );

      expect(changed).toBe(true);
      expect(mockRun).toHaveBeenCalledWith("Fix workspace title promotion", "pr", "ws-5");
    });

    it("does not overwrite manual or legacy titles", () => {
      expect(
        promoteWorkspaceTitleFromPr(
          {
            id: "ws-6",
            title: "Manual title",
            title_source: "manual",
          },
          "Fix workspace title promotion"
        )
      ).toBe(false);

      expect(
        promoteWorkspaceTitleFromPr(
          {
            id: "ws-7",
            title: "Existing old title",
            title_source: "legacy",
          },
          "Fix workspace title promotion"
        )
      ).toBe(false);

      expect(mockPrepare).not.toHaveBeenCalled();
    });
  });
});
