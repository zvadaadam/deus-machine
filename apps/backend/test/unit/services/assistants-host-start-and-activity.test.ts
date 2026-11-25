import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartInput } from "@zvada/agent-server/operator";
import { SCHEMA_SQL } from "@shared/schema";
import { LOCAL_CALLER, Registry } from "../../../src/api/registry";
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
  serveOperations(new Registry([]));
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
