import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

  it("prefers the newest cwd from the tail of reused Claude session logs", () => {
    const tempRoot = createTempRoot();
    const homeDir = path.join(tempRoot, "home");
    const projectsDir = path.join(homeDir, ".claude", "projects");
    const oldProject = path.join(homeDir, "Developer", "old-project");
    const newProject = path.join(homeDir, "Developer", "new-project");
    const sessionDir = path.join(projectsDir, "project-1", "session-1", "subagents");

    mkdirSync(oldProject, { recursive: true });
    mkdirSync(newProject, { recursive: true });
    execFileSync("git", ["init"], { cwd: oldProject });
    execFileSync("git", ["init"], { cwd: newProject });
    mkdirSync(sessionDir, { recursive: true });

    const noise = new Array(2000).fill(JSON.stringify({ type: "noise" })).join("\n");
    writeFileSync(
      path.join(sessionDir, "agent-1.jsonl"),
      [
        JSON.stringify({ cwd: oldProject, type: "user" }),
        noise,
        JSON.stringify({ cwd: newProject, type: "assistant" }),
      ].join("\n") + "\n"
    );

    const canonicalNewProject = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: newProject,
      encoding: "utf8",
    }).trim();

    expect(readClaudeProjects(projectsDir, { homeDir })).toEqual([
      { path: canonicalNewProject, name: "new-project", source: "claude" },
    ]);
  });

  it("orders Claude projects by newest session activity, not project directory mtime", () => {
    const tempRoot = createTempRoot();
    const homeDir = path.join(tempRoot, "home");
    const projectsDir = path.join(homeDir, ".claude", "projects");
    const projectA = path.join(homeDir, "Developer", "project-a");
    const projectB = path.join(homeDir, "Developer", "project-b");
    const claudeProjectA = path.join(projectsDir, "project-a");
    const claudeProjectB = path.join(projectsDir, "project-b");
    const fileA = path.join(claudeProjectA, "session-1", "agent.jsonl");
    const fileB = path.join(claudeProjectB, "session-1", "agent.jsonl");

    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    execFileSync("git", ["init"], { cwd: projectA });
    execFileSync("git", ["init"], { cwd: projectB });
    mkdirSync(path.dirname(fileA), { recursive: true });
    mkdirSync(path.dirname(fileB), { recursive: true });
    writeFileSync(fileA, `${JSON.stringify({ cwd: projectA })}\n`);
    writeFileSync(fileB, `${JSON.stringify({ cwd: projectB })}\n`);

    const now = Date.now() / 1000;
    utimesSync(fileA, now, now);
    utimesSync(fileB, now - 120, now - 120);
    utimesSync(claudeProjectA, now - 300, now - 300);
    utimesSync(claudeProjectB, now, now);

    const canonicalProjectA = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectA,
      encoding: "utf8",
    }).trim();
    const canonicalProjectB = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectB,
      encoding: "utf8",
    }).trim();

    expect(readClaudeProjects(projectsDir, { homeDir })).toEqual([
      { path: canonicalProjectA, name: "project-a", source: "claude" },
      { path: canonicalProjectB, name: "project-b", source: "claude" },
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
    expect(isIgnoredRecentProjectPath("C:/Users/deus", { homeDir: "C:/Users/deus" })).toBe(true);
    expect(
      isIgnoredRecentProjectPath("C:/Users/deus/Developer/project", {
        homeDir: "C:/Users/deus",
      })
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
