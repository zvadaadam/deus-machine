// This computer as the operator tools' host (LLP 0019), against a scratch
// SQLite database built from the fresh schema: its chats as sessions, read
// from their rows; a turn sent, stopped and answered through the app's own
// paths (stood in for here); what it enforces at its commit; and the tools
// reached through MCP (`agentMcp`) and as a chat's own.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { WireRequestError } from "@zvada/agent-server/client";
import { createOperator } from "@zvada/agent-server/operator";
import { WIRE_ERROR_CODES } from "@zvada/agent-server/protocol";
import { CATALOG_MODEL_LISTS, defaultModelId } from "@shared/models";
import type { Op } from "@shared/api/op";
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
  runAsThisComputer: async (op: Op<string, z.ZodObject>, input: unknown) => {
    const answer = state.ops[op.name];
    if (!answer) throw new Error(`no stand-in for ${op.name}`);
    return answer(op.input.parse(input ?? {}));
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
  isConnected: () => false,
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
vi.mock("../../../src/services/workspace-checkout", () => ({
  pickWorkspaceName: async () => {
    await state.naming?.();
    const n = ++state.created;
    return { slug: `new${n}`, branchName: `lab/new${n}` };
  },
  initializeWorkspace: async () => {},
}));
vi.mock("../../../src/services/settings.service", () => ({ getSetting: vi.fn() }));
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
import * as turns from "../../../src/services/agent/turns";
import {
  AgentServerDisconnectedError,
  AppError,
  ChatBusyError,
  ConflictError,
} from "../../../src/lib/errors";
import { persistSessionTitle } from "../../../src/services/agent/persistence";
import { deleteFailedWorkspace } from "../../../src/services/workspace-lifecycle";
import { createDeusHost } from "../../../src/services/assistants/host";
import { getSetting } from "../../../src/services/settings.service";
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

/** Checkout finished and the workspace is ready with its first chat. */
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
    agentModels: () => ({ lists: CATALOG_MODEL_LISTS }),
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
  it("resolves the account's default and thinking once before a held first delivery", async () => {
    const host = createDeusHost();
    const harness = "codex-app-server";
    const lists = [
      {
        harness,
        source: "live",
        models: ["first", "account-pick"].map((id) => ({
          harness,
          id,
          label: id,
          isDefault: id === "account-pick",
          thinking: { levels: ["low", "medium"] },
        })),
      },
    ];
    const read = vi.fn(() => ({ lists }));
    state.ops.agentModels = read;
    const entry = await host.start!(LEAD as never, startInput({ harness }));
    expect(read).toHaveBeenCalledExactlyOnceWith({ harness, workspaceId: undefined });
    ready(entry);
    await vi.waitFor(() => expect(state.sent).toHaveLength(1));
    expect(read).toHaveBeenCalledOnce();
    expect(state.sent[0].input).toMatchObject({
      agentHarness: harness,
      model: "account-pick",
      thinkingLevel: "medium",
    });
  });

  it("quotes an empty list before creating a workspace or a chat", async () => {
    const host = createDeusHost();
    const why = "The fixture CLI is signed out.";
    const read = vi.fn(() => ({
      lists: [{ harness: "codex-app-server", models: [], source: "catalog", error: why }],
    }));
    state.ops.agentModels = read;
    const sessionsBefore = state.db.prepare("SELECT id FROM sessions").all();
    await expect(
      host.start!(LEAD as never, startInput({ harness: "Codex" }))
    ).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(state.created).toBe(0);
    await expect(
      host.start!(
        LEAD as never,
        startInput({ harness: "Codex", workspace: { id: "w-lead", name: "lead" } })
      )
    ).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining(
        `("${why}"). Ask the person to install or sign in to the agent in Settings → AI Providers. Nothing was started.`
      ),
    });
    expect(state.db.prepare("SELECT id FROM sessions").all()).toEqual(sessionsBefore);
    expect(read.mock.calls).toEqual([
      [{ harness: "codex-app-server", workspaceId: undefined }],
      [{ harness: "codex-app-server", workspaceId: "w-lead" }],
    ]);
    expect(state.sent).toHaveLength(0);
  });

  it("sends to a fresh Codex chat on its catalog model and the person's thinking level while discovery is pending", async () => {
    state.db
      .prepare("UPDATE sessions SET agent_harness = 'codex-app-server' WHERE id = 's-lead'")
      .run();
    const pending = Promise.withResolvers<{ lists: [] }>();
    const read = vi.fn(() => pending.promise);
    state.ops.agentModels = read;
    vi.mocked(getSetting).mockReturnValueOnce("ultra");
    try {
      const reply = await createOperator(createDeusHost()).call(
        "send_message",
        { session: "lead:1", message: "continue", wait: 0 },
        assistantWho()
      );
      expect(reply).toMatch(/^sent to /);
      expect(state.sent).toHaveLength(1);
      expect(state.sent[0].input).toMatchObject({
        model: defaultModelId(CATALOG_MODEL_LISTS, "codex-app-server"),
        thinkingLevel: "ultra",
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      pending.resolve({ lists: [] });
    }
  });

  it("refuses a follow-up before discovery when the chat has neither a recorded model nor a catalog model", async () => {
    state.db.prepare("UPDATE sessions SET agent_harness = 'gemini' WHERE id = 's-lead'").run();
    const read = vi.fn(state.ops.agentModels);
    state.ops.agentModels = read;
    await expect(
      createOperator(createDeusHost()).call(
        "send_message",
        { session: "lead:1", message: "continue", wait: 0 },
        assistantWho()
      )
    ).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringMatching(
        /has not run a turn yet.*choose a model for Gemini in the chat.*start_session with a model.*Nothing was sent/
      ),
    });
    expect(read).not.toHaveBeenCalled();
    expect(state.sent).toHaveLength(0);
  });

  it("refuses to deliver to an unknown stored agent before reading settings or sending", async () => {
    state.db
      .prepare("UPDATE sessions SET agent_harness = 'future-agent' WHERE id = 's-lead'")
      .run();
    const host = createDeusHost();
    const read = vi.fn(state.ops.agentModels);
    state.ops.agentModels = read;
    const history = vi.fn(state.ops.messages);
    state.ops.messages = history;
    await expect(
      createOperator(host).call(
        "send_message",
        { session: "lead:1", message: "continue", wait: 0 },
        assistantWho()
      )
    ).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining('"future-agent" does not run here. Nothing was sent.'),
    });
    // The operator views the chat at preflight. The host's settings read asks for its last 50.
    expect(history).not.toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    expect(read).not.toHaveBeenCalled();
    expect(state.sent).toHaveLength(0);
  });

  it("continues on the recorded model and thinking without asking for a list", async () => {
    const host = createDeusHost();
    const read = vi.fn();
    state.ops.agentModels = read;
    state.ops.messages = () => ({
      turns: [
        {
          turnId: "t0",
          execution: { harness: "claude-code", model: "older-model", thinkingLevel: "low" },
        },
      ],
    });
    await host.send(LEAD as never, "s-lead", { turnId: "t1", message: "continue", origin: LEAD });
    expect(read).not.toHaveBeenCalled();
    expect(state.sent[0].input).toMatchObject({
      agentHarness: "claude-code",
      model: "older-model",
      thinkingLevel: "low",
    });
  });

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
    state.db
      .prepare("UPDATE workspaces SET setup_status = 'running' WHERE id = ?")
      .run(entry.workspace.id);
    ready(entry);
    await vi.waitFor(() => expect(state.sent.map((s) => s.input.turnId)).toEqual(["first-1"]));

    const second = await host.start!(LEAD as never, { ...input, turnId: "first-2" } as never);
    expect(await host.cancel!(LEAD as never, second.id)).toBe("first_task_dropped");
    ready(second);
    expect(state.sent).toHaveLength(1);
  });

  it("counts both starting workspaces and ready ones running setup against the agent's cap", async () => {
    const host = createDeusHost();
    const input = {
      turnId: "x",
      project: { id: "r-shop", name: "demo-shop" },
      message: "go",
      origin: LEAD,
    };
    const start = (turnId: string) => host.start!(LEAD as never, { ...input, turnId } as never);
    const first = await start("first");
    await start("second");
    await start("third");
    const limit = { refusal: { code: "limit_setting_up" } };
    await expect(start("fourth")).rejects.toMatchObject(limit);
    const status = state.db.prepare("UPDATE workspaces SET setup_status = ? WHERE id = ?");
    status.run("running", first.workspace.id);
    ready(first);
    await expect(start("fourth")).rejects.toMatchObject(limit);
    // The person's own start is not an agent's.
    await expect(
      host.start!(LOCAL_CALLER as never, { ...input, origin: { kind: "person" } } as never)
    ).resolves.toMatchObject({ status: "setting_up" });
    status.run("completed", first.workspace.id);
    await expect(start("fourth")).resolves.toMatchObject({ status: "setting_up" });
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
    // F6: named as a send's sender is, so another reader sees who, not an id.
    expect(state.stopped).toEqual([{ sessionId: "s-lead", by: { ...LEAD, name: "lead:1" } }]);
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

  it("a chat an assistant started is archived by that assistant, as an agent's is", async () => {
    const host = createDeusHost();
    state.stored.claude = "operate";
    const by = { kind: "assistant", id: "assistant:claude", name: "Claude" };
    insertChat("s-second", "w-lead", by);
    expect(await host.archive!(assistantWho(), { kind: "session", id: "s-second" })).toEqual({
      note: "The chat is put away; its workspace stays.",
    });
    const row = state.db.prepare("SELECT is_hidden FROM sessions WHERE id = 's-second'").get() as {
      is_hidden: number;
    };
    expect(row.is_hidden).toBe(1);
  });

  it("a chat the person started is not archived on its own, by an agent or an assistant", async () => {
    const host = createDeusHost();
    state.stored.claude = "operate";
    insertChat("s-mine", "w-lead");
    for (const caller of [LEAD, assistantWho()])
      await expect(
        host.archive!(caller as never, { kind: "session", id: "s-mine" })
      ).rejects.toMatchObject({
        refusal: {
          code: "unsupported",
          detail:
            "A chat the person started is closed by the person in Deus; archive its workspace instead if that is what was asked.",
        },
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

describe("archiving a workspace with a running turn", () => {
  const caller = {
    ...LEAD,
    turnId: "lead-turn",
    harness: "claude-code",
    permissionMode: "bypass_permissions",
  } as const;
  const target = { kind: "workspace", id: "w-work" } as const;
  const worker = { kind: "session", sessionId: "s-work" } as const;
  beforeEach(() => {
    insertWorkspace("w-work", "work", { startedBy: LEAD });
    insertChat("s-work", "w-work", LEAD);
    state.live.set("s-work", "first");
  });

  it("refuses an unarchived child before asking to stop its parent", async () => {
    insertChat("s-child", "w-lead", worker);
    await expect(createDeusHost().archive!(caller, target)).rejects.toMatchObject({
      refusal: { code: "has_children", sessions: ["s-child"] },
    });
  });

  it("refuses another starter's working chat before asking to stop the caller's chat", async () => {
    insertChat("s-other", "w-work");
    state.live.set("s-other", "other-turn");
    await expect(createDeusHost().archive!(caller, target)).rejects.toMatchObject({
      refusal: { code: "not_yours", sessions: ["s-other"], state: "working" },
    });
  });

  it.each(["working", "needs_input"])(
    "names both of the caller's active chats when the first is %s",
    async (status) => {
      insertChat("s-second", "w-work", LEAD);
      state.live.set("s-second", "second");
      if (status === "needs_input") {
        state.pending.push({
          sessionId: "s-work",
          requestId: "plan",
          method: "exitPlanMode",
          params: {},
        });
      }
      await expect(createDeusHost().archive!(caller, target)).rejects.toMatchObject({
        refusal: { code: "busy", sessions: ["s-work", "s-second"], state: status },
      });
    }
  );

  it("the operator leaves the turn running if a child starts between preflight and commit", async () => {
    const host = createDeusHost();
    const archive = host.archive!;
    vi.spyOn(host, "archive").mockImplementationOnce((who, subject) => {
      insertChat("s-child", "w-lead", worker);
      return archive(who, subject);
    });
    await expect(
      createOperator(host).call("archive", { workspaces: ["work"] }, caller)
    ).rejects.toMatchObject({
      code: "has_children",
    });
    expect(state.stopped).toEqual([]);
    expect(state.live.get("s-work")).toBe("first");
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

  it("says when a diff cannot be read, including in a settled turn's outcome", async () => {
    const why = "Could not read the changes: git returned no merge base.";
    state.ops.diffFiles = () => {
      throw new ConflictError(why);
    };
    const host = createDeusHost();
    const [entry] = await host.list(LEAD as never, {});
    await expect(host.outcome!(LEAD as never, entry!)).resolves.toBe(why);
    for (const args of [{ session: "lead:1" }, { session: "lead:1", file: "script" }]) {
      expect(await call(LOCAL_CALLER, "read_changes", args)).toMatchObject({
        isError: true,
        text: expect.stringContaining(why),
      });
    }
  });

  it("answers a definite engine-down send once, with the reason", async () => {
    const realTurns = await vi.importActual<typeof turns>("../../../src/services/agent/turns");
    const send = vi.spyOn(turns, "sendMessage").mockImplementation(realTurns.sendMessage);
    const result = await call(LOCAL_CALLER, "send_message", {
      session: "lead:1",
      message: "go",
      wait: 1,
    });
    expect(result).toMatchObject({
      isError: true,
      text: expect.stringContaining("Nothing was sent or started. Restart Deus"),
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not tell the caller the engine stopped for a different service's 503", async () => {
    state.sendRefusal = new AppError(503, "Deus Cloud is not configured.");
    const { text } = await call(LOCAL_CALLER, "send_message", {
      session: "lead:1",
      message: "go",
      wait: 1,
    });
    expect(text).toContain("not confirmed");
    expect(text).not.toContain("Restart Deus");
  });

  it("lists catalog models and uses the catalog default for starts and sends when the engine is down", async () => {
    state.ops.agentModels = () => {
      throw new Error("Agent server not connected");
    };
    const { text, isError } = await call(LOCAL_CALLER, "list_models", {});
    expect(isError).toBe(false);
    for (const {
      harness,
      models: [first],
    } of CATALOG_MODEL_LISTS) {
      if (!first) continue;
      expect(text).toContain(harness);
      expect(text).toContain(first.id);
    }
    const operator = createOperator(createDeusHost());
    const who = assistantWho();
    expect(
      await operator.call(
        "start_session",
        { project: "demo-shop", workspace: "lead", message: "go", wait: 0 },
        who
      )
    ).toContain('started "lead:');
    await operator.call("send_message", { session: "lead:1", message: "continue", wait: 0 }, who);
    const model = defaultModelId(CATALOG_MODEL_LISTS, "claude-code");
    expect(state.sent.map((s) => s.input.model)).toEqual([model, model]);
  });

  it.each([
    { model: "opus" },
    { thinking: "high" },
    { agent: "Gemini" },
    { agent: "Gemini", model: "gemini-4-neon" },
  ])(
    "refuses a start when the list read fails and the catalog cannot choose for it: %o",
    async (choice) => {
      state.ops.agentModels = () => {
        throw new Error("Model-list request timed out");
      };
      const before = state.db.prepare("SELECT id FROM sessions").all();
      await expect(
        createOperator(createDeusHost()).call(
          "start_session",
          { project: "demo-shop", workspace: "lead", message: "go", ...choice },
          assistantWho()
        )
      ).rejects.toMatchObject({
        code: "unsupported",
        message:
          "refused (unsupported): start_session: the model list could not be read right now. Nothing was started.",
      });
      expect(state.db.prepare("SELECT id FROM sessions").all()).toEqual(before);
      expect(state.sent).toHaveLength(0);
    }
  );

  it.each([{}, { model: "gemini-4-neon" }])(
    "explains an empty agent list before judging the requested model: %o",
    async (choice) => {
      state.ops.agentModels = () => ({
        lists: [{ harness: "gemini", source: "catalog", models: [], error: "Sign-in required." }],
      });
      const before = state.db.prepare("SELECT id FROM sessions").all();
      await expect(
        createOperator(createDeusHost()).call(
          "start_session",
          { project: "demo-shop", workspace: "lead", agent: "Gemini", message: "go", ...choice },
          assistantWho()
        )
      ).rejects.toMatchObject({
        code: "unsupported",
        message: expect.stringMatching(
          /Sign-in required.*Settings → AI Providers.*Nothing was started/
        ),
      });
      expect(state.db.prepare("SELECT id FROM sessions").all()).toEqual(before);
      expect(state.sent).toHaveLength(0);
    }
  );

  it("retains the unknown outcome of unclassified wire errors", async () => {
    const args = { session: "lead:1", message: "go", wait: 1 };
    state.sendRefusal = new WireRequestError(
      WIRE_ERROR_CODES.harnessNotAvailable,
      "private runtime details"
    );
    expect((await call(LOCAL_CALLER, "send_message", args)).text).toContain("not confirmed");
    state.sendRefusal = new WireRequestError(
      WIRE_ERROR_CODES.internalError,
      "request timed out: turn/start"
    );
    expect((await call(LOCAL_CALLER, "send_message", args)).text).toContain("not confirmed");
  });

  it("an outside caller is told which computer it reaches: in the instructions and in whoami", async () => {
    const where =
      'These are the coding agents on the computer "Proof Mac" itself: its own workspaces and their chats. Cloud workspaces are not listed here.';
    const init = await mcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      assistantCaller("read")
    );
    expect(init.result.instructions).toBe(
      `${where} Start with list_sessions to see them; what you may do here is decided by the person on this computer.`
    );
    state.stored.claude = "read";
    const who = await call(assistantCaller("read"), "whoami", {});
    expect(who.text.split("\n").slice(1)).toEqual([`access: read. ${where}`]);
  });

  it("an assistant allowed to read reads, is refused a write, and may send feedback's write", async () => {
    state.stored.claude = "read";
    const reader = assistantCaller("read");
    expect((await call(reader, "list_sessions", {})).text).toContain('"lead"');
    const refused = await call(reader, "send_message", { session: "lead", message: "x", wait: 0 });
    expect(refused).toMatchObject({ isError: true });
    // The package's refusal, then this computer's sentence: "Nothing was done." once.
    expect(refused.text).toBe(
      `refused (access): You may not do this here. Nothing was done. ${READ_ONLY}`
    );
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
    ).rejects.toMatchObject({
      code: "access",
      // Refused at the commit, in the same words as the package's own refusal.
      message: `refused (access): You may not do this here. Nothing was done. ${READ_ONLY}`,
    });
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

  it.each(["assistant", "chat"])(
    "records the %s that archived a workspace through the host",
    async (kind) => {
      state.stored.claude = "operate";
      const by =
        kind === "chat" ? LEAD : { kind: "assistant", id: "assistant:claude", name: "Claude" };
      insertWorkspace("w-close", "close", { startedBy: by });
      insertChat("s-close", "w-close", by);
      await createDeusHost().archive!(kind === "chat" ? (LEAD as never) : assistantWho(), {
        kind: "workspace",
        id: "w-close",
      });
      const archived = state.db
        .prepare("SELECT state,archived_by,archived_at FROM workspaces WHERE id='w-close'")
        .get();
      expect(archived).toEqual({
        state: "archived",
        archived_by: JSON.stringify(by),
        archived_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} /),
      });
    }
  );

  it("an assistant archives a failed workspace that still has an unselected chat", async () => {
    insertWorkspace("w-close", "close", { state: "error" });
    insertChat("s-close", "w-close", undefined, false);
    state.ops.deleteWorkspace = ({ workspaceId }) => deleteFailedWorkspace(String(workspaceId));

    await createDeusHost().archive!(assistantWho(), { kind: "workspace", id: "w-close" });
    expect(state.db.prepare("SELECT state FROM workspaces WHERE id='w-close'").pluck().get()).toBe(
      "archived"
    );
  });

  it("publishes one archive when two assistant requests reach the same workspace", async () => {
    state.stored.claude = "operate";
    const caller = assistantWho();
    insertWorkspace("w-close", "close", { startedBy: caller });
    insertChat("s-close", "w-close", caller);
    const host = createDeusHost();
    const changed = vi.fn();
    state.listeners.add(changed);
    const target = { kind: "workspace", id: "w-close" } as const;
    await Promise.all([host.archive!(caller, target), host.archive!(caller, target)]);
    expect(
      changed.mock.calls.filter(([resources]) => resources.includes("workspaces"))
    ).toHaveLength(1);
    expect(state.db.prepare("SELECT state FROM workspaces WHERE id='w-close'").get()).toEqual({
      state: "archived",
    });
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
  it("dates equally old prompts by the latest assistant message; parts within a message have no clock", async () => {
    const host = createDeusHost();
    const promptTime = new Date(Date.now() - 12 * 60_000).toISOString();
    const insert = state.db.prepare(
      "INSERT INTO sessions (id, workspace_id, chat, updated_at, last_user_message_at) VALUES (?, 'w-lead', ?, ?, ?)"
    );
    insert.run("silent", 2, promptTime, promptTime);
    insert.run("busy", 3, promptTime, promptTime);
    message("busy", "answer", "assistant", "A recent reply.");
    const entries = await host.list(LEAD as never, {});
    const ageOf = (id: string) => entries.find((e) => e.id === id)!.lastActivityAt!;
    expect(ageOf("silent")).toBe(Date.parse(promptTime));
    expect(ageOf("busy")).toBeGreaterThan(ageOf("silent"));
  });

  it("H7: a stop while the first task is handed to the engine stops it by its minted id", async () => {
    const host = createDeusHost();
    const entry = await host.start!(LEAD as never, startInput({ turnId: "first-7" }));
    let admit!: () => void;
    state.sending = new Promise<void>((resolve) => (admit = resolve));
    ready(entry);
    const stopping = host.cancel!(LEAD as never, entry.id);
    admit();
    expect(await stopping).toBe("stopped");
    expect(state.stopped).toEqual([{ sessionId: entry.id, by: { ...LEAD, name: "lead:1" } }]);
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
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining('"acp" does not run here'),
    });
    expect(state.sent).toHaveLength(0);
    expect((state.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(
      before
    );
  });

  it("an agent named as people say it starts on that agent; one that matches none lists the agents", async () => {
    const host = createDeusHost();
    const harnessOf = (id: string) =>
      (
        state.db.prepare("SELECT agent_harness FROM sessions WHERE id = ?").get(id) as {
          agent_harness: string;
        }
      ).agent_harness;
    for (const [said, harness] of [
      ["Claude", "claude-code"],
      ["claude code", "claude-code"],
      ["CODEX", "codex-app-server"],
      ["codex-app-server", "codex-app-server"],
    ]) {
      const entry = await host.start!(
        LEAD as never,
        startInput({ workspace: { id: "w-lead", name: "lead" }, harness: said })
      );
      expect(harnessOf(entry.id)).toBe(harness);
      expect(state.sent.at(-1)).toMatchObject({ input: { agentHarness: harness } });
    }
    await expect(
      host.start!(
        LEAD as never,
        startInput({ workspace: { id: "w-lead", name: "lead" }, harness: "gpt-pilot" })
      )
    ).rejects.toMatchObject({
      code: "invalid_input",
      message:
        'refused (invalid_input): start_session: agent: "gpt-pilot" does not run here; the agents are "claude-code" (Claude Code), "codex-app-server" (Codex), and "gemini" (Gemini). Nothing was started.',
    });
  });

  it("a thinking level the model does not offer here makes no chat; with no list of this computer's it is not judged", async () => {
    const host = createDeusHost();
    const count = () =>
      (state.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    const before = count();
    // No list from this computer yet (the catalog's are provisional): passed on as today.
    await expect(
      host.start!(
        LEAD as never,
        startInput({ workspace: { id: "w-lead", name: "lead" }, thinkingLevel: "ludicrous" })
      )
    ).resolves.toMatchObject({ workspace: { name: "lead" } });
    expect(count()).toBe(before + 1);
    state.ops.agentModels = () => ({
      lists: [
        {
          harness: "claude-code",
          source: "live",
          models: [
            {
              id: "opus",
              harness: "claude-code",
              label: "Opus",
              thinking: { levels: ["low", "medium", "high"] },
            },
            { id: "haiku", harness: "claude-code", label: "Haiku", thinking: { levels: [] } },
          ],
        },
      ],
    });
    await expect(
      host.start!(
        LEAD as never,
        startInput({
          workspace: { id: "w-lead", name: "lead" },
          model: "opus",
          thinkingLevel: "ludicrous",
        })
      )
    ).rejects.toMatchObject({
      code: "invalid_input",
      message:
        'refused (invalid_input): start_session: thinking: "ludicrous" is not a level opus offers; its levels are "low", "medium", "high". Nothing was started.',
    });
    await expect(
      host.start!(
        LEAD as never,
        startInput({
          workspace: { id: "w-lead", name: "lead" },
          model: "haiku",
          thinkingLevel: "high",
        })
      )
    ).rejects.toMatchObject({
      message:
        'refused (invalid_input): start_session: thinking: "high" is not a level haiku offers; it has no thinking levels. Nothing was started.',
    });
    expect(count()).toBe(before + 1);
    // The default model's levels judge a level given without a model.
    await expect(
      host.start!(
        LEAD as never,
        startInput({ workspace: { id: "w-lead", name: "lead" }, thinkingLevel: "max" })
      )
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      host.start!(
        LEAD as never,
        startInput({
          workspace: { id: "w-lead", name: "lead" },
          model: "opus",
          thinkingLevel: "low",
        })
      )
    ).resolves.toMatchObject({ workspace: { name: "lead" } });
    expect(state.sent.at(-1)).toMatchObject({ input: { model: "opus", thinkingLevel: "low" } });
    // `off` is never judged: Claude takes it as no extended thinking on any model.
    for (const model of ["opus", "haiku"])
      await expect(
        host.start!(
          LEAD as never,
          startInput({ workspace: { id: "w-lead", name: "lead" }, model, thinkingLevel: "off" })
        )
      ).resolves.toMatchObject({ workspace: { name: "lead" } });
    expect(state.sent.at(-1)).toMatchObject({ input: { model: "haiku", thinkingLevel: "off" } });
  });

  it("Codex's off is judged like any level: refused where its model does not list it", async () => {
    const host = createDeusHost();
    state.ops.agentModels = () => ({
      lists: [
        {
          harness: "codex-app-server",
          source: "live",
          models: [
            {
              id: "gpt-5",
              harness: "codex-app-server",
              label: "GPT-5",
              thinking: { levels: ["low", "medium", "high"] },
            },
            {
              id: "gpt-5-mini",
              harness: "codex-app-server",
              label: "GPT-5 mini",
              thinking: { levels: ["off", "low", "medium", "high"] },
            },
          ],
        },
      ],
    });
    const start = (model: string) =>
      host.start!(
        LEAD as never,
        startInput({
          workspace: { id: "w-lead", name: "lead" },
          harness: "codex-app-server",
          model,
          thinkingLevel: "off",
        })
      );
    await expect(start("gpt-5")).rejects.toMatchObject({
      code: "invalid_input",
      message:
        'refused (invalid_input): start_session: thinking: "off" is not a level gpt-5 offers; its levels are "low", "medium", "high". Nothing was started.',
    });
    await expect(start("gpt-5-mini")).resolves.toMatchObject({ workspace: { name: "lead" } });
    expect(state.sent.at(-1)).toMatchObject({
      input: { model: "gpt-5-mini", thinkingLevel: "off" },
    });
  });

  it("accepts a window suffix for Claude and refuses an unlisted Gemini variant before making a chat", async () => {
    const operator = createOperator(createDeusHost());
    const start = (agent: string, model: string) =>
      operator.call(
        "start_session",
        {
          project: "demo-shop",
          workspace: "lead",
          message: "go",
          agent,
          model,
          wait: 0,
        },
        assistantWho()
      );
    await expect(start("Claude", "opus[1m]")).resolves.toContain('started "lead:');
    expect(state.sent.at(-1)?.input.model).toBe("opus[1m]");
    const before = state.db.prepare("SELECT id FROM sessions").all();
    state.ops.agentModels = () => ({
      lists: [
        {
          harness: "gemini",
          source: "live",
          models: [
            {
              id: "gemini-4-neon",
              harness: "gemini",
              label: "Gemini 4 Neon",
              thinking: { levels: ["low"] },
            },
          ],
        },
      ],
    });
    await expect(start("Gemini", "gemini-4-neon[1m]")).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining('"gemini-4-neon[1m]" is not one gemini offers here'),
    });
    expect(state.db.prepare("SELECT id FROM sessions").all()).toEqual(before);
    expect(state.sent).toHaveLength(1);
  });

  it("starts Gemini on the account's default and judges off against its live list", async () => {
    const host = createDeusHost();
    state.ops.agentModels = () => ({
      lists: [
        {
          harness: "gemini",
          source: "live",
          models: [
            {
              id: "gemini-4-neon",
              harness: "gemini",
              label: "Gemini 4 Neon",
              isDefault: true,
              thinking: { levels: ["low", "medium", "high", "xhigh"], default: "high" },
            },
          ],
        },
      ],
    });
    const input = { workspace: { id: "w-lead", name: "lead" }, harness: "gemini" };
    await expect(
      host.start!(LEAD as never, startInput({ ...input, thinkingLevel: "off" }))
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining('"off" is not a level gemini-4-neon offers'),
    });
    await host.start!(LEAD as never, startInput(input));
    expect(state.sent.at(-1)).toMatchObject({
      input: { agentHarness: "gemini", model: "gemini-4-neon" },
    });
  });

  it("a level is judged only by a list this computer's CLI gave: a catalog with models is not", async () => {
    const host = createDeusHost();
    const lists = (claude: "live" | "catalog") => ({
      lists: [
        {
          harness: "claude-code",
          source: claude,
          models: [
            { id: "opus", harness: "claude-code", label: "Opus", thinking: { levels: ["high"] } },
          ],
        },
        {
          harness: "codex-app-server",
          source: claude === "live" ? "catalog" : "live",
          models: [
            {
              id: "gpt-5",
              harness: "codex-app-server",
              label: "GPT-5",
              thinking: { levels: ["high"] },
            },
          ],
        },
      ],
    });
    const start = () =>
      host.start!(
        LEAD as never,
        startInput({
          workspace: { id: "w-lead", name: "lead" },
          model: "opus",
          thinkingLevel: "max",
        })
      );
    // Claude's CLI did not answer (its catalog, with models), Codex's did: not judged.
    state.ops.agentModels = () => lists("catalog");
    await expect(start()).resolves.toMatchObject({ workspace: { name: "lead" } });
    state.ops.agentModels = () => lists("live");
    await expect(start()).rejects.toMatchObject({
      message:
        'refused (invalid_input): start_session: thinking: "max" is not a level opus offers; its levels are "high". Nothing was started.',
    });
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
    state.sendRefusal = new AgentServerDisconnectedError();
    const entry = await host.start!(
      LEAD as never,
      startInput({ workspace: { id: "w-lead", name: "lead" }, turnId: "delivery" })
    );
    expect(entry).toMatchObject({
      status: "error",
      error: expect.stringContaining("Restart Deus"),
    });
    expect(await host.turn(LEAD as never, entry.id, "delivery")).toEqual({ state: "unknown" });
  });

  it("keeps an unknown send failure on the new session without ending an engine turn", async () => {
    const host = createDeusHost();
    state.sendRefusal = new Error("lost reply");
    const entry = await host.start!(
      LEAD as never,
      startInput({
        workspace: { id: "w-lead", name: "lead" },
        turnId: "unknown-delivery",
      })
    );
    expect(entry.error).toBe("Its first task could not be delivered.");
    expect((await host.view(LEAD as never, entry.id, {})).turns).toEqual([]);
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

describe("the acceptance pass (F5, F7, F8, F9, F10)", () => {
  const titles = (sessionId: string) =>
    state.db
      .prepare(
        "SELECT s.title AS chat, w.title AS workspace FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?"
      )
      .get(sessionId);

  it("F5: a title given at the start names the chat and its new workspace; the summary after it does not replace it", async () => {
    const host = createDeusHost();
    const entry = await host.start!(LEAD as never, startInput({ title: "Child One" }));
    ready(entry);
    await vi.waitFor(() => expect(state.sent).toHaveLength(1));
    persistSessionTitle(entry.id, "Session new1:1 reply");
    expect(titles(entry.id)).toEqual({ chat: "Child One", workspace: "Child One" });
    // A chat started with none takes the summary.
    const plain = await host.start!(LEAD as never, startInput({ turnId: "first-y" }));
    ready(plain);
    persistSessionTitle(plain.id, "Auto summary");
    expect(titles(plain.id)).toEqual({ chat: "Auto summary", workspace: "Auto summary" });
  });

  it("F5: a titled chat started in an existing untitled workspace does not rename the workspace", async () => {
    const host = createDeusHost();
    const entry = await host.start!(
      LEAD as never,
      startInput({ workspace: { id: "w-lead", name: "lead" }, title: "Second opinion" })
    );
    await vi.waitFor(() => expect(state.sent).toHaveLength(1));
    expect(titles(entry.id)).toEqual({ chat: "Second opinion", workspace: null });
  });

  it("F7, F8: a chat with a row borrows neither the workspace's title nor its time", async () => {
    const host = createDeusHost();
    insertChat("s-second", "w-lead", LEAD);
    state.db
      .prepare(
        "UPDATE workspaces SET title = 'OLD-B2', updated_at = datetime('now') WHERE id = 'w-lead'"
      )
      .run();
    state.db.prepare("UPDATE sessions SET title = 'OLD-B2' WHERE id = 's-second'").run();
    state.db.prepare("DROP TRIGGER update_sessions_updated_at").run();
    state.db
      .prepare("UPDATE sessions SET updated_at = '2020-01-01 00:00:00' WHERE id = 's-lead'")
      .run();
    const first = (await host.list(LOCAL_CALLER as never, {})).find((e) => e.id === "s-lead")!;
    expect(first.title).toBeUndefined();
    expect(first.lastActivityAt).toBe(Date.parse("2020-01-01T00:00:00Z"));
  });

  it("F9: a read with a cursor does not point back at older messages", async () => {
    const host = createDeusHost();
    message("s-lead", "t1", "user", "one");
    message("s-lead", "t1", "assistant", "two");
    endTurn("s-lead", "t1", "end_turn");
    const first = await host.view(LOCAL_CALLER as never, "s-lead", { last: 1 });
    expect(first.older).toBe(true);
    message("s-lead", "t2", "user", "three");
    endTurn("s-lead", "t2", "end_turn");
    const next = await host.view(LOCAL_CALLER as never, "s-lead", { after: first.cursor });
    expect(next.turns.map((t) => t.turnId)).toEqual(["t2"]);
    expect(next.older).toBeUndefined();
  });

  it("F10: a caller in plan mode is refused start_session and send_message, which make nothing; list_sessions answers", async () => {
    const source = withSessionTools({ name: "deus", tools: [], call: vi.fn() } as never);
    const caller = {
      sessionId: "s-lead",
      harness: "claude-code",
      turnId: "t",
      permissionMode: "plan",
    } as const;
    const signal = new AbortController().signal;
    const count = (table: string) =>
      (state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = [count("workspaces"), count("sessions"), count("messages")];
    insertChat("s-other", "w-lead", null, false);
    const started = await source.call(
      "start_session",
      { project: "demo-shop", message: "go" },
      caller as never,
      signal
    );
    const sent = await source.call(
      "send_message",
      { session: "lead:2", message: "x" },
      caller as never,
      signal
    );
    for (const refused of [started, sent]) {
      expect(refused).toMatchObject({ isError: true });
      expect(JSON.stringify(refused.content)).toContain("refused (read_only)");
    }
    expect([count("workspaces"), count("sessions") - 1, count("messages")]).toEqual(before);
    expect(state.sent).toEqual([]);
    const listed = await source.call("list_sessions", {}, caller as never, signal);
    expect(listed.isError ?? false).toBe(false);
    expect(JSON.stringify(listed.content)).toContain("lead");
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
