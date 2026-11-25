import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperator, type StartInput } from "@zvada/agent-server/operator";
import type { AgentAuthAnswer } from "@shared/agent-auth";
import { agentAuth } from "@shared/api/settings";
import { SCHEMA_SQL } from "@shared/schema";
import { handle, LOCAL_CALLER, Registry } from "../../../src/api/registry";
import { ChatBusyError } from "../../../src/lib/errors";
import * as turns from "../../../src/services/agent/turns";
import { createDeusHost } from "../../../src/services/assistants/host";
import { invalidate, serveOperations } from "../../../src/services/query-engine";

vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db, DB_PATH: ":memory:" }));
vi.mock("../../../src/services/workspace-checkout", () => ({
  pickWorkspaceName: async () => ({ slug: "new", branchName: "lab/new" }),
  initializeWorkspace: async () => {},
}));

let db: Database.Database;
const readAuth = vi.hoisted(() => vi.fn<() => Promise<AgentAuthAnswer>>());
const caller = { kind: "external", id: "window", speaksAs: "person", auth: LOCAL_CALLER } as const;
const first: StartInput = {
  turnId: "first",
  project: { id: "r", name: "Project" },
  message: "Go",
  origin: { kind: "person" },
};
const workspace = { id: "w", name: "work" };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO repositories (id, name, root_path) VALUES ('r', 'Project', '/repo');
    INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w', 'r', 'work', 'ready');
  `);
  readAuth.mockReset().mockResolvedValue({ clis: [], auth: [], logins: [] });
  serveOperations(new Registry([handle(agentAuth, readAuth)]));
});

describe("starting on a local agent", () => {
  const harness = "claude-code";
  const signedOut: AgentAuthAnswer = {
    clis: [{ harness, state: "ready" }],
    auth: [{ harness, state: "signed_out", methods: [] }],
    logins: [],
  };

  it.each([false, true])(
    "refuses a signed-out agent before creating a workspace or chat (existing: %s)",
    async (existing) => {
      db.exec("INSERT INTO sessions (id, workspace_id) VALUES ('original', 'w')");
      readAuth.mockResolvedValue(signedOut);
      const send = vi.spyOn(turns, "sendMessage");
      const operator = createOperator(createDeusHost());
      await expect(
        operator.call(
          "start_session",
          {
            project: first.project.name,
            ...(existing && { workspace: workspace.name }),
            agent: "Claude",
            message: first.message,
            wait: 0,
          },
          caller
        )
      ).rejects.toMatchObject({
        code: "unsupported",
        message: expect.stringMatching(
          /Claude Code is signed out on this computer\..*Settings → AI Providers\..*Nothing was started.*list_models/
        ),
      });
      expect(db.prepare("SELECT id FROM workspaces").all()).toEqual([{ id: "w" }]);
      expect(db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "original" }]);
      expect(send).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["the CLI is missing", async () => ({ ...signedOut, clis: [{ harness, state: "missing" }] })],
    ["the login is unknown", async () => ({ ...signedOut, auth: [] })],
    ["the read reports failure", async () => ({ ...signedOut, error: "Engine disconnected" })],
    ["the read rejects", () => Promise.reject(new Error("Connection lost"))],
    ["the read is still pending", () => new Promise<AgentAuthAnswer>(() => {})],
  ] as const)("admits the first task when %s", async (_, read) => {
    readAuth.mockImplementation(read);
    const send = vi.spyOn(turns, "sendMessage").mockResolvedValue({ turnId: first.turnId });
    const host = createDeusHost();
    const entry = await host.start!(caller, { ...first, workspace, harness });
    await host.list(caller, {});
    expect(entry.harness).toBe(harness);
    expect(send).toHaveBeenCalledOnce();
    expect(readAuth).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function failedTurn(sessionId: string, turnId: string) {
  db.prepare("INSERT INTO turns (session_id, turn_id, ended_at, outcome) VALUES (?, ?, ?, ?)").run(
    sessionId,
    turnId,
    Date.now(),
    JSON.stringify({ stopReason: "error" })
  );
  db.prepare(
    "UPDATE sessions SET status = 'error', error_message = 'Engine quit' WHERE id = ?"
  ).run(sessionId);
}

describe("a first task that cannot be delivered", () => {
  it("keeps a competing turn's error even when it ended without a message", async () => {
    vi.spyOn(turns, "sendMessage").mockImplementationOnce(async ({ sessionId }) => {
      failedTurn(sessionId, "other");
      throw new ChatBusyError("Another turn won admission.");
    });
    const entry = await createDeusHost().start!(caller, { ...first, workspace });
    expect(entry).toMatchObject({ status: "error", error: "Engine quit" });
  });

  it("keeps another turn working in app setup before it has a row", async () => {
    vi.spyOn(turns, "sendMessage").mockImplementationOnce(async ({ sessionId }) => {
      db.prepare("UPDATE sessions SET status = 'working' WHERE id = ?").run(sessionId);
      throw new ChatBusyError("Another turn is starting.");
    });
    const entry = await createDeusHost().start!(caller, { ...first, workspace });
    expect(entry.status).toBe("working");
  });

  it.each([false, true])(
    "records the refusal with the first task's own row present: %s",
    async (own) => {
      vi.spyOn(turns, "sendMessage").mockImplementationOnce(async ({ sessionId }) => {
        if (own) failedTurn(sessionId, first.turnId);
        throw new ChatBusyError("Start was refused.");
      });
      const entry = await createDeusHost().start!(caller, { ...first, workspace });
      expect(entry).toMatchObject({
        status: "error",
        error: expect.stringContaining("Its first task could not be delivered. Start was refused."),
      });
    }
  );

  it.each([false, true])(
    "setup expires after 30 minutes with a competing turn present: %s",
    async (other) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const host = createDeusHost();
      const entry = await host.start!(caller, first);
      vi.setSystemTime(Date.now() + 31 * 60_000);
      db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)").run(
        entry.id,
        entry.workspace.id
      );
      db.prepare("UPDATE workspaces SET state = 'ready', current_session_id = ? WHERE id = ?").run(
        entry.id,
        entry.workspace.id
      );
      if (other) failedTurn(entry.id, "other");
      const send = vi.spyOn(turns, "sendMessage");
      invalidate(["workspaces"]);
      expect((await host.list(caller, {})).find((e) => e.id === entry.id)?.error).toBe(
        other
          ? "Engine quit"
          : "Its first task could not be delivered. Setup took longer than 30 minutes."
      );
      expect(send).not.toHaveBeenCalled();
    }
  );
});
