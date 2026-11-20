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
  naming: null as null | (() => Promise<void>),
  feedback: [] as unknown[],
  sending: null as null | Promise<void>,
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
    if (state.sending) await state.sending;
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
// The app's own workspace creation runs; only its name lookup (git) and its
// background start are stood in for, the lookup awaitable so a test can act
// while a creation waits on it.
vi.mock("../../../src/services/workspace-init.service", () => ({
  pickWorkspaceName: async () => {
    await state.naming?.();
    const n = ++state.created;
    return { slug: `new${n}`, branchName: `lab/new${n}` };
  },
  initializeWorkspace: async () => {},
  deleteFailedWorkspace: () => {},
  retryWorkspaceInit: async () => {},
}));
vi.mock("../../../src/services/settings.service", () => ({ getSetting: () => undefined }));
vi.mock("../../../src/services/assistants/feedback", () => ({
  FEEDBACK_CATEGORIES: ["tool", "mcp", "ux", "docs", "model", "other"],
  FeedbackNotSent: class extends Error {},
  sendFeedback: async (report: unknown) => {
    state.feedback.push(report);
    return { threadId: "thread-1" };
  },
}));
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
import { ChatBusyError } from "../../../src/lib/errors";
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

/** Setup ends as the pipeline ends it: the first chat opened under its minted id, the workspace ready. */
function ready(entry: { id: string; workspace: { id: string } }) {
  const w = state.db
    .prepare("SELECT started_by FROM workspaces WHERE id = ?")
    .get(entry.workspace.id) as { started_by: string | null };
  state.db
    .prepare("INSERT INTO sessions (id, workspace_id, status, started_by) VALUES (?, ?, 'idle', ?)")
    .run(entry.id, entry.workspace.id, w.started_by);
  state.db
    .prepare("UPDATE workspaces SET state = 'ready', current_session_id = ? WHERE id = ?")
    .run(entry.id, entry.workspace.id);
  changed();
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
  state.naming = null;
  state.feedback = [];
  state.sending = null;
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
    // The turn still running is read again, whole; the one that ended is not.
    const after = await host.view(LOCAL_CALLER as never, "s-lead", { after: view.cursor });
    expect(after.turns.map((t) => t.turnId)).toEqual(["t2"]);
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
    state.sendRefusal = new ChatBusyError(
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
    expect(entry).toMatchObject({ status: "setting_up", startedBy: LEAD });
    ready(entry);
    await vi.waitFor(() => expect(state.sent.map((s) => s.input.turnId)).toEqual(["first-1"]));

    const second = await host.start!(LEAD as never, { ...input, turnId: "first-2" } as never);
    expect(await host.cancel!(LEAD as never, second.id)).toBe("first_task_dropped");
    ready(second);
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

const assistantWho = (access = "operate") =>
  ({
    kind: "external",
    id: "assistant:claude",
    speaksAs: "assistant",
    name: "Claude",
    auth: assistantCaller(access as never),
  }) as never;
const startInput = (extra: Record<string, unknown> = {}) =>
  ({
    turnId: "first-x",
    project: { id: "r-shop", name: "demo-shop" },
    message: "go",
    origin: LEAD,
    ...extra,
  }) as never;
const workspaceCount = () =>
  (state.db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n;

describe("each commit re-reads what it depends on, with no await before its write (H2 to H5)", () => {
  it("H2: access withdrawn while a new workspace's name is chosen: nothing is inserted", async () => {
    const host = createDeusHost();
    const before = workspaceCount();
    let named = false;
    state.naming = async () => {
      named = true;
      state.stored.claude = "read";
    };
    await expect(
      host.start!(
        assistantWho(),
        startInput({ origin: { kind: "assistant", id: "claude", name: "Claude" } })
      )
    ).rejects.toMatchObject({ code: "access", message: expect.stringContaining(READ_ONLY) });
    expect(named).toBe(true);
    expect(workspaceCount()).toBe(before);
  });

  it("H2: access withdrawn during setup: the held task writes no title and is not sent; the chat says why", async () => {
    const host = createDeusHost();
    const entry = await host.start!(
      assistantWho(),
      startInput({
        title: "Secret plan",
        origin: { kind: "assistant", id: "claude", name: "Claude" },
      })
    );
    state.stored.claude = "read";
    ready(entry);
    await vi.waitFor(() => {
      const row = state.db
        .prepare("SELECT title, status, error_message FROM sessions WHERE id = ?")
        .get(entry.id) as { title: string | null; status: string; error_message: string };
      expect(row.title).toBeNull();
      expect(row.status).toBe("error");
      expect(row.error_message).toMatch(/^Its first task could not be delivered\./);
    });
    expect(state.sent).toEqual([]);
    await vi.waitFor(async () => {
      const listed = (await host.list(LOCAL_CALLER as never, {})).find((e) => e.id === entry.id);
      expect(listed).toMatchObject({
        status: "error",
        error: expect.stringContaining("could not be delivered"),
      });
    });
  });

  it("H3: a starter archived while the name is chosen starts nothing", async () => {
    const host = createDeusHost();
    const before = workspaceCount();
    state.naming = async () => {
      state.db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = 'w-lead'").run();
    };
    await expect(host.start!(LEAD as never, startInput())).rejects.toMatchObject({
      refusal: { code: "archived" },
    });
    expect(workspaceCount()).toBe(before);
  });

  it("H3: four agents' starts racing past the name lookup make three setups", async () => {
    const host = createDeusHost();
    for (const id of ["a", "b", "c", "d"]) {
      insertWorkspace(`w-${id}`, `home-${id}`);
      insertChat(`s-${id}`, `w-${id}`);
    }
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    state.naming = () => gate;
    const starts = ["a", "b", "c", "d"].map((id) =>
      host.start!(
        { kind: "session", sessionId: `s-${id}` } as never,
        startInput({ origin: { kind: "session", sessionId: `s-${id}` } })
      ).then(
        () => "made",
        (e: { refusal?: { code: string } }) => e.refusal?.code
      )
    );
    open();
    expect((await Promise.all(starts)).sort()).toEqual([
      "limit_setting_up",
      "made",
      "made",
      "made",
    ]);
  });

  it("H4: a child started after the archive was asked, before its queued update, stops it", async () => {
    const host = createDeusHost();
    insertWorkspace("w-p", "parent", { startedBy: LEAD });
    insertChat("s-p", "w-p", LEAD);
    const archiving = host.archive!(LEAD as never, { kind: "workspace", id: "w-p" });
    // In the same tick, before the queue runs: a child of the parent appears.
    insertWorkspace("w-c", "child", { startedBy: { kind: "session", sessionId: "s-p" } });
    insertChat("s-c", "w-c", { kind: "session", sessionId: "s-p" });
    await expect(archiving).rejects.toMatchObject({
      refusal: { code: "has_children", sessions: ["s-c"] },
    });
    const w = state.db.prepare("SELECT state FROM workspaces WHERE id = 'w-p'").get() as {
      state: string;
    };
    expect(w.state).toBe("ready");
  });

  it("H4: a workspace whose chat started another chat in it is refused, as the package's preflight does", async () => {
    const host = createDeusHost();
    insertChat("s-second", "w-lead", { kind: "session", sessionId: "s-lead" });
    await expect(
      host.archive!(LOCAL_CALLER as never, { kind: "workspace", id: "w-lead" })
    ).rejects.toMatchObject({ refusal: { code: "has_children", sessions: ["s-second"] } });
  });

  it("H5: a workspace archived while a send reads its settings gets nothing; a stop and an answer there are refused", async () => {
    const host = createDeusHost();
    state.ops.messages = () => {
      state.db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = 'w-lead'").run();
      return { messages: [], turns: [], compactions: [], has_older: false, has_newer: false };
    };
    await expect(
      host.send(LEAD as never, "s-lead", { turnId: "t1", message: "hi", origin: LEAD })
    ).rejects.toMatchObject({ refusal: { code: "archived" } });
    expect(state.sent).toEqual([]);
    state.live.set("s-lead", "t0");
    await expect(host.cancel!(LOCAL_CALLER as never, "s-lead", "t0")).rejects.toMatchObject({
      refusal: { code: "archived" },
    });
    expect(state.stopped).toEqual([]);
    state.pending = [
      {
        requestId: "q1",
        sessionId: "s-lead",
        method: "askUserQuestion",
        params: { questions: [{ question: "Which?", options: ["a"] }] },
      },
    ];
    await expect(
      host.respond!(LOCAL_CALLER as never, "s-lead", {
        kind: "question",
        requestId: "q1",
        outcome: { action: "accept", content: { "0": "a" } },
      } as never)
    ).rejects.toMatchObject({ refusal: { code: "archived" } });
    expect(state.answered).toEqual([]);
  });
});

describe("the first task's hand-off, numbers, and what a view shows (H7, H8, H12, H15, H17)", () => {
  it("H7: a stop while the first task is handed to the engine stops it by its minted id", async () => {
    const host = createDeusHost();
    const entry = await host.start!(LEAD as never, startInput({ turnId: "first-7" }));
    let admit!: () => void;
    state.sending = new Promise<void>((resolve) => (admit = resolve));
    ready(entry);
    const stopping = host.cancel!(LEAD as never, entry.id);
    admit();
    expect(await stopping).toBe("stopped");
    expect(state.stopped).toEqual([{ sessionId: entry.id, by: LEAD }]);
  });

  it("H8: chats keep the number they were made with, whatever their ids sort as; the newest visible is by number", async () => {
    const host = createDeusHost();
    insertChat("zz-second", "w-lead", LEAD);
    insertChat("aa-third", "w-lead", LEAD);
    const numbers = (await host.list(LOCAL_CALLER as never, {}))
      .filter((e) => e.workspace.name === "lead")
      .map((e) => [e.id, e.chat]);
    expect(numbers).toEqual([
      ["s-lead", 1],
      ["zz-second", 2],
      ["aa-third", 3],
    ]);
    await host.archive!(LEAD as never, { kind: "session", id: "aa-third" });
    const w = state.db
      .prepare("SELECT current_session_id FROM workspaces WHERE id = 'w-lead'")
      .get() as {
      current_session_id: string;
    };
    expect(w.current_session_id).toBe("zz-second");
  });

  it("H12: a workspace with neither a chat nor a first chat's id is given one, stored once", async () => {
    const host = createDeusHost();
    insertWorkspace("w-old", "old", { state: "error" });
    const first = (await host.list(LOCAL_CALLER as never, {})).find(
      (e) => e.workspace.id === "w-old"
    );
    expect(first).toMatchObject({ status: "error" });
    const again = (await host.list(LOCAL_CALLER as never, {})).find(
      (e) => e.workspace.id === "w-old"
    );
    expect(again?.id).toBe(first?.id);
  });

  it("H15: an agent the start names that does not run here makes no chat", async () => {
    const host = createDeusHost();
    const before = (state.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number })
      .n;
    await expect(
      host.start!(
        LEAD as never,
        startInput({ workspace: { id: "w-lead", name: "lead" }, harness: "acp" })
      )
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((state.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(
      before
    );
  });

  it("H15: a model the agent does not offer here makes no chat", async () => {
    const host = createDeusHost();
    state.ops.agentModels = () => ({
      lists: [
        {
          harness: "claude-code",
          models: [
            { id: "haiku", harness: "claude-code", label: "Haiku", thinking: { levels: [] } },
          ],
        },
      ],
    });
    const before = (state.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number })
      .n;
    await expect(
      host.start!(
        LEAD as never,
        startInput({ workspace: { id: "w-lead", name: "lead" }, model: "gpt-9" })
      )
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((state.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(
      before
    );
    await expect(
      host.start!(
        LEAD as never,
        startInput({ workspace: { id: "w-lead", name: "lead" }, model: "haiku" })
      )
    ).resolves.toMatchObject({ workspace: { name: "lead" } });
  });

  it("H14: a chat put away tells its own record, so a drawn chip stops being a link", async () => {
    const host = createDeusHost();
    insertChat("s-second", "w-lead", LEAD);
    const told: unknown[] = [];
    state.listeners.add((resources, ctx) => told.push([resources, ctx?.sessionIds]));
    await host.archive!(LEAD as never, { kind: "session", id: "s-second" });
    expect(told).toContainEqual([["session"], ["s-second"]]);
  });

  it("H15: a first task refused after the chat was made is that chat's error, not a refusal", async () => {
    const host = createDeusHost();
    state.sendRefusal = new Error("engine unavailable");
    const entry = await host.start!(
      LEAD as never,
      startInput({ workspace: { id: "w-lead", name: "lead" } })
    );
    expect(entry).toMatchObject({
      status: "error",
      error: "Its first task could not be delivered.",
    });
  });

  it("H17: a read after the last message sees a later cancel; a turn with no messages is shown", async () => {
    const host = createDeusHost();
    message("s-lead", "t1", "user", "go");
    state.live.set("s-lead", "t1");
    const first = await host.view(LOCAL_CALLER as never, "s-lead", { last: 10 });
    state.live.delete("s-lead");
    endTurn("s-lead", "t1", "cancelled", { kind: "person" });
    endTurn("s-lead", "t-silent", "end_turn");

    const after = await host.view(LOCAL_CALLER as never, "s-lead", { after: first.cursor });
    expect(after.turns.map((t) => [t.turnId, t.outcome]).sort()).toEqual([
      ["t-silent", "done"],
      ["t1", "cancelled"],
    ]);
  });
});

describe("a read's cursor (H17, the review bot's incremental read)", () => {
  it("a read mid-stream, then after the turn ends: the final answer is there once, complete", async () => {
    const host = createDeusHost();
    message("s-lead", "t1", "user", "go");
    message("s-lead", "t1", "assistant", "Hal");
    state.live.set("s-lead", "t1");
    const mid = await host.view(LOCAL_CALLER as never, "s-lead", { last: 10 });
    // The streamed message's part grows in place, as persistChanges upserts it; then the turn ends.
    state.db
      .prepare(
        "UPDATE parts SET data = json_set(data, '$.text', 'Halfway and done.') WHERE type = 'text' AND json_extract(data, '$.text') = 'Hal'"
      )
      .run();
    state.live.delete("s-lead");
    endTurn("s-lead", "t1", "end_turn");
    const after = await host.view(LOCAL_CALLER as never, "s-lead", { after: mid.cursor });
    const said = after.turns.flatMap((t) => t.messages.filter((m) => m.role === "assistant"));
    expect(said).toHaveLength(1);
    expect(JSON.stringify(said[0]!.parts)).toContain("Halfway and done.");
    expect(after.turns[0]).toMatchObject({ turnId: "t1", outcome: "done" });
  });

  it("two turns ending in the same millisecond are both seen after a cursor", async () => {
    const host = createDeusHost();
    state.live.set("s-lead", "a");
    state.db
      .prepare("INSERT INTO turns (session_id, turn_id, started_at) VALUES ('s-lead', 'a', 1)")
      .run();
    state.db
      .prepare("INSERT INTO turns (session_id, turn_id, started_at) VALUES ('s-lead', 'b', 2)")
      .run();
    state.db
      .prepare("UPDATE turns SET ended_at = 500, outcome = ? WHERE turn_id = 'b'")
      .run(JSON.stringify({ stopReason: "end_turn" }));
    const first = await host.view(LOCAL_CALLER as never, "s-lead", { last: 10 });
    state.db
      .prepare("UPDATE turns SET ended_at = 500, outcome = ? WHERE turn_id = 'a'")
      .run(JSON.stringify({ stopReason: "end_turn" }));
    state.live.delete("s-lead");

    const after = await host.view(LOCAL_CALLER as never, "s-lead", { after: first.cursor });
    expect(after.turns.map((t) => [t.turnId, t.outcome])).toEqual([["a", "done"]]);
  });
});

describe("round 3 (B1, B4, B5)", () => {
  it("B1: a cursor of zero reads forward from the first message, past 500, with no gap", async () => {
    const host = createDeusHost();
    const empty = await host.view(LOCAL_CALLER as never, "s-lead", { last: 10 });
    expect(empty.cursor).toMatch(/^0\./);
    for (let i = 0; i < 501; i++) message("s-lead", "t1", i % 2 ? "assistant" : "user", `m${i}`);
    endTurn("s-lead", "t1", "end_turn");
    const text = (view: { turns: readonly { messages: readonly { parts: unknown }[] }[] }) =>
      view.turns.flatMap((t) => t.messages.map((m) => JSON.stringify(m.parts)));
    const first = await host.view(LOCAL_CALLER as never, "s-lead", { after: empty.cursor });
    const firstText = text(first);
    expect(firstText[0]).toContain('"m0"');
    expect(firstText).toHaveLength(500);
    const next = await host.view(LOCAL_CALLER as never, "s-lead", { after: first.cursor });
    expect(text(next)).toEqual([expect.stringContaining('"m500"')]);
  });

  it("B4: a first task whose setup took longer than 30 minutes is not sent, and its chat says why", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const host = createDeusHost();
      const entry = await host.start!(LEAD as never, startInput());
      vi.setSystemTime(Date.now() + 31 * 60_000);
      ready(entry);
      expect(state.sent).toEqual([]);
      const row = state.db
        .prepare("SELECT status, error_message FROM sessions WHERE id = ?")
        .get(entry.id) as { status: string; error_message: string };
      expect(row).toEqual({
        status: "error",
        error_message: "Its first task could not be delivered. Setup took longer than 30 minutes.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("B5: after a refused first send, the last notification's read shows the error", async () => {
    const host = createDeusHost();
    const entry = await host.start!(LEAD as never, startInput());
    state.sendRefusal = new Error("engine unavailable");
    const seen: string[] = [];
    state.listeners.add((resources, ctx) => {
      if (!resources.includes("sessions") || !ctx?.sessionIds?.includes(entry.id)) return;
      void host
        .list(LOCAL_CALLER as never, {})
        .then((all) => seen.push(all.find((e) => e.id === entry.id)!.status));
    });
    ready(entry);
    await vi.waitFor(() => expect(seen.at(-1)).toBe("error"));
  });
});

describe("what still lives in Deus (H18, H19)", () => {
  const mcp = (message: unknown, caller: Caller) =>
    operations(handlers, caller)(api.agentMcp, { message }) as Promise<any>;
  const call = async (caller: Caller, name: string, args: Record<string, unknown>) => {
    const reply = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      caller
    );
    return { text: reply.result.content[0].text as string, isError: reply.result.isError === true };
  };

  it("an assistant allowed to read may send feedback, which changes nothing here", async () => {
    state.stored.claude = "read";
    const sent = await call(assistantCaller("read"), "send_feedback", {
      message: "The list_sessions tool could say which chat is current in each workspace.",
    });
    expect(sent).toMatchObject({ isError: false });
    expect(state.feedback).toHaveLength(1);
  });

  it("read_changes shows only a changed file: an unchanged one (a secret git ignores) is refused", async () => {
    state.ops.diffFiles = () => ({
      files: [{ file: "src/a.ts", additions: 1, deletions: 0 }],
      total_count: 1,
    });
    state.ops.diffFile = () => ({ diff: "+x" });
    const refused = await call(LOCAL_CALLER, "read_changes", { session: "lead", file: ".env" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("is not one of");
    const shown = await call(LOCAL_CALLER, "read_changes", { session: "lead", file: "./src/a.ts" });
    expect(shown.text).toContain("diff of");
  });
});
