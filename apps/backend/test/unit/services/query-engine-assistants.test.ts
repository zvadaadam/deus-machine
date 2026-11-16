// An assistant's connection asks and is answered. It follows no live read or
// stream and answers no agent's question itself; this computer's window and
// paired devices are unaffected.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { live, out, read, write } from "@shared/api/op";

const agent = vi.hoisted(() => ({
  answer: vi.fn(() => true),
  report: vi.fn(),
  callers: [] as unknown[],
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: vi.fn() }));
vi.mock("../../../src/db", () => ({
  getWorkspacesBySessionIds: vi.fn(),
  resetStatsCache: vi.fn(),
}));
vi.mock("../../../src/services/agent", () => ({
  answerToolRequest: agent.answer,
}));
vi.mock("@sentry/node", () => ({ captureException: agent.report }));

import { handle, Registry } from "../../../src/api/registry";
import { AppError } from "../../../src/lib/errors";
import { ASSISTANT_FAILURE } from "../../../src/services/assistants/sentences";
import { handleFrame, serveOperations } from "../../../src/services/query-engine";
import { addConnection, closeAll } from "../../../src/services/ws.service";
import { ASSISTANT_HOST } from "../../helpers";

const count = live({ name: "count", output: out<number>() });
const greet = read({ name: "greet", input: z.object({}), output: out<string>() });
// A stand-in for the operator tools over MCP: echoes, refuses or fails by the message.
const agentMcp = write({
  name: "agentMcp",
  input: z.object({ message: z.unknown() }),
  output: out<unknown>(),
});

function connect(assistant: boolean) {
  const sent: Record<string, unknown>[] = [];
  const id = addConnection(
    { send: (data) => sent.push(JSON.parse(String(data))), close: vi.fn() },
    assistant ? null : "phone",
    true,
    assistant
      ? {
          assistant: { clientId: "claude", access: "operate", host: ASSISTANT_HOST },
          signInEndsAt: Infinity,
        }
      : null
  );
  return { id, sent };
}

beforeEach(() => {
  serveOperations(
    new Registry([
      handle(count, () => 3),
      handle(greet, () => "hello"),
      handle(agentMcp, ({ message }, { caller }) => {
        agent.callers.push(caller);
        if (message === "refused") throw new AppError(403, "This assistant may only read.");
        if (message === "boom") throw new Error("SQLITE_BUSY at /Users/someone/deus.db");
        return { answered: message };
      }),
    ])
  );
});

afterEach(() => {
  closeAll();
  vi.clearAllMocks();
  agent.callers = [];
  vi.useRealTimers();
});

describe("an assistant's frames", () => {
  it("refuses its subscriptions, to live reads and to streams", () => {
    const { id, sent } = connect(true);
    handleFrame(id, { type: "q:subscribe", id: "s1", resource: "count" });
    handleFrame(id, {
      type: "q:subscribe",
      id: "s2",
      resource: "toolRequests",
      params: { sessionId: "chat" },
    });
    expect(sent).toEqual([
      expect.objectContaining({ type: "q:error", id: "s1", code: "FORBIDDEN" }),
      expect.objectContaining({ type: "q:error", id: "s2", code: "FORBIDDEN" }),
    ]);
  });

  it("refuses its answers to an agent's questions", () => {
    const { id, sent } = connect(true);
    handleFrame(id, {
      type: "q:tool_response",
      id: "t1",
      requestId: "req",
      result: { approved: true },
    });
    expect(agent.answer).not.toHaveBeenCalled();
    expect(sent).toEqual([expect.objectContaining({ type: "q:error", code: "FORBIDDEN" })]);
  });

  it("answers its MCP messages for the operator tools, and refuses anything else", async () => {
    const { id, sent } = connect(true);
    const message = { jsonrpc: "2.0", id: 1, method: "initialize" };
    handleFrame(id, { type: "q:mutate", id: "m1", action: "agentMcp", params: { message } });
    handleFrame(id, { type: "q:request", id: "r2", resource: "greet" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toContainEqual({
      type: "q:mutate_result",
      id: "m1",
      success: true,
      data: { answered: message },
    });
    expect(sent).toContainEqual(expect.objectContaining({ type: "q:error", id: "r2" }));
  });
});

describe("when an assistant's connection is cut", () => {
  const ask = (id: string) =>
    handleFrame(id, { type: "q:mutate", id: "m1", action: "agentMcp", params: { message: 1 } });

  it("is on its caller: the sooner of its sign-in's end and the connection's cap", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-15T12:00:00Z"), toFake: ["Date"] });
    const now = Date.now();
    const soon = addConnection({ send: vi.fn(), close: vi.fn() }, null, true, {
      assistant: { clientId: "claude", access: "operate", host: ASSISTANT_HOST },
      signInEndsAt: now + 60_000,
    });
    const later = addConnection({ send: vi.fn(), close: vi.fn() }, null, true, {
      assistant: { clientId: "codex", access: "operate", host: ASSISTANT_HOST },
      signInEndsAt: now + 3_600_000,
    });
    ask(soon);
    ask(later);
    await vi.waitFor(() => expect(agent.callers).toHaveLength(2));
    expect(agent.callers).toEqual([
      expect.objectContaining({ endsAt: now + 60_000 }),
      expect.objectContaining({ endsAt: now + 200_000 }),
    ]);
  });

  it("is absent for this computer's window and paired devices", async () => {
    ask(connect(false).id);
    ask(addConnection({ send: vi.fn(), close: vi.fn() }, null));
    await vi.waitFor(() => expect(agent.callers).toHaveLength(2));
    for (const caller of agent.callers) expect(caller).not.toHaveProperty("endsAt");
  });
});

describe("an assistant's failures", () => {
  it("are one generic sentence, reported as before; a refusal keeps its words", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { id, sent } = connect(true);
    handleFrame(id, {
      type: "q:mutate",
      id: "m1",
      action: "agentMcp",
      params: { message: "boom" },
    });
    handleFrame(id, {
      type: "q:mutate",
      id: "m2",
      action: "agentMcp",
      params: { message: "refused" },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toContainEqual(
      expect.objectContaining({ id: "m1", success: false, error: ASSISTANT_FAILURE })
    );
    expect(sent).toContainEqual(
      expect.objectContaining({ id: "m2", error: "This assistant may only read.", status: 403 })
    );
    expect(agent.report).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent)).not.toContain("SQLITE_BUSY");
  });

  it("keep their own words for this computer's window and paired devices", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { id, sent } = connect(false);
    handleFrame(id, {
      type: "q:mutate",
      id: "m1",
      action: "agentMcp",
      params: { message: "boom" },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ error: "SQLITE_BUSY at /Users/someone/deus.db" });
  });
});

describe("a paired device's frames", () => {
  it("subscribe and answer as before", () => {
    const { id, sent } = connect(false);
    handleFrame(id, { type: "q:subscribe", id: "s1", resource: "count" });
    handleFrame(id, { type: "q:tool_response", id: "t1", requestId: "req", result: { ok: 1 } });
    expect(sent).toEqual([{ type: "q:snapshot", id: "s1", data: 3 }]);
    expect(agent.answer).toHaveBeenCalledWith("req", { result: { ok: 1 } });
  });
});
