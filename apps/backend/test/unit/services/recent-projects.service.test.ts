import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    prepare() {
      return { get: () => undefined };
    }

    close() {}
  },
}));

import {
  interleaveRecentProjects,
  isIgnoredRecentProjectPath,
  readClaudeProjects,
} from "../../../src/services/recent-projects.service";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "deus-recent-projects-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("recent-projects.service", () => {
  it("reads Claude project roots from JSONL session data", () => {
    const tempRoot = createTempRoot();
    const homeDir = path.join(tempRoot, "home");
    const projectsDir = path.join(homeDir, ".claude", "projects");
    const actualProject = path.join(homeDir, "Developer", "rabat-v3");
    const nestedWorkspace = path.join(actualProject, "src-tauri");
    const claudeProjectDir = path.join(
      projectsDir,
      "-Users-zvada-conductor-workspaces-deus-machine-rabat-v3"
    );
    const sessionDir = path.join(claudeProjectDir, "session-1", "subagents");

    mkdirSync(nestedWorkspace, { recursive: true });
    execFileSync("git", ["init"], { cwd: actualProject });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, "agent-1.jsonl"),
      `${JSON.stringify({ cwd: nestedWorkspace, type: "user" })}\n`
    );

    const canonicalProjectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: actualProject,
      encoding: "utf8",
    }).trim();

    expect(readClaudeProjects(projectsDir, { homeDir })).toEqual([
      { path: canonicalProjectRoot, name: "rabat-v3", source: "claude" },
    ]);
  });

  it("filters obvious non-project paths from onboarding discovery", () => {
    expect(isIgnoredRecentProjectPath("/", { homeDir: "/Users/deus" })).toBe(true);
    expect(isIgnoredRecentProjectPath("/Users/deus", { homeDir: "/Users/deus" })).toBe(true);
    expect(
      isIgnoredRecentProjectPath("/Applications/Conductor.app", { homeDir: "/Users/deus" })
    ).toBe(true);
    expect(
      isIgnoredRecentProjectPath("/Users/deus/Developer/project/.opendevs/alpha", {
        homeDir: "/Users/deus",
      })
    ).toBe(true);
    expect(
      isIgnoredRecentProjectPath("/Users/deus/Developer/project", { homeDir: "/Users/deus" })
    ).toBe(false);
  });

  it("interleaves sources so one app cannot crowd out the others", () => {
    const merged = interleaveRecentProjects(
      [
        [
          { path: "/cursor-1", name: "cursor-1", source: "cursor" },
          { path: "/cursor-2", name: "cursor-2", source: "cursor" },
          { path: "/cursor-3", name: "cursor-3", source: "cursor" },
        ],
        [{ path: "/vscode-1", name: "vscode-1", source: "vscode" }],
        [
          { path: "/claude-1", name: "claude-1", source: "claude" },
          { path: "/claude-2", name: "claude-2", source: "claude" },
        ],
      ],
      5
    );

    expect(merged).toEqual([
      { path: "/cursor-1", name: "cursor-1", source: "cursor" },
      { path: "/vscode-1", name: "vscode-1", source: "vscode" },
      { path: "/claude-1", name: "claude-1", source: "claude" },
      { path: "/cursor-2", name: "cursor-2", source: "cursor" },
      { path: "/claude-2", name: "claude-2", source: "claude" },
    ]);
  });
});
