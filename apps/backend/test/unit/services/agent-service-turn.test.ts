// Local turn setup and admission through the in-process engine link.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WireRequestError } from "@zvada/agent-server/client";
import { WIRE_ERROR_CODES } from "@zvada/agent-server/protocol";
import { api } from "@shared/api";
import { SCHEMA_SQL } from "@shared/schema";
import repoHandlers from "../../../src/api/repos";
import sessionHandlers from "../../../src/api/sessions";
import { Registry } from "../../../src/api/registry";
import workspaceHandlers from "../../../src/api/workspaces";
import * as ownership from "../../../src/services/agent/chat-turn";
import { sendMessage } from "../../../src/services/agent/turns";
import * as agentEvents from "../../../src/services/agent/event-handler";
import * as integrations from "../../../src/services/integrations";
import type { TurnApps } from "../../../src/services/integrations/runtime";
import * as projectEnvironment from "../../../src/services/project-environment.service";
import { handleFrame, removeSubs, serveOperations } from "../../../src/services/query-engine";
import * as settings from "../../../src/services/settings.service";
import * as streams from "../../../src/services/streams";
import { addConnection, removeConnection } from "../../../src/services/ws.service";
import type { QServerFrame } from "@shared/types/query-protocol";
import { operations } from "../../helpers";

const { mockOpen, mockLinkStartTurn, mockLinkCancelTurn } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockLinkStartTurn: vi.fn(),
  mockLinkCancelTurn: vi.fn(),
}));

let db: Database.Database;
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => db,
  DB_PATH: "/tmp/deus-service-turn-test.db",
}));
vi.mock("../../../src/services/agent/client", () => ({
  AgentLink: { open: mockOpen },
}));

import * as agentService from "../../../src/services/agent/service";

const SESSION = "sess-1";
const TURN = "turn-1";

const start = () =>
  agentService.startTurn(SESSION, TURN, "claude-code", "hello", { cwd: "/tmp/nonexistent-ws" });

describe("agentService.startTurn", () => {
  let events: agentEvents.AgentEventHandler;
  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.exec(`
      INSERT INTO repositories (id, name, root_path) VALUES ('r', 'Project', '/repo');
      INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w', 'r', 'work', 'ready');
    `);
    db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, 'w')").run(SESSION);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockOpen.mockResolvedValue({
      startTurn: mockLinkStartTurn,
      cancelTurn: mockLinkCancelTurn,
      getAgents: () => [],
      isConnected: () => true,
      engine: { onAuthUpdated: () => () => {}, onCliProgress: () => () => {} },
      close: vi.fn().mockResolvedValue(undefined),
    });
    const createEvents = vi.spyOn(agentEvents, "createAgentEventHandler");
    await agentService.init();
    events = createEvents.mock.results[0]!.value;
  });

  afterEach(async () => {
    await agentService.shutdown();
    db.close();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("refuses an engine start whose chat was removed during the integration lookup", async () => {
    const run = operations([...sessionHandlers, ...workspaceHandlers, ...repoHandlers]);
    const lookup = Promise.withResolvers<TurnApps>();
    const apps = vi.spyOn(integrations, "resolveTurnApps").mockReturnValueOnce(lookup.promise);
    mockLinkStartTurn.mockResolvedValue({ sessionId: SESSION, turnId: TURN });

    const sending = start();
    expect(apps).toHaveBeenCalledOnce();
    await run(api.archiveWorkspace, { workspaceId: "w" });
    const confirmed = await run(api.repoRemoval, { repoId: "r" });
    await run(api.removeRepo, { repoId: "r", confirmed });
    expect(await run(api.session, { sessionId: SESSION })).toBeNull();

    const publish = vi.spyOn(streams, "publish");
    lookup.resolve({ servers: {}, skipped: [] });
    const [outcome] = await Promise.allSettled([sending]);
    expect.soft(mockLinkStartTurn).toHaveBeenCalledTimes(0);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { statusCode: 404, message: "This chat no longer exists." },
    });
    expect(publish.mock.calls.map(([stream]) => stream.name)).not.toContain(api.sessionEvents.name);
  });

  it("rolls the local turn back when the wire refuses admission", async () => {
    const begin = vi.spyOn(ownership, "wireTurn");
    const abort = vi.spyOn(ownership, "refuseTurn");
    const start = vi.spyOn(agentService, "startTurn");
    vi.spyOn(settings, "getSetting").mockImplementation((key) => key === "agent_messages");
    mockLinkStartTurn.mockRejectedValue(
      new WireRequestError(WIRE_ERROR_CODES.turnActive, "already has an active turn")
    );

    const sending = sendMessage({
      sessionId: SESSION,
      turnId: TURN,
      model: "opus",
      agentHarness: "claude-code",
      content: "hello",
    });
    await expect(sending).rejects.toMatchObject({ name: "ChatBusyError" });
    await expect(start.mock.results[0]?.value).rejects.toBeInstanceOf(WireRequestError);

    expect(begin).toHaveBeenCalledWith(SESSION, TURN);
    expect(abort).toHaveBeenCalledWith(SESSION, TURN);
    expect(await operations(sessionHandlers)(api.session, { sessionId: SESSION })).toMatchObject({
      agent_messages: true,
    });
  });

  it("keeps the local turn when admission succeeds", async () => {
    mockLinkStartTurn.mockResolvedValue({ sessionId: SESSION, turnId: TURN });

    const start = vi.spyOn(agentService, "startTurn");
    await sendMessage({
      sessionId: SESSION,
      turnId: TURN,
      model: "opus",
      agentHarness: "claude-code",
      content: "hello",
    });
    await expect(start.mock.results[0]?.value).resolves.toBeUndefined();

    expect(ownership.holdingTurn(SESSION)?.turnId).toBe(TURN);
  });

  it("pushes the recorded message tool to both reads before publishing the turn's first event", async () => {
    let enabled = true;
    const preference = vi
      .spyOn(settings, "getSetting")
      .mockImplementation((key) => (key === "agent_messages" ? enabled : null));
    const run = operations(sessionHandlers);
    const { id: siblingId } = await run(api.createSession, { workspaceId: "w" });
    const { id: sessionId } = await run(api.createSession, { workspaceId: "w" });
    serveOperations(new Registry(sessionHandlers));
    const frames: QServerFrame[] = [];
    const connection = addConnection(
      {
        send: (data) => frames.push(JSON.parse(String(data))),
        close: vi.fn(),
      },
      null
    );
    const subscribe = (resource: string, params: Record<string, string>) =>
      handleFrame(connection, { type: "q:subscribe", id: resource, resource, params });
    const snapshots = (hasTool: boolean) => {
      const chat = expect.objectContaining({ id: sessionId, agent_messages: hasTool });
      const sibling = expect.objectContaining({ id: siblingId, agent_messages: false });
      return [
        { type: "q:snapshot", id: "session", data: chat },
        { type: "q:snapshot", id: "sessions", data: expect.arrayContaining([chat, sibling]) },
      ];
    };
    try {
      subscribe("session", { sessionId });
      subscribe("sessions", { workspaceId: "w" });
      subscribe("sessionEvents", { sessionId });
      expect(frames).toEqual(expect.arrayContaining(snapshots(false)));
      expect(preference).not.toHaveBeenCalledWith("agent_messages");
      frames.length = 0;

      mockLinkStartTurn.mockImplementationOnce(() => {
        enabled = false;
        events.handle({
          sessionId,
          seq: 1,
          event: { type: "turn.started", sessionId, turnId: TURN, timestamp: Date.now() },
        });
      });
      await agentService.startTurn(sessionId, TURN, "claude-code", "hello", { cwd: "/tmp" });
      const firstEvent = frames.findIndex((frame) => frame.type === "q:event");
      expect(frames[firstEvent]).toMatchObject({
        id: "sessionEvents",
        data: { envelope: { event: { type: "turn.started" } } },
      });
      const beforeStart = frames.slice(0, firstEvent);
      for (const snapshot of snapshots(true)) {
        const updates = beforeStart.filter(
          (frame) => frame.type === "q:snapshot" && frame.id === snapshot.id
        );
        expect(updates.at(-1)).toMatchObject(snapshot);
      }
      expect(preference.mock.calls.filter(([key]) => key === "agent_messages")).toHaveLength(1);
    } finally {
      removeSubs(connection);
      removeConnection(connection);
    }
  });

  it.each(["claude-code", "codex-app-server"] as const)(
    "passes setup as it stands at the start of each %s turn",
    async (harness) => {
      const setup = vi.spyOn(projectEnvironment, "setupForTurn").mockReturnValueOnce({
        state: "running",
        command: "bun install",
        log: "/tmp/setup.log",
        statusFile: "/tmp/setup.status",
      });
      mockLinkStartTurn.mockResolvedValue({});
      const cwd = "/tmp/nonexistent-ws";
      for (const id of ["first", "next"])
        await agentService.startTurn(SESSION, id, harness, "hello", { cwd });
      expect(setup.mock.calls).toEqual([[SESSION], [SESSION]]);
      const [first, next] = mockLinkStartTurn.mock.calls;
      expect(first![0].config.systemPromptAppend).toContain("cat '/tmp/setup.status'");
      expect(next![0].config.systemPromptAppend).not.toContain("/tmp/setup.status");
    }
  );

  it("does NOT roll back a turn it never registered", async () => {
    ownership.claimTurn(SESSION, "earlier-turn");
    const abort = vi.spyOn(ownership, "refuseTurn");
    mockLinkStartTurn.mockRejectedValue(
      new WireRequestError(WIRE_ERROR_CODES.turnActive, "already has an active turn")
    );

    await expect(start()).rejects.toBeInstanceOf(WireRequestError);

    expect(abort).not.toHaveBeenCalled();
    expect(ownership.holdingTurn(SESSION)?.turnId).toBe("earlier-turn");
  });

  it("keeps a Codex turn's images: the app-server takes them", async () => {
    mockLinkStartTurn.mockResolvedValue({ sessionId: SESSION, turnId: TURN });
    const link = (await mockOpen.mock.results[0]!.value) as { getAgents: () => unknown };
    link.getAgents = () => [{ type: "codex-app-server", capabilities: { images: true } }];
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
    await agentService.startTurn(SESSION, TURN, "codex-app-server", JSON.stringify([image]), {
      cwd: "/tmp/nonexistent-ws",
    });
    const params = mockLinkStartTurn.mock.calls[0]![0];
    expect(params.config.harness).toBe("codex-app-server");
    expect(params.input).toEqual([image]);
  });
});
