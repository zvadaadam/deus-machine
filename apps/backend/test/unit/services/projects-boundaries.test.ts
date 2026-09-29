/** Review probes: real Project metadata/commands; no model, Git or app processes. */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import type {
  AgentCreation,
  DispatchRow,
  ProjectStore,
} from "../../../src/services/projects/store";
import type * as ProjectService from "../../../src/services/projects/service";
import { toEngineInput } from "../../../src/services/agent/run-config";

const mocks = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  databasePath: `${process.cwd()}/.context/projects-boundaries-${crypto.randomUUID()}/deus.db`,
}));
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => mocks.db!,
  DB_PATH: mocks.databasePath,
}));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("../../../src/services/workspace-init.service", () => ({
  prepareProjectWorkspace: vi.fn(),
  resolveProjectBaseCommit: vi.fn(),
}));

let projects: typeof ProjectService;
let store: ProjectStore;
let projectId: string;
const coordinator: AgentCreation = {
  workspaceId: "coordinator",
  sessionId: "coordinator-session",
  repositoryId: "repo",
  title: "Coordinator",
  task: "Deliver the requested change",
  baseCommit: "fixture-commit",
  sourceBranch: "main",
  coordinator: true,
};

function ready(creation: AgentCreation) {
  mocks
    .db!.prepare("INSERT INTO sessions(id,workspace_id) VALUES(?,?)")
    .run(creation.sessionId, creation.workspaceId);
  mocks
    .db!.prepare("UPDATE workspaces SET current_session_id=?,state='ready' WHERE id=?")
    .run(creation.sessionId, creation.workspaceId);
  store.complete(store.agent(creation.workspaceId).creation_operation_id, {});
}

function dispatch(agentId = coordinator.workspaceId): DispatchRow {
  const value = store.reserveDispatch(agentId)!;
  expect(value).not.toBeNull();
  mocks.db!.prepare("UPDATE project_dispatches SET phase='admitted' WHERE id=?").run(value.id);
  return value;
}

function invoke(d: DispatchRow, operation: string, args: Record<string, unknown>) {
  return projects.handleProjectTool({
    sessionId: d.session_id,
    turnId: d.id,
    toolCallId: crypto.randomUUID(),
    operation,
    args,
  }) as Record<string, string>;
}

beforeEach(async () => {
  vi.resetModules();
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys=ON");
  mocks.db.exec(SCHEMA_SQL);
  mocks.db
    .prepare("INSERT INTO repositories(id,name,root_path) VALUES('repo','Fixture',?)")
    .run(path.dirname(mocks.databasePath));
  projects = await import("../../../src/services/projects/service");
  store = projects.getProjectStore();
  projectId = store.create(
    {
      requestId: "create",
      repositoryId: "repo",
      title: "Boundary fixture",
      brief: coordinator.task,
      model: "claude-opus-4-6",
    },
    coordinator
  );
  ready(coordinator);
});

afterEach(() => {
  projects.stopProjects();
  mocks.db?.close();
  fs.rmSync(path.dirname(mocks.databasePath), { recursive: true, force: true });
});

describe("Project trust and lifecycle review", () => {
  it("keeps completed tool receipts exact and refuses a fresh stale invocation", () => {
    const first = dispatch();
    const envelope = {
      sessionId: first.session_id,
      turnId: first.id,
      toolCallId: "stable-invocation",
      operation: "report_result",
      args: { summary: "Done" },
    };
    const receipt = projects.handleProjectTool(envelope);
    store.settle(first, { status: "completed" });
    expect(projects.handleProjectTool(envelope)).toEqual(receipt);
    expect(() =>
      projects.handleProjectTool({ ...envelope, args: { summary: "Changed" } })
    ).toThrow();
    expect(() => projects.handleProjectTool({ ...envelope, toolCallId: "new-invocation" })).toThrow(
      "inactive turn"
    );
  });

  it("restricts contributor tools to the coordinator and the contributor's own transcript", () => {
    const child = {
      ...coordinator,
      workspaceId: "child",
      sessionId: "child-session",
      coordinator: false,
    };
    store.reserveAgent(projectId, "create-child", child);
    ready(child);
    const active = dispatch(child.workspaceId);
    expect(() =>
      invoke(active, "create_agent", { title: "Unauthorized", task: "Another child" })
    ).toThrow("only available to the coordinator");
    expect(() =>
      invoke(active, "read_agent_transcript", { agentId: coordinator.workspaceId })
    ).toThrow("own transcript");
    expect(() =>
      invoke(active, "publish_context", {
        mode: "publish",
        path: "plan.md",
        content: "Unauthorized",
        expectedRevision: 0,
      })
    ).toThrow("only available to the coordinator");
    expect(store.detail(projectId).agents).toHaveLength(2);
    expect(store.project(projectId).content_head_revision).toBe(0);
  });

  it("rejects traversal and corrupted bytes even when a blob path is replaced with a symlink", () => {
    expect(() =>
      projects.publishProjectFile(projectId, {
        requestId: "traversal",
        path: "../escape",
        content: "Outside",
        expectedRevision: 0,
      })
    ).toThrow("relative Project file path");
    const brief = store.manifest(projectId)["brief.md"];
    const blob = path.join(path.dirname(mocks.databasePath), "projects", "blobs", brief.hash);
    const other = path.join(path.dirname(mocks.databasePath), "replacement.txt");
    fs.writeFileSync(other, "Changed source bytes");
    fs.unlinkSync(blob);
    fs.symlinkSync(other, blob);
    expect(() => projects.readProjectFile(projectId, "brief.md")).toThrow("integrity check");
  });

  it.each(["queued", "prepared", "submitting", "admitted", "uncertain"])(
    "keeps an assignment open when accepting its earlier report with %s work",
    (phase) => {
      const first = dispatch();
      const firstReport = invoke(first, "report_result", { summary: "First complete result" });
      store.settle(first, { status: "completed" });
      const input = projects.sendProjectInput(projectId, {
        requestId: "follow-up",
        message: "Polish the result",
      });
      if (phase !== "queued") {
        const second = store.reserveDispatch(coordinator.workspaceId)!;
        mocks.db!.prepare("UPDATE project_dispatches SET phase=? WHERE id=?").run(phase, second.id);
      }
      projects.controlProject(projectId, "pause", "pause-project");

      expect(() =>
        projects.controlProject(projectId, "accept", "accept-first", {
          reportId: firstReport.reportId,
        })
      ).toThrow("queued or running work");
      expect(store.assignment(coordinator.workspaceId)).toMatchObject({
        id: first.assignment_id,
        state: "open",
      });
      expect(store.detail(projectId).reports[0].accepted).toBe(false);
      expect(store.operation("accept-first")).toBeUndefined();

      if (phase === "queued") {
        projects.controlProject(projectId, "cancel_input", "cancel-follow-up", {
          inputId: input.inputId,
        });
        projects.controlProject(projectId, "accept", "accept-first", {
          reportId: firstReport.reportId,
        });
        projects.sendProjectInput(projectId, {
          requestId: "new-work",
          message: "Implement the next feature",
        });
        projects.controlProject(projectId, "resume", "resume-project");
        const next = dispatch();
        expect(next.assignment_id).not.toBe(first.assignment_id);
        invoke(next, "report_result", { summary: "The next feature is ready" });
        store.settle(next, { status: "completed" });
        expect(store.detail(projectId).status).toBe("ready");
      }
    }
  );

  it("keeps new work's evidence separate when accepting an older report with other assignments running", () => {
    const first = dispatch();
    const firstReport = invoke(first, "report_result", { summary: "First complete result" });
    const alternativeReport = invoke(first, "report_result", { summary: "Alternative summary" });
    const child = {
      ...coordinator,
      workspaceId: "child",
      sessionId: "child-session",
      coordinator: false,
    };
    store.reserveAgent(projectId, "create-child", child);
    ready(child);
    dispatch(child.workspaceId);
    store.settle(first, { status: "completed" });
    projects.controlProject(projectId, "accept", "accept-first", {
      reportId: firstReport.reportId,
    });
    projects.sendProjectInput(projectId, {
      requestId: "new-work",
      message: "Implement a different feature",
    });
    const second = dispatch();
    expect(second.assignment_id).not.toBe(first.assignment_id);
    projects.controlProject(projectId, "accept", "accept-alternative", {
      reportId: alternativeReport.reportId,
    });
    expect(store.assignment(coordinator.workspaceId)).toMatchObject({
      id: second.assignment_id,
      state: "open",
    });

    const secondReport = invoke(second, "report_result", {
      summary: "Implemented the new feature",
      files: [{ path: "validation.md", content: "The new feature passes" }],
      pullRequests: ["https://github.com/example/project/pull/23"],
    });
    const evidence = mocks
      .db!.prepare(
        "SELECT r.assignment_id,d.assignment_id dispatch_assignment,p.assignment_id pr_assignment,r.files_json FROM project_reports r JOIN project_dispatches d ON d.id=r.turn_id JOIN project_pr_sources p ON p.report_id=r.id WHERE r.id=?"
      )
      .get(secondReport.reportId) as {
      assignment_id: string;
      dispatch_assignment: string;
      pr_assignment: string;
      files_json: string;
    };
    expect.soft(evidence.assignment_id).toBe(evidence.dispatch_assignment);
    expect.soft(evidence.pr_assignment).toBe(evidence.dispatch_assignment);
    expect
      .soft(JSON.parse(evidence.files_json)[0].path)
      .toContain(`results/${second.assignment_id}/`);
  });

  it("delivers attributable questions when contributors finish in the opposite order", () => {
    store.settle(dispatch(), { status: "completed" });
    const questions = ["first", "second"].map((name) => {
      const child = {
        ...coordinator,
        workspaceId: name,
        sessionId: `${name}-session`,
        coordinator: false,
      };
      store.reserveAgent(projectId, `create-${name}`, child);
      ready(child);
      const turn = dispatch(child.workspaceId);
      const question = invoke(turn, "send_to_agent", {
        agentId: "coordinator",
        kind: "question",
        message: "Which behavior should I implement?",
      });
      return { turn, question };
    });
    store.settle(questions[1].turn, { status: "completed" });
    store.settle(questions[0].turn, { status: "completed" });
    const answerTurn = dispatch();
    const prompt = JSON.parse(answerTurn.request_json).prompt as string;
    const delivered = [
      ...prompt.matchAll(
        /\[agent\/question; input ([^;]+); from agent ([^;]+); session ([^;]+); turn ([^\]]+)\]/g
      ),
    ];
    expect(delivered).toHaveLength(2);
    for (const [, inputId, agentId, sessionId, turnId] of delivered) {
      const source = questions.find(({ question }) => question.inputId === inputId)!;
      expect({ agentId, sessionId, turnId }).toEqual({
        agentId: source.turn.agent_id,
        sessionId: source.turn.session_id,
        turnId: source.turn.id,
      });
      expect(
        invoke(answerTurn, "send_to_agent", {
          agentId,
          kind: "reply",
          replyTo: inputId,
          message: "Implement the documented behavior",
        })
      ).toHaveProperty("inputId");
    }
  });

  it("does not let a late answer to an accepted assignment open new child work", () => {
    const parent = dispatch();
    const child = {
      ...coordinator,
      workspaceId: "child",
      sessionId: "child-session",
      coordinator: false,
    };
    store.reserveAgent(projectId, "create-child", child);
    ready(child);
    store.settle(parent, { status: "completed" });
    const askingTurn = dispatch(child.workspaceId);
    const question = invoke(askingTurn, "send_to_agent", {
      agentId: "coordinator",
      kind: "question",
      message: "Use behavior A or B?",
    });
    store.settle(askingTurn, { status: "completed" });
    const answerTurn = dispatch();

    // The human unblocks the child while the coordinator is still preparing its answer.
    projects.sendProjectInput(projectId, {
      requestId: "human-answer",
      agentId: child.workspaceId,
      message: "Use B and finish",
    });
    const finishingTurn = dispatch(child.workspaceId);
    const report = invoke(finishingTurn, "report_result", { summary: "B implemented and tested" });
    store.settle(finishingTurn, { status: "completed" });
    projects.controlProject(projectId, "accept", "accept-child", { reportId: report.reportId });

    expect
      .soft(() =>
        invoke(answerTurn, "send_to_agent", {
          agentId: child.workspaceId,
          kind: "reply",
          replyTo: question.inputId,
          message: "Use A",
        })
      )
      .toThrow();
    expect.soft(store.assignment(child.workspaceId).state).toBe("accepted");
    expect.soft(store.reserveDispatch(child.workspaceId)).toBeNull();
  });

  it.each([
    { permissionMode: "plan" },
    { resumeSessionAt: "previous-message" },
    { additionalDirectories: ["/other-workspace"] },
  ])("rejects unsupported managed command options before queueing: %j", async (options) => {
    store.settle(dispatch(), { status: "completed" });
    const command = {
      sessionId: coordinator.sessionId,
      turnId: "human-plan-command",
      content: "Inspect and plan the next change",
      agentHarness: "claude-code",
      model: "claude-opus-4-6",
      ...options,
    };
    // Exercise the actual public q:command implementation, including its mode validator.
    const { runCommand } = await import("../../../src/services/agent/commands");
    await expect(runCommand("sendMessage", command)).rejects.toThrow(
      `Project conversations do not support the ${Object.keys(options)[0]} option.`
    );
    expect(store.pendingInputs(coordinator.workspaceId)).toEqual([]);
    expect(store.reserveDispatch(coordinator.workspaceId)).toBeNull();
  });

  it("rejects structured image input instead of flattening it into another queued direction", async () => {
    store.settle(dispatch(), { status: "completed" });
    const parts = [
      { type: "text", text: "Implement this reference" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ];
    const imageMessage = JSON.stringify(parts);
    expect(toEngineInput(imageMessage)).toEqual(parts);
    const { runCommand } = await import("../../../src/services/agent/commands");
    await expect(
      runCommand("sendMessage", {
        sessionId: coordinator.sessionId,
        turnId: "image-direction",
        content: imageMessage,
        agentHarness: "claude-code",
        model: "claude-opus-4-6",
      })
    ).rejects.toThrow("Project conversations currently accept plain text only.");
    projects.sendProjectInput(projectId, {
      requestId: "second-direction",
      message: "Match its spacing too",
    });
    const next = store.reserveDispatch(coordinator.workspaceId)!;
    const input = toEngineInput(JSON.parse(next.request_json).prompt);
    expect(input).toBe("Match its spacing too");
  });

  it("persists every successful logical filename, including __proto__", () => {
    const published = projects.publishProjectFile(projectId, {
      requestId: "publish-special-name",
      path: "__proto__",
      content: "Valid relative filename",
      expectedRevision: 0,
    });
    expect(published.revision).toBe(1);
    expect(Object.hasOwn(store.manifest(projectId), "__proto__")).toBe(true);
    expect(projects.readProjectFile(projectId, "__proto__").content).toBe(
      "Valid relative filename"
    );
  });
});

describe("visible queued Project messages", () => {
  it("shows the oldest 50 human messages while retaining full human and total counts", () => {
    store.settle(dispatch(), { status: "completed" });
    const inputIds: string[] = [];
    for (let index = 0; index < 55; index++) {
      inputIds.push(
        projects.sendProjectInput(projectId, {
          requestId: `direction-${index}`,
          message: `Human direction ${index}`,
        }).inputId
      );
      mocks
        .db!.prepare("UPDATE project_inputs SET created_at=? WHERE id=?")
        .run(10_000 + index, inputIds[index]);
    }
    for (let index = 0; index < 2; index++)
      store.addInput(
        projectId,
        coordinator.workspaceId,
        "Automatic outcome",
        `outcome-${index}`,
        "system"
      );
    const detail = projects.getProject(projectId);
    expect(detail.pendingMessageCount).toBe(55);
    expect(detail.pendingInputCount).toBe(57);
    expect(detail.pendingMessages.map((message) => message.id)).toEqual(inputIds.slice(0, 50));
    expect(detail.pendingMessages[0]).toMatchObject({
      agentId: coordinator.workspaceId,
      message: "Human direction 0",
      createdAt: expect.any(Number),
    });
  });

  it("cancels through REST while paused without deleting the original assignment or input", async () => {
    const initial = store.pendingInputs(coordinator.workspaceId)[0];
    projects.controlProject(projectId, "pause", "pause");
    const { default: routes } = await import("../../../src/routes/projects");
    const app = new Hono().route("/api", routes);
    const cancel = () =>
      app.request(`/api/projects/${projectId}/inputs/${initial.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "cancel-initial" }),
      });
    expect((await cancel()).status).toBe(200);
    expect((await cancel()).status).toBe(200);
    const retained = mocks
      .db!.prepare("SELECT superseded_at FROM project_inputs WHERE id=?")
      .get(initial.id) as { superseded_at: number };
    expect(retained.superseded_at).toEqual(expect.any(Number));
    expect(store.assignment(coordinator.workspaceId).initiating_input_id).toBe(initial.id);
    expect(store.operation("cancel-initial")?.state).toBe("succeeded");
    expect(projects.getProject(projectId)).toMatchObject({
      pendingInputCount: 0,
      pendingMessageCount: 0,
      pendingMessages: [],
    });
    projects.controlProject(projectId, "resume", "resume");
    expect(store.reserveDispatch(coordinator.workspaceId)).toBeNull();
  });

  it.each(["prepared", "admitted", "finished"] as const)(
    "rejects cancellation after dispatch reservation wins the race (%s)",
    (phase) => {
      const input = store.pendingInputs(coordinator.workspaceId)[0];
      const reserved = store.reserveDispatch(coordinator.workspaceId)!;
      if (phase === "finished") store.settle(reserved, { status: "completed" });
      else
        mocks
          .db!.prepare("UPDATE project_dispatches SET phase=? WHERE id=?")
          .run(phase, reserved.id);
      expect(() =>
        projects.controlProject(projectId, "cancel_input", "too-late", { inputId: input.id })
      ).toThrow("already been dispatched");
      expect(
        mocks.db!.prepare("SELECT request_json FROM project_dispatches WHERE id=?").get(reserved.id)
      ).toEqual({ request_json: reserved.request_json });
      expect(
        mocks.db!.prepare("SELECT superseded_at FROM project_inputs WHERE id=?").get(input.id)
      ).toEqual({ superseded_at: null });
      expect(store.operation("too-late")).toBeUndefined();
    }
  );

  it("rejects cancellation of automatic and historical conversation inputs", () => {
    const initial = store.pendingInputs(coordinator.workspaceId)[0];
    const automatic = store.addInput(
      projectId,
      coordinator.workspaceId,
      "Outcome",
      "outcome",
      "system"
    );
    expect(() =>
      projects.controlProject(projectId, "cancel_input", "cancel-outcome", { inputId: automatic })
    ).toThrow("queued human message");
    mocks
      .db!.prepare(
        "UPDATE workspaces SET conversation_generation=conversation_generation+1 WHERE id=?"
      )
      .run(coordinator.workspaceId);
    expect(() =>
      projects.controlProject(projectId, "cancel_input", "cancel-history", { inputId: initial.id })
    ).toThrow("current conversation");
    expect(
      mocks.db!.prepare("SELECT superseded_at FROM project_inputs WHERE id=?").get(initial.id)
    ).toEqual({ superseded_at: null });
  });
});
