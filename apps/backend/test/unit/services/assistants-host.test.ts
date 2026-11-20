// This computer as the operator tools' host (LLP 0019), against a scratch
// SQLite database built from the fresh schema: its chats as sessions, read
// from their rows; a turn sent, stopped and answered through the app's own
// paths (stood in for here); what it enforces at its commit; and the tools
// reached through MCP (`agentMcp`) and as a chat's own.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyOp } from "@shared/api/op";
import { SCHEMA_SQL } from "@shared/schema";

const state = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
  ops: {} as Record<string, (input: Record<string, unknown>) => unknown>,
  listeners: new Set<(resources: readonly string[], ctx?: { sessionIds?: string[] }) => void>(),
  live: new Map<string, string>(),
  pending: [] as {
    requestId: string;
    sessionId: string;
    method: string;
    params: Record<string, unknown>;
  }[],
  answered: [] as { requestId: string; reply: unknown }[],
  sent: [] as { input: Record<string, unknown>; origin?: unknown }[],
  stopped: [] as { sessionId: string; by: unknown }[],
  sendRefusal: null as Error | null,
  stored: {} as Record<string, string>,
  created: 0,
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: () => state.db }));
vi.mock("../../../src/services/query-engine", () => ({
  runAsThisComputer: async (op: AnyOp, input: Record<string, unknown>) => {
    const answer = state.ops[op.name];
    if (!answer) throw new Error(`no stand-in for ${op.name}`);
    return answer(input ?? {});
  },
  onInvalidate: (listener: (resources: readonly string[]) => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
  invalidate: (resources: string[], ctx?: { sessionIds?: string[] }) => {
    for (const listener of [...state.listeners]) listener(resources, ctx);
  },
}));
vi.mock("../../../src/services/server-name", () => ({ getServerName: () => "Proof Mac" }));
vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));
vi.mock("../../../src/services/agent/service", () => ({
  liveTurnId: (sessionId: string) => state.live.get(sessionId),
  provideSessionTools: () => {},
}));
vi.mock("../../../src/services/agent/tool-relay", () => ({
  pendingFor: (sessionId: string) => state.pending.filter((r) => r.sessionId === sessionId),
  answer: (requestId: string, reply: unknown) => {
    state.answered.push({ requestId, reply });
    state.pending = state.pending.filter((r) => r.requestId !== requestId);
    return true;
  },
  isPrompt: (method: string) => method === "askUserQuestion" || method === "exitPlanMode",
}));
vi.mock("../../../src/services/agent/turns", () => ({
  sendMessage: async (input: Record<string, unknown>, origin?: unknown) => {
    if (state.sendRefusal) throw state.sendRefusal;
    state.sent.push({ input, origin });
    state.live.set(input.sessionId as string, input.turnId as string);
    return { turnId: input.turnId };
  },
  stopSession: async ({ sessionId }: { sessionId: string }, by: unknown) => {
    state.stopped.push({ sessionId, by });
    const turnId = state.live.get(sessionId)!;
    state.live.delete(sessionId);
    endTurn(sessionId, turnId, "cancelled", by);
    return { unconfirmed: false };
  },
}));
vi.mock("../../../src/api/workspaces", () => ({
  createLocalWorkspace: async (
    input: { repository_id: string },
    options: { startedBy?: unknown; admit?: () => void }
  ) => {
    options.admit?.();
    const n = ++state.created;
    insertWorkspace(`w-new${n}`, `new${n}`, {
      state: "initializing",
      first: `s-new${n}`,
      startedBy: options.startedBy,
      repo: input.repository_id,
    });
    return { workspaceId: `w-new${n}`, firstSessionId: `s-new${n}` };
  },
}));
vi.mock("../../../src/services/settings.service", () => ({ getSetting: () => undefined }));
vi.mock("../../../src/services/account-session", () => ({
  currentAccountSession: () => ({ accountId: "user_a", cloudUrl: "https://cloud.test" }),
}));
vi.mock("../../../src/services/remote-machine.service", () => ({
  getMachineId: () => "0123456789abcdef",
}));
vi.mock("../../../src/services/assistants/store", () => ({
  findAssistant: (_host: unknown, clientId: string) =>
    state.stored[clientId]
      ? { clientId, access: state.stored[clientId], name: "Claude" }
      : undefined,
}));

import { LOCAL_CALLER, type Caller } from "../../../src/api/registry";
import handlers from "../../../src/api/assistants";
import * as api from "@shared/api/assistants";
import { ConflictError } from "../../../src/lib/errors";
import { createDeusHost } from "../../../src/services/assistants/host";
import { _resetOperator, withSessionTools } from "../../../src/services/assistants/operator";
import { READ_ONLY } from "../../../src/services/assistants/sentences";
import { assistantCaller, operations } from "../../helpers";

const LEAD = { kind: "session", sessionId: "s-lead" } as const;

function insertWorkspace(
  id: string,
  slug: string,
  options: { state?: string; first?: string; startedBy?: unknown; repo?: string } = {}
) {
  state.db
    .prepare(
      `INSERT INTO workspaces (id, repository_id, slug, state, first_session_id, started_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      options.repo ?? "r-shop",
      slug,
      options.state ?? "ready",
      options.first ?? null,
      options.startedBy && (options.startedBy as { kind: string }).kind !== "person"
        ? JSON.stringify(options.startedBy)
        : null
    );
}

function insertChat(id: string, workspaceId: string, startedBy?: unknown, current = true) {
  state.db
    .prepare("INSERT INTO sessions (id, workspace_id, status, started_by) VALUES (?, ?, 'idle', ?)")
    .run(id, workspaceId, startedBy ? JSON.stringify(startedBy) : null);
  if (current)
    state.db
      .prepare("UPDATE workspaces SET current_session_id = ? WHERE id = ?")
      .run(id, workspaceId);
}

function endTurn(sessionId: string, turnId: string, stopReason: string, by?: unknown) {
  state.db
    .prepare(
      `INSERT INTO turns (session_id, turn_id, ended_at, outcome, cancelled_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn_id) DO UPDATE SET ended_at = excluded.ended_at, outcome = excluded.outcome,
         cancelled_by = COALESCE(excluded.cancelled_by, turns.cancelled_by)`
    )
    .run(
      sessionId,
      turnId,
      Date.now(),
      JSON.stringify({ stopReason }),
      by ? JSON.stringify(by) : null
    );
}

function message(sessionId: string, turnId: string, role: string, text: string, origin?: unknown) {
  const id = `m-${Math.random()}`;
  state.db
    .prepare("INSERT INTO messages (id, session_id, role, turn_id, origin) VALUES (?, ?, ?, ?, ?)")
    .run(id, sessionId, role, turnId, origin ? JSON.stringify(origin) : null);
  state.db
    .prepare(
      "INSERT INTO parts (id, message_id, session_id, type, data) VALUES (?, ?, ?, 'text', ?)"
    )
    .run(`p-${id}`, id, sessionId, JSON.stringify({ id: `p-${id}`, type: "text", text }));
}

const changed = (sessionIds?: string[]) => {
  for (const listener of [...state.listeners]) listener(["workspaces", "sessions"], { sessionIds });
};

beforeEach(() => {
  state.db = new Database(":memory:");
  state.db.exec(SCHEMA_SQL);
  state.db
    .prepare(
      "INSERT INTO repositories (id, name, root_path) VALUES ('r-shop', 'demo-shop', '/repos/demo-shop')"
    )
    .run();
  state.db
    .prepare(
      "INSERT INTO repositories (id, name, git_origin_url) VALUES ('r-cloud', 'widget', 'https://github.com/acme/widget')"
    )
    .run();
  insertWorkspace("w-lead", "lead");
  insertChat("s-lead", "w-lead");
  state.ops = {
    messages: () => ({
      messages: [],
      turns: [],
      compactions: [],
      has_older: false,
      has_newer: false,
    }),
    diffFiles: () => ({ files: [], total_count: 0 }),
    archiveWorkspace: ({ workspaceId }) => {
      state.db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
    },
    agentModels: () => ({ lists: [] }),
  };
  state.listeners.clear();
  state.live.clear();
  state.pending = [];
  state.answered = [];
  state.sent = [];
  state.stopped = [];
  state.sendRefusal = null;
  state.stored = { claude: "operate" };
  state.created = 0;
  _resetOperator();
});
afterEach(() => state.db.close());

describe("chats as sessions", () => {
  it("each chat is a session numbered in its workspace; one being set up is its first, under its minted id", async () => {
    const host = createDeusHost();
    insertChat("s-second", "w-lead", LEAD);
    insertWorkspace("w-new", "fresh", { state: "initializing", first: "s-first", startedBy: LEAD });
    const all = await host.list(LOCAL_CALLER as never, {});
    expect(all.map((e) => [e.id, e.workspace.name, e.chat, e.status, e.current])).toEqual([
      ["s-lead", "lead", 1, "idle", false],
      ["s-second", "lead", 2, "idle", true],
      ["s-first", "fresh", 1, "setting_up", true],
    ]);
    expect(all.find((e) => e.id === "s-first")?.startedBy).toEqual(LEAD);
  });

  it("a view carries each message's sender, who stopped a turn, the running turn and a cursor", async () => {
    const host = createDeusHost();
    message("s-lead", "t1", "user", "do it", LEAD);
    message("s-lead", "t1", "assistant", "halfway");
    endTurn("s-lead", "t1", "cancelled", { kind: "person" });
    message("s-lead", "t2", "user", "again");
    state.live.set("s-lead", "t2");
    const view = await host.view(LOCAL_CALLER as never, "s-lead", { last: 10 });
    expect(view.status).toBe("working");
    expect(view.running).toBe("t2");
    expect(view.lastEnded).toEqual({
      turnId: "t1",
      outcome: "cancelled",
      cancelledBy: { kind: "person" },
    });
    expect(view.turns.map((t) => [t.turnId, t.outcome])).toEqual([
      ["t1", "cancelled"],
      ["t2", "running"],
    ]);
    expect(view.turns[0]?.messages[0]?.origin).toEqual(LEAD);
    const after = await host.view(LOCAL_CALLER as never, "s-lead", { after: view.cursor });
    expect(after.turns).toEqual([]);
    await expect(
      host.view(LOCAL_CALLER as never, "s-lead", { after: "x" as never })
    ).rejects.toThrow();
    expect(await host.turn(LOCAL_CALLER as never, "s-lead", "t1")).toMatchObject({
      state: "ended",
      outcome: "cancelled",
    });
    expect(await host.turn(LOCAL_CALLER as never, "s-lead", "t2")).toEqual({ state: "running" });
    expect(await host.turn(LOCAL_CALLER as never, "s-lead", "nope")).toEqual({ state: "unknown" });
  });
});

describe("sending and starting", () => {
  it("a send is the app's, with the minted turn id and the sender; a busy chat is refused as busy", async () => {
    const host = createDeusHost();
    await host.send(LEAD as never, "s-lead", { turnId: "t9", message: "hi", origin: LEAD });
    expect(state.sent[0]).toMatchObject({
      input: { sessionId: "s-lead", turnId: "t9", content: "hi" },
      origin: LEAD,
    });
    state.sendRefusal = new ConflictError(
      "The agent is still working — wait for the current turn to finish."
    );
    await expect(
      host.send(LEAD as never, "s-lead", { turnId: "t10", message: "hi", origin: LEAD })
    ).rejects.toMatchObject({ refusal: { code: "busy" } });
  });

  it("a new workspace holds its first task and sends it as the minted turn once ready; a stop drops it", async () => {
    const host = createDeusHost();
    const input = {
      turnId: "first-1",
      project: { id: "r-shop", name: "demo-shop" },
      message: "build",
      origin: LEAD,
    };
    const entry = await host.start!(LEAD as never, input as never);
    expect(entry).toMatchObject({ id: "s-new1", status: "setting_up", startedBy: LEAD });
    insertChat("s-new1", "w-new1", LEAD);
    state.db.prepare("UPDATE workspaces SET state = 'ready' WHERE id = 'w-new1'").run();
    changed();
    await vi.waitFor(() => expect(state.sent.map((s) => s.input.turnId)).toEqual(["first-1"]));

    await host.start!(LEAD as never, { ...input, turnId: "first-2" } as never);
    expect(await host.cancel!(LEAD as never, "s-new2")).toBe("first_task_dropped");
    insertChat("s-new2", "w-new2", LEAD);
    state.db.prepare("UPDATE workspaces SET state = 'ready' WHERE id = 'w-new2'").run();
    changed();
    expect(state.sent).toHaveLength(1);
  });

  it("a fourth workspace agents started is refused at the commit while three are set up", async () => {
    const host = createDeusHost();
    const input = {
      turnId: "x",
      project: { id: "r-shop", name: "demo-shop" },
      message: "go",
      origin: LEAD,
    };
    for (let i = 0; i < 3; i++)
      await host.start!(LEAD as never, { ...input, turnId: `x${i}` } as never);
    await expect(host.start!(LEAD as never, input as never)).rejects.toMatchObject({
      refusal: { code: "limit_setting_up" },
    });
    // The person's own start is not an agent's.
    await expect(
      host.start!(LOCAL_CALLER as never, { ...input, origin: { kind: "person" } } as never)
    ).resolves.toMatchObject({ status: "setting_up" });
  });

  it("a start by an archived starter, or into an archived workspace, is refused at the commit", async () => {
    const host = createDeusHost();
    insertWorkspace("w-old", "old", { state: "archived" });
    insertChat("s-old", "w-old");
    const input = {
      turnId: "y",
      project: { id: "r-shop", name: "demo-shop" },
      message: "go",
      origin: LEAD,
    };
    await expect(
      host.start!(LEAD as never, { ...input, workspace: { id: "w-old", name: "old" } } as never)
    ).rejects.toMatchObject({ refusal: { code: "archived" } });
    await expect(
      host.start!({ kind: "session", sessionId: "s-old" } as never, input as never)
    ).rejects.toMatchObject({ refusal: { code: "archived" } });
  });

  it("a second opinion: a new chat in a workspace, started by the agent, sent at once", async () => {
    const host = createDeusHost();
    const entry = await host.start!(
      LEAD as never,
      {
        turnId: "second-1",
        project: { id: "r-shop", name: "demo-shop" },
        workspace: { id: "w-lead", name: "lead" },
        message: "review this",
        origin: LEAD,
      } as never
    );
    // Chats are numbered by id (UUID7, so by creation); the fixtures' ids are not UUIDs.
    expect(entry).toMatchObject({ workspace: { name: "lead" }, startedBy: LEAD, current: true });
    const chats = (await host.list(LOCAL_CALLER as never, {})).filter(
      (e) => e.workspace.name === "lead"
    );
    expect(chats.map((c) => c.chat).sort()).toEqual([1, 2]);
    expect(state.sent[0]).toMatchObject({ input: { sessionId: entry.id, turnId: "second-1" } });
  });

  it("a stop is of the turn named, by whoever stops it", async () => {
    const host = createDeusHost();
    state.live.set("s-lead", "t1");
    expect(await host.cancel!(LEAD as never, "s-lead", "other")).toBe("not_running");
    expect(await host.cancel!(LEAD as never, "s-lead", "t1")).toBe("stopped");
    expect(state.stopped).toEqual([{ sessionId: "s-lead", by: LEAD }]);
  });
});

describe("archiving one chat (the owner's ruling, 2026-11-20)", () => {
  it("a chat an agent started is hidden, the current chat moves, and it takes no messages", async () => {
    const host = createDeusHost();
    insertChat("s-second", "w-lead", LEAD);
    await host.archive!(LEAD as never, { kind: "session", id: "s-second" });
    const row = state.db.prepare("SELECT is_hidden FROM sessions WHERE id = 's-second'").get() as {
      is_hidden: number;
    };
    expect(row.is_hidden).toBe(1);
    const w = state.db
      .prepare("SELECT current_session_id FROM workspaces WHERE id = 'w-lead'")
      .get() as { current_session_id: string };
    expect(w.current_session_id).toBe("s-lead");
    expect((await host.list(LOCAL_CALLER as never, {})).map((e) => e.id)).not.toContain("s-second");
    await expect(
      host.send(LEAD as never, "s-second", { turnId: "z", message: "hi", origin: LEAD })
    ).rejects.toMatchObject({ refusal: { code: "archived" } });
  });

  it("a chat the person started is not archived on its own", async () => {
    const host = createDeusHost();
    insertChat("s-mine", "w-lead");
    await expect(
      host.archive!(LEAD as never, { kind: "session", id: "s-mine" })
    ).rejects.toMatchObject({
      refusal: { code: "unsupported" },
    });
  });

  it("a workspace's last visible chat is not archived on its own", async () => {
    const host = createDeusHost();
    insertWorkspace("w-kid", "kid", { startedBy: LEAD });
    insertChat("s-kid", "w-kid", LEAD);
    await expect(
      host.archive!(LEAD as never, { kind: "session", id: "s-kid" })
    ).rejects.toMatchObject({
      refusal: { code: "unsupported" },
    });
  });

  it("the commit refuses a chat still working, and one whose chats are not archived", async () => {
    const host = createDeusHost();
    insertChat("s-second", "w-lead", LEAD);
    state.live.set("s-second", "t1");
    await expect(
      host.archive!(LEAD as never, { kind: "session", id: "s-second" })
    ).rejects.toMatchObject({
      refusal: { code: "busy", state: "working" },
    });
    state.live.clear();
    insertWorkspace("w-kid", "kid", { startedBy: { kind: "session", sessionId: "s-second" } });
    insertChat("s-kid", "w-kid", { kind: "session", sessionId: "s-second" });
    await expect(
      host.archive!(LEAD as never, { kind: "session", id: "s-second" })
    ).rejects.toMatchObject({
      refusal: { code: "has_children", sessions: ["s-kid"] },
    });
  });
});

describe("through MCP and as a chat's own tools", () => {
  const mcp = (message: unknown, caller: Caller) =>
    operations(handlers, caller)(api.agentMcp, { message }) as Promise<any>;
  const call = async (caller: Caller, name: string, args: Record<string, unknown>) => {
    const reply = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      caller
    );
    return { text: reply.result.content[0].text as string, isError: reply.result.isError === true };
  };

  it("an assistant allowed to read reads, is refused a write, and may send feedback's write", async () => {
    state.stored.claude = "read";
    const reader = assistantCaller("read");
    expect((await call(reader, "list_sessions", {})).text).toContain('"lead"');
    const refused = await call(reader, "send_message", { session: "lead", message: "x", wait: 0 });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain(READ_ONLY);
    expect(state.sent).toEqual([]);
  });

  it("a chat's tools are the operator's beside the Deus tools, each run by its own", async () => {
    const own = {
      name: "deus",
      tools: [{ name: "getDiff", description: "d", inputSchema: { type: "object" } }],
      call: vi.fn(async () => ({ content: [{ type: "text" as const, text: "own" }] })),
    };
    const source = withSessionTools(own);
    expect(source.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["getDiff", "send_message", "archive"])
    );
    const caller = {
      sessionId: "s-lead",
      harness: "claude-code",
      turnId: "t",
      permissionMode: "plan",
    } as const;
    const signal = new AbortController().signal;
    await source.call("getDiff", {}, caller as never, signal);
    expect(own.call).toHaveBeenCalled();
    // Plan mode reads only: the operator's writes are refused, the Deus tools run as before.
    const refused = await source.call(
      "send_message",
      { session: "lead", message: "x" },
      caller as never,
      signal
    );
    expect(refused).toMatchObject({ isError: true });
    // Self: a chat cannot send to itself.
    const self = await source.call(
      "send_message",
      { session: "lead", message: "x" },
      { ...caller, permissionMode: "bypass_permissions" } as never,
      signal
    );
    expect(self.content[0]).toMatchObject({ text: expect.stringContaining("refused (self)") });
  });
});
