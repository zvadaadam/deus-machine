import { describe, expect, it } from "vitest";
import { classifyCloneConflict, isMatchingGitHubRepo } from "@/features/onboarding/lib/deus-import";

describe("classifyCloneConflict", () => {
  it("treats existing git targets as already cloned", () => {
    expect(classifyCloneConflict("Target already contains a git repository")).toBe(
      "already_cloned"
    );
    expect(classifyCloneConflict("fatal: destination path 'deus' already exists")).toBe(
      "already_cloned"
    );
    expect(classifyCloneConflict("Repository already exists")).toBe("already_cloned");
  });

  it("distinguishes existing non-git folders from real clone conflicts", () => {
    expect(
      classifyCloneConflict("Target directory already exists and is not a git repository")
    ).toBe("non_git_target");
    expect(classifyCloneConflict("Path is not a git repository")).toBe("non_git_target");
  });

  it("avoids broad destination path false positives", () => {
    expect(classifyCloneConflict("fatal: could not create destination path metadata")).toBe(
      "other"
    );
  });

  it("returns other for unrelated failures", () => {
    expect(classifyCloneConflict("network timeout")).toBe("other");
  });
});

describe("isMatchingGitHubRepo", () => {
  it("matches equivalent GitHub HTTPS and SSH origins", () => {
    expect(
      isMatchingGitHubRepo(
        "https://github.com/zvadaadam/deus.git",
        "https://github.com/zvadaadam/deus"
      )
    ).toBe(true);
    expect(
      isMatchingGitHubRepo("git@github.com:zvadaadam/deus.git", "https://github.com/zvadaadam/deus")
    ).toBe(true);
  });

  it("rejects different repositories", () => {
    expect(
      isMatchingGitHubRepo("https://github.com/other/deus.git", "https://github.com/zvadaadam/deus")
    ).toBe(false);
    expect(isMatchingGitHubRepo(null, "https://github.com/zvadaadam/deus")).toBe(false);
  });
});
