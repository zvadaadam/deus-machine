import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import type { CreateProjectInput } from "@shared/projects";
import { ProjectContent } from "../../../src/services/projects/content";
import { ProjectStore, type AgentCreation } from "../../../src/services/projects/store";

let db: Database.Database;
let content: ProjectContent;
let store: ProjectStore;
let directory: string;
let time: number;
const coordinator: AgentCreation = {
  workspaceId: "coordinator-agent",
  sessionId: "coordinator-session",
  repositoryId: "repo",
  title: "Coordinator",
  task: "Deliver the requested change",
  baseCommit: "a".repeat(40),
  sourceBranch: "main",
  coordinator: true,
};
const request: CreateProjectInput = {
  requestId: "create-project",
  title: "A useful change",
  brief: "Implement and test the requested change.",
  repositoryId: "repo",
  model: "claude-model",
  dispatchLimit: 20,
  concurrencyLimit: 1,
};
function create(overrides: Partial<CreateProjectInput> = {}): string {
  return store.create({ ...request, ...overrides }, coordinator);
}
function ready(creation: AgentCreation) {
  db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)").run(
    creation.sessionId,
    creation.workspaceId
  );
  db.prepare("UPDATE workspaces SET state='ready', current_session_id=? WHERE id=?").run(
    creation.sessionId,
    creation.workspaceId
  );
}
function child(projectId: string, name = "child"): AgentCreation {
  const creation = {
    ...coordinator,
    workspaceId: `${name}-agent`,
    sessionId: `${name}-session`,
    title: name,
    task: `Implement ${name}`,
    coordinator: false,
  };
  store.reserveAgent(projectId, `create-${name}`, creation);
  ready(creation);
  return creation;
}
function finishCoordinator() {
  const dispatch = store.reserveDispatch(coordinator.workspaceId)!;
  expect(dispatch).not.toBeNull();
  store.settle(dispatch, { status: "completed" });
  return dispatch;
}

beforeEach(() => {
  fs.mkdirSync(".context", { recursive: true });
  directory = fs.mkdtempSync(path.resolve(".context/projects-test-"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO repositories (id, name, root_path) VALUES ('repo', 'Repository', '/fixture')"
  ).run();
  content = new ProjectContent(directory);
  time = 1_000;
  store = new ProjectStore(db, content, () => time++);
});
afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Project reservation and ownership", () => {
  it("atomically reserves coordinator, work and documents before its conversation exists", () => {
    const id = create();
    const detail = store.detail(id);
    expect(detail).toMatchObject({
      title: request.title,
      brief: request.brief,
      status: "preparing",
      agentCount: 1,
      coordinatorAgentId: coordinator.workspaceId,
      coordinatorSessionId: null,
      pendingInputCount: 1,
    });
    expect(detail.agents[0]).toMatchObject({ role: "coordinator", task: coordinator.task });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 0 });
    const initial = store.pendingInputs(coordinator.workspaceId)[0];
    expect(initial.session_id).toBe(coordinator.sessionId);
    expect(store.assignment(coordinator.workspaceId).initiating_input_id).toBe(initial.id);
  });

  it("reuses stable creation IDs and rejects changed instructions without creating another workspace", () => {
    const id = create();
    expect(create()).toBe(id);
    expect(() => create({ brief: "Different instructions" })).toThrow("Creation request changed");
    expect(db.prepare("SELECT COUNT(*) n FROM projects").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM workspaces").get()).toEqual({ n: 1 });
    expect(store.reserveAgent(id, `${request.requestId}:coordinator`, coordinator)).toBe(
      coordinator.workspaceId
    );
    expect(() =>
      store.reserveAgent(id, `${request.requestId}:coordinator`, {
        ...coordinator,
        task: "Changed",
      })
    ).toThrow("different instructions");
  });

  it("rolls back a failed creation rather than leaving an orphaned Project", () => {
    expect(() => store.create(request, { ...coordinator, repositoryId: "missing" })).toThrow();
    expect(db.prepare("SELECT COUNT(*) n FROM projects").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM project_operations").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM workspaces").get()).toEqual({ n: 0 });
  });
});

describe("durable Project input and scheduling", () => {
  it("does not wake a coordinator on its own completion or replay consumed directions", () => {
    const id = create();
    ready(coordinator);
    const dispatch = finishCoordinator();
    store.settle(dispatch, { status: "completed" });
    expect(store.pendingInputs(coordinator.workspaceId)).toEqual([]);
    expect(store.reserveDispatch(coordinator.workspaceId)).toBeNull();
    expect(store.detail(id).agents[0].status).toBe("idle");
    expect(store.detail(id)).toMatchObject({
      status: "idle",
      pendingInputCount: 0,
      pendingMessages: [],
    });
    expect(db.prepare("SELECT COUNT(*) n FROM project_dispatch_inputs").get()).toEqual({ n: 1 });
  });

  it("deduplicates child outcomes and keeps observational reads from consuming queued work", () => {
    const id = create();
    ready(coordinator);
    finishCoordinator();
    const contributor = child(id);
    const dispatch = store.reserveDispatch(contributor.workspaceId)!;
    store.settle(dispatch, { status: "completed" });
    store.settle(dispatch, { status: "completed" });
    const pending = store.pendingInputs(coordinator.workspaceId);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("turn_outcome");
    store.detail(id);
    store.summaries();
    store.agent(contributor.workspaceId);
    expect(store.pendingInputs(coordinator.workspaceId).map((i) => i.id)).toEqual(
      pending.map((i) => i.id)
    );
    const response = store.reserveDispatch(coordinator.workspaceId)!;
    expect(JSON.parse(response.request_json).prompt).toContain(contributor.workspaceId);
    store.settle(response, { status: "completed" });
    expect(store.reserveDispatch(coordinator.workspaceId)).toBeNull();
  });

  it("labels a human instruction batched with an agent outcome so each keeps its owner", () => {
    const id = create();
    ready(coordinator);
    finishCoordinator();
    const contributor = child(id);
    store.settle(store.reserveDispatch(contributor.workspaceId)!, { status: "completed" });
    const human = store.addInput(
      id,
      coordinator.workspaceId,
      "Also update the README",
      "readme",
      "human"
    );
    const [outcome] = store.pendingInputs(coordinator.workspaceId);
    const dispatch = store.reserveDispatch(coordinator.workspaceId)!;
    const prompt = JSON.parse(dispatch.request_json).prompt as string;
    expect(
      prompt.startsWith(
        `[system/turn_outcome; input ${outcome.id}; from agent ${contributor.workspaceId}; session ${contributor.sessionId}; `
      )
    ).toBe(true);
    expect(prompt).toContain(`\n\n[human/message; input ${human}] Also update the README`);

    store.settle(dispatch, { status: "completed" });
    store.addInput(id, coordinator.workspaceId, "Ship it", "ship", "human");
    const alone = store.reserveDispatch(coordinator.workspaceId)!;
    expect(JSON.parse(alone.request_json).prompt).toBe("Ship it");
  });

  it("makes a guidance question actionable only after its source yields", () => {
    const id = create();
    ready(coordinator);
    finishCoordinator();
    const contributor = child(id);
    const dispatch = store.reserveDispatch(contributor.workspaceId)!;
    const question = store.addInput(
      id,
      coordinator.workspaceId,
      "Which behavior is intended?",
      "question",
      "agent",
      { sessionId: contributor.sessionId, turnId: dispatch.id },
      "question"
    );
    expect(store.pendingInputs(coordinator.workspaceId)).toEqual([]);
    store.settle(dispatch, { status: "completed" });
    expect(store.pendingInputs(coordinator.workspaceId).map((i) => i.kind)).toEqual([
      "question",
      "turn_outcome",
    ]);
    expect(() =>
      store.addInput(
        id,
        contributor.workspaceId,
        "Uncorrelated answer",
        "missing-question",
        "agent",
        { sessionId: coordinator.sessionId, turnId: "response" },
        "reply"
      )
    ).toThrow("identify the question");
    const other = child(id, "other");
    expect(() =>
      store.addInput(
        id,
        contributor.workspaceId,
        "Answer from the wrong conversation",
        "wrong-recipient",
        "agent",
        { sessionId: other.sessionId, turnId: "response" },
        "reply",
        question
      )
    ).toThrow("conversation that received");
    store.addInput(
      id,
      contributor.workspaceId,
      "Use the requested behavior",
      "reply",
      "agent",
      { sessionId: coordinator.sessionId, turnId: "coordinator-response" },
      "reply",
      question
    );
    expect(() =>
      store.addInput(
        id,
        contributor.workspaceId,
        "Another answer",
        "another-reply",
        "agent",
        { sessionId: coordinator.sessionId, turnId: "coordinator-response" },
        "reply",
        question
      )
    ).toThrow("no longer awaiting");
  });

  it("pins accepted messages to their conversation and rejects mutated retries", () => {
    const id = create();
    ready(coordinator);
    finishCoordinator();
    const inputId = store.addInput(id, coordinator.workspaceId, "Follow up", "message", "human");
    expect(store.addInput(id, coordinator.workspaceId, "Follow up", "message", "human")).toBe(
      inputId
    );
    expect(() =>
      store.addInput(id, coordinator.workspaceId, "Changed", "message", "human")
    ).toThrow("retry changed");
    db.prepare("INSERT INTO sessions (id,workspace_id) VALUES ('replacement',?)").run(
      coordinator.workspaceId
    );
    db.prepare(
      "UPDATE workspaces SET current_session_id='replacement',conversation_generation=1 WHERE id=?"
    ).run(coordinator.workspaceId);
    expect(store.reserveDispatch(coordinator.workspaceId)).toBeNull();
    expect(store.pendingInputs(coordinator.workspaceId)[0]).toMatchObject({
      id: inputId,
      session_id: coordinator.sessionId,
      generation: 0,
    });
    expect(store.detail(id).agents[0].status).toBe("idle");
  });

  it("reserves coordinator capacity separately and retains uncertain child occupancy", () => {
    const id = create();
    ready(coordinator);
    const first = child(id, "first"),
      second = child(id, "second");
    const childDispatch = store.reserveDispatch(first.workspaceId)!;
    expect(childDispatch).not.toBeNull();
    expect(store.reserveDispatch(second.workspaceId)).toBeNull();
    expect(store.detail(id).agents.find((agent) => agent.id === second.workspaceId)).toMatchObject({
      status: "queued",
      canRetry: false,
    });
    expect(store.reserveDispatch(coordinator.workspaceId)).not.toBeNull();
    db.prepare("UPDATE project_dispatches SET phase='uncertain' WHERE id=?").run(childDispatch.id);
    expect(store.reserveDispatch(first.workspaceId)).toBeNull();
    expect(store.reserveDispatch(second.workspaceId)).toBeNull();
    expect(store.detail(id).status).toBe("needs-attention");
    store.settle(childDispatch, { status: "completed" });
    expect(store.reserveDispatch(second.workspaceId)).not.toBeNull();
  });

  it("does not dispatch accepted assignments or relabel their queued inputs as new work", () => {
    const id = create();
    ready(coordinator);
    const first = finishCoordinator();
    const staleInputs = Array.from({ length: 17 }, (_, index) =>
      store.addInput(id, coordinator.workspaceId, "Old queued work", `old-${index}`, "human")
    );
    // Recover safely from metadata written before acceptance rejected outstanding work.
    db.prepare("UPDATE project_assignments SET state='accepted' WHERE id=?").run(
      first.assignment_id
    );
    expect(store.reserveDispatch(coordinator.workspaceId)).toBeNull();
    expect(store.detail(id)).toMatchObject({
      status: "idle",
      pendingInputCount: 0,
      pendingMessages: [],
    });
    const currentInput = store.addInput(id, coordinator.workspaceId, "New work", "new", "human");
    expect(store.detail(id)).toMatchObject({ status: "queued", pendingInputCount: 1 });
    const next = store.reserveDispatch(coordinator.workspaceId)!;
    expect(next.assignment_id).not.toBe(first.assignment_id);
    expect(JSON.parse(next.request_json).prompt).toBe("New work");
    expect(
      db.prepare("SELECT input_id FROM project_dispatch_inputs WHERE dispatch_id=?").all(next.id)
    ).toEqual([{ input_id: currentInput }]);
    expect(
      db.prepare("SELECT assignment_id FROM project_inputs WHERE id=?").get(staleInputs[0])
    ).toEqual({ assignment_id: first.assignment_id });
    store.settle(next, { status: "completed" });
    expect(store.detail(id)).toMatchObject({
      status: "idle",
      pendingInputCount: 0,
      pendingMessages: [],
    });
    expect(store.summaries()[0].status).toBe("idle");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM project_inputs WHERE assignment_id=? AND superseded_at IS NULL"
        )
        .get(first.assignment_id)
    ).toEqual({ count: 18 });
  });

  it("enforces both Project/Agent pause and a finite total dispatch allowance", () => {
    const id = create({ dispatchLimit: 2 });
    ready(coordinator);
    const contributor = child(id);
    db.prepare("UPDATE projects SET paused_at=1 WHERE id=?").run(id);
    expect(store.reserveDispatch(coordinator.workspaceId)).toBeNull();
    db.prepare("UPDATE projects SET paused_at=NULL WHERE id=?").run(id);
    db.prepare("UPDATE project_agents SET paused_at=1 WHERE agent_id=?").run(
      contributor.workspaceId
    );
    expect(store.reserveDispatch(contributor.workspaceId)).toBeNull();
    finishCoordinator();
    db.prepare("UPDATE project_agents SET paused_at=NULL WHERE agent_id=?").run(
      contributor.workspaceId
    );
    store.settle(store.reserveDispatch(contributor.workspaceId)!, { status: "completed" });
    expect(store.dispatchCount(id)).toBe(2);
    expect(store.pendingInputs(coordinator.workspaceId)).toHaveLength(1);
    expect(store.reserveDispatch(coordinator.workspaceId)).toBeNull();
    expect(store.summaries()[0].status).toBe("limit-reached");
  });

  it.each(["project", "agent"])("shows cancellation in progress after %s pause", (scope) => {
    const id = create();
    ready(coordinator);
    const dispatch = store.reserveDispatch(coordinator.workspaceId)!;
    if (scope === "project") db.prepare("UPDATE projects SET paused_at=1 WHERE id=?").run(id);
    else
      db.prepare("UPDATE project_agents SET paused_at=1 WHERE agent_id=?").run(
        coordinator.workspaceId
      );
    for (const [phase, status] of [
      ["prepared", "paused"],
      ["submitting", "stopping"],
      ["admitted", "stopping"],
      ["uncertain", "needs-attention"],
    ]) {
      db.prepare("UPDATE project_dispatches SET phase=? WHERE id=?").run(phase, dispatch.id);
      expect(store.detail(id).agents[0].status).toBe(status);
    }
    store.settle(dispatch, { status: "cancelled" });
    expect(store.detail(id).agents[0].status).toBe("paused");
  });
});

describe("published Project evidence", () => {
  it("uses conditional publication and keeps earlier bytes available after a later edit", () => {
    const id = create();
    const before = store.manifest(id)["brief.md"];
    expect(store.publish(id, "publish", [{ path: "brief.md", content: "Revised brief" }], 0)).toBe(
      1
    );
    expect(store.publish(id, "publish", [{ path: "brief.md", content: "Revised brief" }], 0)).toBe(
      1
    );
    expect(() =>
      store.publish(id, "stale", [{ path: "brief.md", content: "Stale edit" }], 0)
    ).toThrow("files changed");
    expect(content.read(before)).toBe(request.brief);
    expect(store.detail(id).brief).toBe("Revised brief");
    expect(store.operation("stale")).toBeUndefined();
  });

  it("retains immutable report provenance and artifact revisions across later publication", () => {
    const id = create();
    ready(coordinator);
    const contributor = child(id);
    const dispatch = store.reserveDispatch(contributor.workspaceId)!;
    const actor = { sessionId: contributor.sessionId, turnId: dispatch.id };
    const files = [{ path: "evidence.txt", content: "Tests passed" }];
    const reportId = store.report(
      contributor.workspaceId,
      actor,
      "report",
      "Change is ready",
      files,
      ["https://github.com/example/repo/pull/1"]
    );
    expect(
      store.report(contributor.workspaceId, actor, "report", "Change is ready", files, [
        "https://github.com/example/repo/pull/1",
      ])
    ).toBe(reportId);
    expect(() =>
      store.report(contributor.workspaceId, actor, "report", "Different result", files, [])
    ).toThrow("different instructions");
    const original = store.detail(id).reports[0];
    expect(original).toMatchObject({
      id: reportId,
      sessionId: contributor.sessionId,
      turnId: dispatch.id,
      accepted: false,
      ready: false,
    });
    store.settle(dispatch, { status: "completed" });
    expect(store.detail(id).reports[0].ready).toBe(true);
    store.publish(
      id,
      "later",
      [{ path: original.files[0].path, content: "Later evidence" }],
      original.revision
    );
    expect(content.read(store.detail(id).reports[0].files[0])).toBe("Tests passed");
    expect(store.detail(id).reports[0].revision).toBe(original.revision);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects traversal and detects modified published blobs", () => {
    expect(() => content.write("../outside", "bad")).toThrow("relative Project file path");
    const file = content.write("notes.md", "Original");
    fs.writeFileSync(path.join(directory, file.hash), "Changed");
    expect(() => content.read(file)).toThrow("integrity check");
  });

  it("does not publish partial writes and safely reuses an existing complete blob", () => {
    const write = fs.writeFileSync.bind(fs);
    const failure = vi.spyOn(fs, "writeFileSync").mockImplementationOnce((file) => {
      write(file, "Partial write");
      throw new Error("Interrupted write");
    });
    expect(() => content.write("evidence.txt", "Complete evidence")).toThrow("Interrupted write");
    failure.mockRestore();
    expect(fs.readdirSync(directory)).toEqual([]);
    const file = content.write("evidence.txt", "Complete evidence");
    expect(content.write("copy.txt", "Complete evidence").hash).toBe(file.hash);
    expect(content.read(file)).toBe("Complete evidence");
    expect(fs.readdirSync(directory)).toEqual([file.hash]);
  });
});

describe("Project query projections", () => {
  it("lists metadata without loading documents and uses bounded queries as membership grows", () => {
    const id = create();
    ready(coordinator);
    for (let i = 0; i < 8; i++) child(id, `child-${i}`);
    const reportingTurn = store.reserveDispatch("child-0-agent")!;
    store.report(
      "child-0-agent",
      { sessionId: "child-0-session", turnId: reportingTurn.id },
      "query-report",
      "A change to review",
      [],
      ["https://github.com/example/repository/pull/42"]
    );
    store.settle(reportingTurn, { status: "completed" });
    const read = vi.spyOn(content, "read");
    const prepare = vi.spyOn(db, "prepare");
    const list = store.summaries();
    expect(list[0]).toMatchObject({
      agentCount: 9,
      reportCount: 1,
      repositoryName: "Repository",
      status: "queued",
    });
    expect(read).not.toHaveBeenCalled();
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(2);
    prepare.mockClear();
    const detail = store.detail(id);
    expect(detail.agents).toHaveLength(9);
    expect(detail.agents.filter((agent) => agent.role === "coordinator")).toHaveLength(1);
    expect(detail).toMatchObject(list[0]);
    expect(detail.pullRequests).toHaveLength(1);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(7);
  });
});

describe("Projects created without a brief", () => {
  it("opens with a system welcome, keeps it out of the task, and adopts the first instruction as the brief", () => {
    const id = store.create({ ...request, brief: "" }, { ...coordinator, task: "" });
    const detail = store.detail(id);
    expect(detail.brief).toBe("");
    expect(detail.agents[0]).toMatchObject({ role: "coordinator", task: "" });
    const [welcome] = store.pendingInputs(coordinator.workspaceId);
    expect(welcome).toMatchObject({ origin: "system", kind: "welcome" });
    const payload = JSON.parse(welcome.payload_json) as { message: string };
    expect(payload.message).toContain("first Deus Project");
    expect(payload.message).toContain("Repository repository");
    expect(payload.message).toContain(`"${request.title}"`);

    ready(coordinator);
    const dispatch = store.reserveDispatch(coordinator.workspaceId)!;
    const opening = JSON.parse(dispatch.request_json) as {
      prompt: string;
      systemPromptAppend: string;
    };
    expect(opening.prompt).toContain("[system/welcome");
    expect(opening.systemPromptAppend).toContain("No brief has been published yet");
    expect(opening.systemPromptAppend).toContain("Project brief: not written yet.");
    expect(opening.systemPromptAppend).not.toContain("Plan the requested result");
    store.settle(dispatch, { status: "completed" });

    expect(store.adoptBrief(id, "first:brief", "Build a pocket ledger")).toBe(1);
    expect(store.adoptBrief(id, "second:brief", "Something else")).toBeNull();
    const briefed = store.detail(id);
    expect(briefed.brief).toBe("Build a pocket ledger");
    expect(briefed.contentRevision).toBe(1);
    expect(briefed.agents[0].task).toBe("Build a pocket ledger");

    store.addInput(id, coordinator.workspaceId, "Build a pocket ledger", "first", "human");
    const next = store.reserveDispatch(coordinator.workspaceId)!;
    const work = JSON.parse(next.request_json) as { prompt: string; systemPromptAppend: string };
    expect(next.content_revision).toBe(1);
    expect(work.prompt).toBe("Build a pocket ledger");
    expect(work.systemPromptAppend).toContain("Project brief:\nBuild a pocket ledger");
    expect(work.systemPromptAppend).toContain("Plan the requested result");
    expect(store.assignment(coordinator.workspaceId).id).toBe(detail.agents[0].assignmentId);
  });

  it("greets later Projects briefly and never rewrites a written brief from chat", () => {
    const first = create();
    const second = {
      ...coordinator,
      workspaceId: "second-agent",
      sessionId: "second-session",
      task: "",
    };
    store.create({ ...request, requestId: "create-second", brief: "" }, second);
    const [welcome] = store.pendingInputs(second.workspaceId);
    const payload = JSON.parse(welcome.payload_json) as { message: string };
    expect(payload.message).not.toContain("first Deus Project");
    expect(payload.message).toContain("greet the user");
    expect(store.adoptBrief(first, "first:brief", "Replace the brief")).toBeNull();
    expect(store.detail(first).brief).toBe(request.brief);
    expect(store.detail(first).agents[0].task).toBe(coordinator.task);
  });
});
