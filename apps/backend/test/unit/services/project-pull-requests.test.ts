import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import { ProjectContent } from "../../../src/services/projects/content";
import { ProjectStore } from "../../../src/services/projects/store";
import {
  captureReportPullRequests,
  captureWorkspacePullRequest,
  parseProjectPullRequest,
  queryProjectPullRequests,
} from "../../../src/services/projects/pull-requests";

const mocks = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  invalidate: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => mocks.db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mocks.invalidate }));
vi.mock("../../../src/services/gh.service", () => ({
  getPrStatus: vi.fn(),
  getPrStatusForRemoteBranch: vi.fn(),
}));
import { applyPrStatusSideEffects } from "../../../src/services/pr-snapshot.service";

let db: Database.Database, store: ProjectStore, directory: string, projectId: string;
let reportSequence = 0;
let turnId: string;
const agentId = "agent",
  sessionId = "session";
const canonical = "https://github.com/example/repository/pull/42";
function captureReport(urls: string[]) {
  const assignmentId = store.assignment(agentId).id;
  const reportId = store.report(
    agentId,
    { sessionId, turnId },
    `report-${++reportSequence}`,
    "Result",
    [],
    urls
  );
  const input = { projectId, reportId, assignmentId, agentId, sessionId, turnId, urls };
  captureReportPullRequests(db, input);
  return input;
}

beforeEach(() => {
  fs.mkdirSync(".context", { recursive: true });
  directory = fs.mkdtempSync(path.resolve(".context/project-pr-test-"));
  db = new Database(":memory:");
  mocks.db = db;
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO repositories (id,name,root_path) VALUES ('repo','Repository','/fixture')"
  ).run();
  store = new ProjectStore(db, new ProjectContent(directory));
  projectId = store.create(
    {
      requestId: "create",
      title: "Project",
      repositoryId: "repo",
      brief: "Deliver the change",
      model: "model",
    },
    {
      workspaceId: agentId,
      sessionId,
      repositoryId: "repo",
      title: "Coordinator",
      task: "Deliver the change",
      baseCommit: "a".repeat(40),
      sourceBranch: "main",
      coordinator: true,
    }
  );
  db.prepare("INSERT INTO sessions (id,workspace_id) VALUES (?,?)").run(sessionId, agentId);
  db.prepare("UPDATE workspaces SET current_session_id=?,state='ready' WHERE id=?").run(
    sessionId,
    agentId
  );
  turnId = store.reserveDispatch(agentId)!.id;
  mocks.invalidate.mockClear();
});
afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Project PR association and provenance", () => {
  it("canonicalizes GitHub locators without accepting arbitrary links as PRs", () => {
    expect(
      parseProjectPullRequest(
        "http://www.github.com/Example/Repository/pull/42/files?diff=split#discussion"
      )
    ).toEqual({ host: "github.com", repository: "example/repository", number: 42, url: canonical });
    for (const url of [
      "https://github.com/example/repository/issues/42",
      "https://github.com/",
      "https://example.com/repo/pull/42",
      "https://github.com.evil.test/example/repository/pull/42",
      "https://github.com/example/repository/pull/0",
      "https://github.com/example/repository/pull/9007199254740993",
      "https://user@github.com/example/repository/pull/42",
    ]) {
      expect(parseProjectPullRequest(url)).toBeNull();
    }
  });

  it("deduplicates reported PRs while retaining exact immutable report locators and source turns", () => {
    const urls = [
      canonical,
      "https://github.com/Example/Repository/pull/42#discussion",
      "https://example.com/result",
    ];
    const input = captureReport(urls);
    const firstIds = captureReportPullRequests(db, input);
    expect(captureReportPullRequests(db, input)).toEqual(firstIds);
    const links = queryProjectPullRequests(db, projectId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      url: canonical,
      number: 42,
      state: null,
      checkedAt: null,
      agentIds: [agentId],
    });
    expect(links[0].sources).toHaveLength(2);
    expect(links[0].sources.map((source) => source.originalUrl).sort()).toEqual(
      urls.slice(0, 2).sort()
    );
    expect(links[0].sources[0]).toMatchObject({
      kind: "report",
      reportId: input.reportId,
      assignmentId: input.assignmentId,
      sessionId,
      turnId,
    });
    expect(
      db.prepare("SELECT pr_urls_json FROM project_reports WHERE id=?").get(input.reportId)
    ).toEqual({ pr_urls_json: JSON.stringify(urls) });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("does not merge the same PR number across repositories or Project owners", () => {
    captureReport([canonical, "https://github.com/example/another/pull/42"]);
    const otherId = store.create(
      {
        requestId: "other-create",
        title: "Other",
        repositoryId: "repo",
        brief: "Another change",
        model: "model",
      },
      {
        workspaceId: "other-agent",
        sessionId: "other-session",
        repositoryId: "repo",
        title: "Other coordinator",
        task: "Another change",
        baseCommit: "a".repeat(40),
        sourceBranch: "main",
        coordinator: true,
      }
    );
    captureWorkspacePullRequest(
      db,
      "other-agent",
      { has_pr: true, pr_url: canonical, pr_state: "open", error: null },
      100
    );
    expect(queryProjectPullRequests(db, projectId)).toHaveLength(2);
    expect(queryProjectPullRequests(db, otherId)).toHaveLength(1);
    expect(
      new Set(
        db
          .prepare("SELECT id FROM project_pull_requests")
          .all()
          .map((row) => (row as { id: string }).id)
      ).size
    ).toBe(3);
  });

  it("refuses fabricated provenance and rolls back links together with their report", () => {
    const input = captureReport([canonical]);
    expect(() => captureReportPullRequests(db, { ...input, turnId: "another-turn" })).toThrow(
      "persisted report source"
    );
    expect(() =>
      db.transaction(() => {
        captureReport(["https://github.com/example/repository/pull/77"]);
        throw new Error("Rollback");
      })()
    ).toThrow("Rollback");
    expect(queryProjectPullRequests(db, projectId)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) n FROM project_reports").get()).toEqual({ n: 1 });
  });
});

describe("existing workspace GitHub snapshot integration", () => {
  it("updates a reported association and records a workspace observation without inventing a creator turn", () => {
    captureReport([canonical]);
    applyPrStatusSideEffects(
      agentId,
      {
        has_pr: true,
        pr_url: canonical,
        pr_number: 42,
        pr_title: "Requested change",
        pr_state: "open",
        is_draft: true,
        review_status: "review_required",
        ci_status: "pending",
        has_conflicts: false,
        error: null,
      },
      100
    );
    const links = queryProjectPullRequests(db, projectId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      state: "open",
      isDraft: true,
      reviewStatus: "review_required",
      ciStatus: "pending",
      hasConflicts: false,
      checkedAt: 100,
    });
    expect(links[0].sources.find((source) => source.kind === "workspace")).toMatchObject({
      agentId,
      sessionId: null,
      turnId: null,
      assignmentId: null,
      reportId: null,
    });
    expect(mocks.invalidate).toHaveBeenCalledWith(["projects", "project"]);
  });

  it("preserves known status on failed or empty branch lookups and never accepts an assignment from a merge", () => {
    const result = {
      has_pr: true,
      pr_url: canonical,
      pr_number: 42,
      pr_state: "merged" as const,
      merge_status: "merged" as const,
      is_draft: false,
      ci_status: "passing" as const,
      error: null,
    };
    applyPrStatusSideEffects(agentId, result, 200);
    applyPrStatusSideEffects(
      agentId,
      { has_pr: false, conclusive: false, error: "GitHub unavailable" },
      300
    );
    applyPrStatusSideEffects(agentId, { has_pr: false, conclusive: true, error: null }, 400);
    // A delayed lookup from another workspace must not regress the canonical PR cache.
    captureWorkspacePullRequest(
      db,
      agentId,
      { ...result, pr_state: "open", merge_status: "ready" },
      100
    );
    expect(queryProjectPullRequests(db, projectId)[0]).toMatchObject({
      state: "merged",
      checkedAt: 200,
      ciStatus: "passing",
    });
    expect(store.assignment(agentId).state).toBe("open");
    expect(db.prepare("SELECT COUNT(*) n FROM project_pr_sources").get()).toEqual({ n: 1 });
  });

  it("keeps the previous PR association when a workspace later opens a different PR", () => {
    applyPrStatusSideEffects(
      agentId,
      { has_pr: true, pr_url: canonical, pr_state: "merged", error: null },
      100
    );
    applyPrStatusSideEffects(
      agentId,
      {
        has_pr: true,
        pr_url: "https://github.com/example/repository/pull/43",
        pr_state: "open",
        error: null,
      },
      200
    );
    expect(
      queryProjectPullRequests(db, projectId)
        .map((pr) => pr.number)
        .sort()
    ).toEqual([42, 43]);
  });

  it("uses two batched queries for a populated collection and ignores ordinary workspaces", () => {
    captureReport([canonical, "https://github.com/example/repository/pull/43"]);
    expect(
      captureWorkspacePullRequest(
        db,
        "unmanaged",
        { has_pr: true, pr_url: canonical, error: null },
        100
      )
    ).toBe(false);
    const prepare = vi.spyOn(db, "prepare");
    expect(queryProjectPullRequests(db, projectId)).toHaveLength(2);
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
