import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import type { ProjectAgentStatusResult, ProjectTranscriptResult } from "@shared/projects";
import type {
  AgentCreation,
  DispatchRow,
  ProjectStore,
} from "../../../src/services/projects/store";
import type * as ProjectService from "../../../src/services/projects/service";

const mocks = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  databasePath: `${process.cwd()}/.context/projects-inspection-${crypto.randomUUID()}/deus.db`,
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
let parentTurn: DispatchRow;
let childTurn: DispatchRow;
const coordinator: AgentCreation = {
  workspaceId: "coordinator",
  sessionId: "coordinator-session",
  repositoryId: "repo",
  title: "Coordinator",
  task: "Integrate the contributors' work",
  baseCommit: "fixture-commit",
  sourceBranch: "main",
  coordinator: true,
};
const child: AgentCreation = {
  ...coordinator,
  workspaceId: "child",
  sessionId: "child-session",
  title: "Contributor",
  coordinator: false,
};

function ready(creation: AgentCreation) {
  mocks
    .db!.prepare("INSERT INTO sessions(id,workspace_id) VALUES(?,?)")
    .run(creation.sessionId, creation.workspaceId);
  mocks
    .db!.prepare("UPDATE workspaces SET current_session_id=?,state='ready' WHERE id=?")
    .run(creation.sessionId, creation.workspaceId);
  store.complete(store.agent(creation.workspaceId).creation_operation_id, {});
  const dispatch = store.reserveDispatch(creation.workspaceId)!;
  mocks.db!.prepare("UPDATE project_dispatches SET phase='admitted' WHERE id=?").run(dispatch.id);
  return dispatch;
}
function invoke(operation: string, args: Record<string, unknown> = {}, source = parentTurn) {
  return projects.handleProjectTool({
    sessionId: source.session_id,
    turnId: source.id,
    toolCallId: crypto.randomUUID(),
    operation,
    args,
  });
}
function transcript(args: Record<string, unknown> = {}) {
  return invoke("read_agent_transcript", {
    agentId: child.workspaceId,
    ...args,
  }) as ProjectTranscriptResult;
}
function message(id: string, parts: Record<string, unknown>[] = [], sessionId = child.sessionId) {
  mocks
    .db!.prepare(
      "INSERT INTO messages(id,session_id,role,turn_id) VALUES(?,?,'assistant','observed-turn')"
    )
    .run(id, sessionId);
  for (const [seq, part] of parts.entries()) {
    mocks
      .db!.prepare("INSERT INTO parts(id,message_id,session_id,seq,type,data) VALUES(?,?,?,?,?,?)")
      .run(
        `${id}-part-${seq}`,
        id,
        sessionId,
        seq,
        part.type,
        JSON.stringify({ id: `${id}-part-${seq}`, messageId: id, sessionId, ...part })
      );
  }
}
function pageIds(page: ProjectTranscriptResult) {
  return [...page.transcript.matchAll(/\[assistant; message ([^;]+);/g)].map((match) => match[1]);
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
      title: "Inspection fixture",
      brief: coordinator.task,
      model: "claude-opus-4-6",
    },
    coordinator
  );
  parentTurn = ready(coordinator);
  store.reserveAgent(projectId, "create-child", child);
  childTurn = ready(child);
});
afterEach(() => {
  projects.stopProjects();
  mocks.db?.close();
  fs.rmSync(path.dirname(mocks.databasePath), { recursive: true, force: true });
});

describe("Project tool inspection", () => {
  it("returns authorized local execution references from backend workspace metadata", () => {
    mocks
      .db!.prepare(
        "UPDATE workspaces SET slug='actual-child-checkout',git_branch='deus/integration-target' WHERE id=?"
      )
      .run(child.workspaceId);
    const status = invoke("get_agent_status") as ProjectAgentStatusResult;
    expect(status.agents).toHaveLength(2);
    expect(status.agents.find((agent) => agent.id === child.workspaceId)?.execution).toEqual({
      kind: "local",
      workspacePath: path.join(path.dirname(mocks.databasePath), ".deus", "actual-child-checkout"),
      branch: "deus/integration-target",
    });
    const own = invoke("get_agent_status", {}, childTurn) as ProjectAgentStatusResult;
    expect(own.agents.map((agent) => agent.id)).toEqual([child.workspaceId]);
    expect(own.agents[0].execution).toEqual(
      status.agents.find((agent) => agent.id === child.workspaceId)?.execution
    );
  });

  it("shows tool-only execution, failures and pending work without exposing reasoning", () => {
    message("tool-only", [
      {
        type: "tool",
        toolName: "Bash",
        toolCallId: "failed-call",
        state: {
          status: "failed",
          input: { command: "bun run typecheck" },
          error: "Type check failed: incompatible field",
        },
      },
      {
        type: "tool",
        toolName: "Read",
        toolCallId: "read-call",
        state: { status: "completed", input: { path: "package.json" }, output: "package metadata" },
      },
      {
        type: "tool",
        toolName: "Grep",
        toolCallId: "running-call",
        state: { status: "in_progress", input: { pattern: "dispatch" } },
      },
      {
        type: "tool",
        toolName: "Edit",
        toolCallId: "pending-call",
        state: { status: "pending", partialInput: '{"file":' },
      },
      { type: "reasoning", text: "Private reasoning omitted" },
    ]);
    const page = transcript();
    for (const detail of [
      "Bash",
      "failed",
      "bun run typecheck",
      "Type check failed",
      "Read",
      "completed",
      "package metadata",
      "Grep",
      "in_progress",
      "Edit",
      "pending",
    ])
      expect(page.transcript).toContain(detail);
    expect(page.transcript).not.toContain("Private reasoning omitted");
    expect(page.nextBeforeMessageId).toBeNull();
    expect(page.truncated).toBe(false);
  });

  it("labels messages that have no text or tool snapshots instead of returning empty rows", () => {
    message("empty", [{ type: "reasoning", text: "Omitted" }]);
    expect(transcript().transcript).toContain("No text or tool activity recorded");
  });

  it("continues through older messages without duplicate or missing rows when new messages arrive", () => {
    for (let i = 1; i <= 6; i++) message(`message-${i}`, [{ type: "text", text: `Update ${i}` }]);
    const newest = transcript({ limit: 2 });
    expect(pageIds(newest)).toEqual(["message-5", "message-6"]);
    expect(newest.nextBeforeMessageId).toBe("message-5");
    message("new-arrival", [{ type: "text", text: "New arrival" }]);
    const middle = transcript({ limit: 2, beforeMessageId: newest.nextBeforeMessageId });
    expect(pageIds(middle)).toEqual(["message-3", "message-4"]);
    const oldest = transcript({ limit: 2, beforeMessageId: middle.nextBeforeMessageId });
    expect(pageIds(oldest)).toEqual(["message-1", "message-2"]);
    expect(oldest.nextBeforeMessageId).toBeNull();
    expect(oldest.truncated).toBe(false);
  });

  it("keeps the 48k cap and continuation at whole-message boundaries", () => {
    for (let i = 1; i <= 5; i++) message(`large-${i}`, [{ type: "text", text: "x".repeat(14000) }]);
    const newest = transcript({ limit: 5 });
    expect(newest.transcript.length).toBeLessThanOrEqual(48000);
    expect(newest.transcript).toContain("abbreviated");
    expect(newest.truncated).toBe(true);
    const oldest = transcript({ limit: 5, beforeMessageId: newest.nextBeforeMessageId });
    expect([...pageIds(oldest), ...pageIds(newest)]).toEqual([
      "large-1",
      "large-2",
      "large-3",
      "large-4",
      "large-5",
    ]);
    expect(oldest.nextBeforeMessageId).toBeNull();
  });

  it("bounds tool arguments and output independently and reports abbreviation", () => {
    message("large-tool", [
      {
        type: "tool",
        toolName: "Bash",
        toolCallId: "call",
        state: {
          status: "completed",
          input: { command: "x".repeat(20000) },
          output: "y".repeat(20000),
        },
      },
    ]);
    const page = transcript();
    expect(page.transcript.length).toBeLessThan(4000);
    expect(page.truncated).toBe(true);
    expect(page.nextBeforeMessageId).toBeNull();
  });

  it("rejects foreign and historical cursors and preserves source/target authorization", () => {
    message(
      "parent-message",
      [{ type: "text", text: "Coordinator private direction" }],
      coordinator.sessionId
    );
    expect(() => transcript({ beforeMessageId: "parent-message" })).toThrow(
      "outside this conversation"
    );
    expect(() =>
      invoke(
        "read_agent_transcript",
        { agentId: coordinator.workspaceId, beforeMessageId: "parent-message" },
        childTurn
      )
    ).toThrow("own transcript");
    message("old-child-message");
    mocks
      .db!.prepare("INSERT INTO sessions(id,workspace_id) VALUES('child-successor',?)")
      .run(child.workspaceId);
    mocks
      .db!.prepare(
        "UPDATE workspaces SET current_session_id='child-successor',conversation_generation=conversation_generation+1 WHERE id=?"
      )
      .run(child.workspaceId);
    expect(() => transcript({ beforeMessageId: "old-child-message" })).toThrow(
      "outside this conversation"
    );
    expect(() => invoke("get_agent_status", {}, childTurn)).toThrow("current managed conversation");
    store.settle(parentTurn, { status: "completed" });
    expect(() => transcript()).toThrow("inactive turn");
  });

  it("enforces message limits at the backend boundary", () => {
    for (const limit of [0, 101, 1.5, Number.NaN, "20"])
      expect(() => transcript({ limit })).toThrow("integer between 1 and 100");
    expect(transcript()).toMatchObject({
      transcript: "",
      nextBeforeMessageId: null,
      truncated: false,
    });
  });

  it("does not expose another Project's checkout or transcript", () => {
    const other = { ...coordinator, workspaceId: "other-project", sessionId: "other-session" };
    store.create(
      {
        requestId: "other-create",
        repositoryId: "repo",
        title: "Other Project",
        brief: "Unrelated work",
        model: "claude-opus-4-6",
      },
      other
    );
    for (const operation of ["get_agent_status", "read_agent_transcript"])
      expect(() => invoke(operation, { agentId: other.workspaceId })).toThrow(
        "outside this Project"
      );
  });
});
