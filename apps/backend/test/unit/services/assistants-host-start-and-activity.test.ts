import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { AgentServerClient } from "@zvada/agent-server/client";
import { createOperator, type StartInput } from "@zvada/agent-server/operator";
import type { AgentAuthAnswer } from "@shared/agent-auth";
import { agentAuth } from "@shared/api/settings";
import type { AnyLifecycleEvent } from "@shared/protocol-types";
import { SCHEMA_SQL } from "@shared/schema";
import { handle, LOCAL_CALLER, Registry } from "../../../src/api/registry";
import { ChatBusyError } from "../../../src/lib/errors";
import type { AgentLinkOptions } from "../../../src/services/agent/client";
import type { LocalAgents } from "../../../src/services/agent/local-agents";
import * as agent from "../../../src/services/agent/service";
import * as turns from "../../../src/services/agent/turns";
import { createDeusHost } from "../../../src/services/assistants/host";
import { invalidate, serveOperations } from "../../../src/services/query-engine";

vi.mock("node:timers/promises", { spy: true });
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db, DB_PATH: ":memory:" }));
const openLink = vi.hoisted(() => vi.fn<(options: AgentLinkOptions) => unknown>());
vi.mock("../../../src/services/agent/client", () => ({ AgentLink: { open: openLink } }));
vi.mock("../../../src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession: vi.fn(),
}));
vi.mock("../../../src/services/workspace-checkout", () => ({
  pickWorkspaceName: async () => ({ slug: "new", branchName: "lab/new" }),
  initializeWorkspace: async () => {},
}));

let db: Database.Database;
const listClis = vi.fn<AgentServerClient["listClis"]>();
const authStatus = vi.fn<AgentServerClient["authStatus"]>();
let readAuth: MockInstance<LocalAgents["status"]>;
const caller = { kind: "external", id: "window", speaksAs: "person", auth: LOCAL_CALLER } as const;
const first: StartInput = {
  turnId: "first",
  project: { id: "r", name: "Project" },
  message: "Go",
  origin: { kind: "person" },
};
const workspace = { id: "w", name: "work" };

beforeEach(async () => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO repositories (id, name, root_path) VALUES ('r', 'Project', '/repo');
    INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w', 'r', 'work', 'ready');
  `);
  listClis.mockReset().mockResolvedValue([]);
  authStatus.mockReset().mockResolvedValue([]);
  openLink.mockReset().mockResolvedValue({
    getAgents: () => [],
    isConnected: () => true,
    startTurn: async () => {},
    engine: { onAuthUpdated: () => () => {}, onCliProgress: () => () => {}, listClis, authStatus },
    close: vi.fn(),
  });
  await agent.init();
  const local = agent.getLocalAgents();
  readAuth = vi.spyOn(local, "status");
  serveOperations(new Registry([handle(agentAuth, () => local.status())]));
});

describe("starting on a local agent", () => {
  const harness = "claude-code";
  const signedOut: AgentAuthAnswer = {
    clis: [{ harness, state: "ready" }],
    auth: [{ harness, state: "signed_out", methods: [] }],
    logins: [],
  };

  function useReadinessClock() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The promise timer imported by the host otherwise keeps real time.
    vi.mocked(delay).mockImplementationOnce(
      (ms, value) => new Promise((resolve) => setTimeout(resolve, ms, value))
    );
  }

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

  it("refuses a fast Codex sign-out while Claude's login is still pending", async () => {
    const chosen = "codex-app-server";
    const claude = Promise.withResolvers<AgentAuthAnswer["auth"]>();
    listClis.mockResolvedValue([{ harness: chosen, state: "ready" }]);
    authStatus.mockImplementation(({ harnesses } = {}) =>
      harnesses?.includes("claude-code")
        ? claude.promise
        : Promise.resolve([{ harness: chosen, state: "signed_out", methods: [] }])
    );
    const all = agent.getLocalAgents().status();
    try {
      const send = vi.spyOn(turns, "sendMessage").mockResolvedValue({ turnId: first.turnId });
      const start = createDeusHost().start!(caller, { ...first, workspace, harness: chosen });
      await expect(start).rejects.toThrow(/Codex is signed out/);
      expect(listClis).toHaveBeenLastCalledWith([chosen]);
      expect(authStatus).toHaveBeenLastCalledWith({ harnesses: [chosen] });
      expect(send).not.toHaveBeenCalled();
    } finally {
      claude.resolve([]);
      await all;
    }
  });

  it("refuses a sign-out that takes two seconds to read", async () => {
    useReadinessClock();
    const login = Promise.withResolvers<AgentAuthAnswer>();
    readAuth.mockReturnValue(login.promise);
    const send = vi.spyOn(turns, "sendMessage").mockResolvedValue({ turnId: first.turnId });
    const start = createDeusHost().start!(caller, { ...first, workspace, harness });
    await vi.advanceTimersByTimeAsync(2_000);
    login.resolve(signedOut);
    await expect(start).rejects.toThrow(/Claude Code is signed out/);
    expect(send).not.toHaveBeenCalled();
  });

  it("starts after three seconds when the chosen agent's login is still pending", async () => {
    useReadinessClock();
    const login = Promise.withResolvers<AgentAuthAnswer>();
    readAuth.mockReturnValue(login.promise);
    const send = vi.spyOn(turns, "sendMessage").mockResolvedValue({ turnId: first.turnId });
    const start = createDeusHost().start!(caller, { ...first, workspace, harness });
    await vi.advanceTimersByTimeAsync(2_999);
    expect.soft(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect.soft(send).toHaveBeenCalledOnce();
    login.resolve(signedOut);
    await expect(start).resolves.toMatchObject({ harness });
  });

  it.each([
    ["the CLI is missing", async () => ({ ...signedOut, clis: [{ harness, state: "missing" }] })],
    ["the login is unknown", async () => ({ ...signedOut, auth: [] })],
    ["the read reports failure", async () => ({ ...signedOut, error: "Engine disconnected" })],
    ["the read rejects", () => Promise.reject(new Error("Connection lost"))],
  ] as const)("admits the first task when %s", async (_, read) => {
    readAuth.mockImplementation(read);
    const send = vi.spyOn(turns, "sendMessage").mockResolvedValue({ turnId: first.turnId });
    const host = createDeusHost();
    const entry = await host.start!(caller, { ...first, workspace, harness });
    await host.list(caller, {});
    expect(entry.harness).toBe(harness);
    expect(send).toHaveBeenCalledOnce();
    expect(readAuth).toHaveBeenCalledExactlyOnceWith(harness);
  });
});

afterEach(async () => {
  await agent.shutdown();
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

describe("a chat's last activity", () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const prompt = now - 12 * 60_000;
  let seq: number;
  let host: ReturnType<typeof createDeusHost>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    seq = 0;
    host = createDeusHost();
  });

  function prompted(id: string) {
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, title, status, last_user_message_at) VALUES (?, 'w', ?, 'working', ?)"
    ).run(id, id, new Date(prompt).toISOString());
  }

  function emit(event: AnyLifecycleEvent & { sessionId: string }) {
    const envelope =
      event.type === "message.part.delta" ? { seq, live: true as const } : { seq: ++seq };
    openLink.mock.calls[0]![0].onEnvelope({ sessionId: event.sessionId, event, ...envelope });
  }

  const activity = async (id: string) =>
    (await host.list(caller, {})).find((entry) => entry.id === id)?.lastActivityAt;

  it("lists equally old prompts as 12m ago for a silent turn and 5s ago for one starting a tool", async () => {
    vi.setSystemTime(prompt);
    db.exec("INSERT INTO sessions (id, workspace_id, title) VALUES ('silent', 'w', 'silent')");
    await turns.sendMessage({
      sessionId: "silent",
      turnId: "quiet",
      content: "Work quietly",
      agentHarness: "claude-code",
      model: "opus",
    });
    vi.setSystemTime(now);
    prompted("busy");
    const sessionId = "busy";
    const turn = { sessionId, turnId: "b" };
    const timestamp = now - 5_000;
    emit({ ...turn, type: "turn.started", timestamp: prompt });
    emit({
      ...turn,
      type: "message.part",
      messageId: "reply",
      outputIndex: 1,
      partIndex: 0,
      timestamp,
      part: {
        type: "tool",
        id: "tool",
        messageId: "reply",
        sessionId,
        toolName: "Bash",
        toolCallId: "build",
        state: { status: "in_progress", input: {}, time: { start: timestamp } },
      },
    });
    expect(agent.liveTurnId("silent")).toBe("quiet");
    expect(agent.lastOutputAt("silent")).toBeUndefined();
    const list = await createOperator(host).call("list_sessions", {}, caller);
    expect(list).toMatch(/working[^\n]*"silent"[^\n]*12m ago/);
    expect(list).toMatch(/working[^\n]*"busy"[^\n]*5s ago/);
    expect(readAuth).not.toHaveBeenCalled();
  });

  it("dates streaming output by its delta and ignores a steer's whole user echo and a late event for an older turn", async () => {
    prompted("busy");
    const turn = { sessionId: "busy", turnId: "b" };
    const message = { ...turn, messageId: "reply", outputIndex: 1, partIndex: 0 };
    emit({ ...turn, type: "turn.started", timestamp: prompt });
    emit({
      ...message,
      type: "message.part",
      timestamp: now - 30_000,
      part: {
        type: "text",
        id: "p",
        text: "",
        state: "streaming",
        sessionId: "busy",
        messageId: "reply",
      },
    });
    emit({
      ...message,
      type: "message.part.delta",
      partId: "p",
      delta: { type: "text", text: "still working" },
      timestamp: now - 5_000,
    });
    const echo = { ...turn, messageId: "steer", outputIndex: 2 };
    emit({ ...echo, type: "message.started", role: "user", steerId: "s", timestamp: now - 3_000 });
    emit({
      ...echo,
      type: "message.part",
      partIndex: 0,
      timestamp: now - 2_000,
      part: {
        type: "text",
        id: "e",
        text: "Also this",
        state: "done",
        sessionId: "busy",
        messageId: "steer",
      },
    });
    emit({ ...echo, type: "message.ended", timestamp: now - 1_000 });
    emit({ ...turn, turnId: "older", type: "message.ended", messageId: "old", timestamp: now });
    expect(await activity("busy")).toBe(now - 5_000);
  });

  it("uses the timestamp on a new kind of event from the live turn", async () => {
    prompted("new-event");
    const turn = { sessionId: "new-event", turnId: "t" };
    emit({ ...turn, type: "turn.started", timestamp: prompt });
    emit({
      sessionId: turn.sessionId,
      type: "future.event",
      raw: { ...turn, timestamp: now - 3_000 },
    });
    expect(await activity("new-event")).toBe(now - 3_000);
  });

  it("dates an idle chat by its latest prompt or turn end and a pending admission by its send", async () => {
    prompted("changing");
    const turn = { sessionId: "changing", turnId: "old" };
    emit({ ...turn, type: "turn.started", timestamp: prompt });
    emit({ ...turn, type: "turn.ended", stopReason: "end_turn", timestamp: now - 60_000 });
    expect.soft(await activity("changing")).toBe(now - 60_000);
    db.prepare("UPDATE sessions SET last_user_message_at = ? WHERE id = ?").run(
      new Date(now - 30_000).toISOString(),
      "changing"
    );
    expect.soft(await activity("changing")).toBe(now - 30_000);

    const apps = Promise.withResolvers<void>();
    vi.spyOn(agent, "startTurn").mockReturnValueOnce(apps.promise);
    const sending = turns.sendMessage({
      sessionId: "changing",
      turnId: "new",
      content: "Again",
      agentHarness: "claude-code",
      model: "opus",
    });
    try {
      vi.setSystemTime(now + 10_000);
      expect.soft(await activity("changing")).toBe(now);
      // A different turn can still be live while this send is in setup.
      vi.spyOn(agent, "liveTurnId").mockReturnValue("other");
      expect(await activity("changing")).toBe(now - 30_000);
    } finally {
      apps.resolve();
      await sending;
    }
  });
});
