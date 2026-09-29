import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import { ProjectContent } from "../../../src/services/projects/content";
import {
  ProjectStore,
  type AgentCreation,
  type DispatchRow,
} from "../../../src/services/projects/store";

let db: Database.Database;
let store: ProjectStore;
let directory: string;
let projectId: string;
let sequence: number;
const coordinator: AgentCreation = {
  workspaceId: "coordinator",
  sessionId: "coordinator-session",
  repositoryId: "repo",
  title: "Coordinator",
  task: "Deliver the change",
  baseCommit: "a".repeat(40),
  sourceBranch: "main",
  coordinator: true,
};

function ready(creation: AgentCreation) {
  db.prepare("INSERT INTO sessions(id,workspace_id) VALUES(?,?)").run(
    creation.sessionId,
    creation.workspaceId
  );
  db.prepare("UPDATE workspaces SET state='ready',current_session_id=? WHERE id=?").run(
    creation.sessionId,
    creation.workspaceId
  );
  store.complete(store.agent(creation.workspaceId).creation_operation_id, {});
}
function start(agentId = coordinator.workspaceId) {
  const turn = store.reserveDispatch(agentId)!;
  expect(turn).not.toBeNull();
  db.prepare("UPDATE project_dispatches SET phase='admitted' WHERE id=?").run(turn.id);
  return turn;
}
function report(turn: DispatchRow) {
  return store.report(
    turn.agent_id,
    { sessionId: turn.session_id, turnId: turn.id },
    `report-${sequence++}`,
    "The requested result is complete.",
    [],
    []
  );
}
function finish(turn: DispatchRow) {
  store.settle(turn, { status: "completed" });
}
function status() {
  const summary = store.summaries().find((project) => project.id === projectId)!;
  expect(store.detail(projectId).status).toBe(summary.status);
  return summary.status;
}
function child() {
  const creation = {
    ...coordinator,
    workspaceId: "child",
    sessionId: "child-session",
    coordinator: false,
  };
  store.reserveAgent(projectId, "create-child", creation);
  ready(creation);
  return creation;
}

beforeEach(() => {
  fs.mkdirSync(".context", { recursive: true });
  directory = fs.mkdtempSync(path.resolve(".context/project-status-"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO repositories(id,name,root_path) VALUES('repo','Repository','/fixture')"
  ).run();
  sequence = 1_000;
  store = new ProjectStore(db, new ProjectContent(directory), () => sequence++);
  projectId = store.create(
    {
      requestId: "create",
      title: "A useful result",
      brief: "Deliver the change",
      repositoryId: "repo",
      model: "claude-model",
      dispatchLimit: 20,
    },
    coordinator
  );
  ready(coordinator);
});
afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Project review readiness", () => {
  it("distinguishes queued instructions and an idle coordinator with no report", () => {
    expect(status()).toBe("queued");
    finish(start());
    expect(status()).toBe("idle");
    store.addInput(
      projectId,
      coordinator.workspaceId,
      "One more requirement",
      "follow-up",
      "human"
    );
    expect(status()).toBe("queued");
    expect(store.detail(projectId).agents[0].status).toBe("queued");
  });

  it("requires a settled current coordinator report and stops advertising accepted history", () => {
    const turn = start();
    const reportId = report(turn);
    expect(status()).toBe("working");
    finish(turn);
    expect(status()).toBe("ready");
    db.prepare(
      "UPDATE project_assignments SET state='accepted',accepted_report_id=? WHERE id=?"
    ).run(reportId, turn.assignment_id);
    expect(status()).toBe("done");
    store.addInput(
      projectId,
      coordinator.workspaceId,
      "A separate assignment",
      "next-assignment",
      "human"
    );
    expect(status()).toBe("queued");
    finish(start());
    expect(status()).toBe("idle");
  });

  it("does not advertise review while a contributor has an unfinished or paused assignment", () => {
    const first = start();
    child();
    report(first);
    finish(first);
    const unfinished = start("child");
    finish(unfinished);
    // Consume the outcome: the child yielded but never published its requested result.
    const review = start();
    report(review);
    finish(review);
    expect(status()).toBe("idle");
    store.addInput(projectId, "child", "Finish and report", "child-follow-up", "human");
    const reported = start("child");
    report(reported);
    finish(reported);
    const combined = start();
    report(combined);
    finish(combined);
    expect(status()).toBe("ready");
    db.prepare("UPDATE project_agents SET paused_at=1 WHERE agent_id='child'").run();
    expect(status()).toBe("idle");
  });

  it("does not show an accepted coordinator result as done while other work remains", () => {
    const turn = start();
    child();
    const reportId = report(turn);
    finish(turn);
    db.prepare(
      "UPDATE project_assignments SET state='accepted',accepted_report_id=? WHERE id=?"
    ).run(reportId, turn.assignment_id);
    expect(status()).toBe("queued");
    const implementation = start("child");
    expect(status()).toBe("working");
    finish(implementation);
    expect(status()).toBe("queued");
    finish(start());
    expect(status()).toBe("idle");
  });

  it("calls a paused prepared dispatch queued instead of working or reviewable", () => {
    finish(start());
    child();
    store.reserveDispatch("child");
    expect(store.detail(projectId).agents.find((agent) => agent.id === "child")?.status).toBe(
      "queued"
    );
    expect(store.detail(projectId).activeAgentCount).toBe(0);
    db.prepare("UPDATE project_agents SET paused_at=1 WHERE agent_id='child'").run();
    expect(status()).toBe("queued");
  });

  it("does not use an earlier report after later directions finish without a new report", () => {
    const first = start();
    report(first);
    finish(first);
    expect(status()).toBe("ready");
    store.addInput(projectId, coordinator.workspaceId, "Revise the result", "revision", "human");
    finish(start());
    expect(status()).toBe("idle");
  });

  it("keeps a contributor unfinished when its latest attempt has no report", () => {
    const first = start();
    child();
    finish(first);
    const implementation = start("child");
    report(implementation);
    finish(implementation);
    const review = start();
    report(review);
    finish(review);
    expect(status()).toBe("ready");
    store.addInput(projectId, "child", "Revise the implementation", "child-revision", "human");
    finish(start("child"));
    const lastReview = start();
    report(lastReview);
    finish(lastReview);
    expect(status()).toBe("idle");
  });

  it("allows review at the dispatch limit, but shows the limit when new work is queued", () => {
    db.prepare("UPDATE projects SET dispatch_limit=1 WHERE id=?").run(projectId);
    const turn = start();
    const reportId = report(turn);
    finish(turn);
    expect(status()).toBe("ready");
    db.prepare(
      "UPDATE project_assignments SET state='accepted',accepted_report_id=? WHERE id=?"
    ).run(reportId, turn.assignment_id);
    expect(status()).toBe("done");
    store.addInput(
      projectId,
      coordinator.workspaceId,
      "Another requirement",
      "over-limit",
      "human"
    );
    expect(status()).toBe("limit-reached");
    expect(store.detail(projectId).agents[0].status).toBe("queued");
  });
});
