// What the agent service does as the engine starts: settle the local chats a
// previous process left mid-turn, and show a client that starts following a
// chat what its agent still waits on.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";

const state = vi.hoisted(() => ({
  db: null as unknown,
  open: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: () => state.db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: state.invalidate }));
vi.mock("../../../src/services/agent/client", () => ({ AgentLink: { open: state.open } }));

import { toolRequests } from "@shared/api/sessions";
import * as agentService from "../../../src/services/agent/service";
import { clearAll, relay } from "../../../src/services/agent/tool-relay";
import { subscribe } from "../../../src/services/streams";
import { addConnection, closeAll } from "../../../src/services/ws.service";

let db: Database.Database;

function status(sessionId: string) {
  return db.prepare("SELECT status, error_message FROM sessions WHERE id = ?").get(sessionId) as {
    status: string;
    error_message: string | null;
  };
}

beforeEach(async () => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO repositories (id, name, root_path) VALUES ('r', 'repo', '/tmp/repo');
    INSERT INTO workspaces (id, repository_id, slug) VALUES ('local', 'r', 'voyager');
    INSERT INTO workspaces (id, repository_id, slug, kind) VALUES ('cloud', 'r', 'nimbus', 'cloud');
    INSERT INTO sessions (id, workspace_id, status) VALUES
      ('working', 'local', 'working'),
      ('asking', 'local', 'needs_response'),
      ('planning', 'local', 'needs_plan_response'),
      ('idle', 'local', 'idle'),
      ('failed', 'local', 'error'),
      ('remote', 'cloud', 'working');
  `);
  state.db = db;
  state.open.mockResolvedValue({
    getAgents: () => [],
    isConnected: () => true,
    engine: { onAuthUpdated: () => () => {}, onCliProgress: () => () => {} },
    close: vi.fn().mockResolvedValue(undefined),
  });
  await agentService.init();
});

afterEach(async () => {
  await agentService.shutdown();
  clearAll();
  closeAll();
  db.close();
  vi.clearAllMocks();
});

describe("starting the engine", () => {
  it("settles local chats left working or waiting, and leaves cloud chats to the platform", () => {
    for (const id of ["working", "asking", "planning"]) {
      expect(status(id)).toEqual({
        status: "error",
        error_message: expect.stringContaining("did not finish"),
      });
    }
    expect(status("idle").status).toBe("idle");
    expect(status("failed")).toEqual({ status: "error", error_message: null });
    // Its turn runs in a sandbox and may really still be running.
    expect(status("remote").status).toBe("working");
    const [resources, ctx] = state.invalidate.mock.calls[0]!;
    expect(resources).toEqual(["workspaces", "sessions", "session", "stats"]);
    expect([...ctx.sessionIds].sort()).toEqual(["asking", "planning", "working"]);
    // Before the engine could admit a turn.
    expect(state.invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      state.open.mock.invocationCallOrder[0]!
    );
  });

  it("shows a client that starts following a chat what its agent still waits on", () => {
    const sent: Array<Record<string, unknown>> = [];
    const window = addConnection(
      { send: (data) => sent.push(JSON.parse(String(data))), close() {} },
      null
    );
    const question = relay({
      requestId: "q1",
      sessionId: "asking",
      method: "askUserQuestion",
      params: { sessionId: "asking", questions: [{ question: "Ship it?", options: [] }] },
      timeoutMs: 60_000,
    });
    question.catch(() => {});
    // One the clients answer by themselves (a diff) is not sent again: it would run twice.
    const diff = relay({
      requestId: "d1",
      sessionId: "asking",
      method: "getDiff",
      params: { sessionId: "asking" },
      timeoutMs: 60_000,
    });
    diff.catch(() => {});

    subscribe(window, "s1", toolRequests, { sessionId: "asking" });
    expect(sent).toEqual([
      {
        type: "q:event",
        id: "s1",
        event: "toolRequests",
        data: {
          type: "request",
          request: expect.objectContaining({ requestId: "q1", method: "askUserQuestion" }),
        },
      },
      { type: "q:subscribed", id: "s1" },
    ]);

    // Another chat's subscriber is shown nothing of it.
    sent.length = 0;
    subscribe(window, "s2", toolRequests, { sessionId: "working" });
    expect(sent).toEqual([{ type: "q:subscribed", id: "s2" }]);

    // A reloaded window follows every chat at once: it is shown every chat's.
    const plan = relay({
      requestId: "p1",
      sessionId: "planning",
      method: "exitPlanMode",
      params: { sessionId: "planning", toolInput: {} },
      timeoutMs: 60_000,
    });
    plan.catch(() => {});
    sent.length = 0;
    subscribe(window, "s3", toolRequests, {});
    expect(
      sent.map((frame) => (frame.data as { request?: { requestId: string } })?.request?.requestId)
    ).toEqual(["q1", "p1", undefined]);
  });
});
