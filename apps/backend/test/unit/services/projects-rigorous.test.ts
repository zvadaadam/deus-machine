/** Fault checks: real Project scheduler/store/event persistence and reconnecting wire.
 * The runtime is scripted; no provider process or real application is started. */
import fs from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LifecycleEvent } from "@zvada/agent-server/protocol";
import { SCHEMA_SQL } from "@shared/schema";

const { databasePath, getDatabase, invalidate } = vi.hoisted(() => ({
  databasePath: `${process.cwd()}/.context/projects-rigorous-${crypto.randomUUID()}/deus.db`,
  getDatabase: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase, DB_PATH: databasePath }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate }));
vi.mock("../../../src/services/ws.service", () => ({ broadcast: vi.fn() }));
vi.mock("../../../src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession: vi.fn(),
}));
vi.mock("../../../../agent-server/agents/core/checkpoint", () => ({ createCheckpoint: vi.fn() }));

import * as projects from "../../../src/services/projects/service";
import * as agentService from "../../../src/services/agent/service";
import type { AgentCreation } from "../../../src/services/projects/store";
import { AgentServer } from "../../../../agent-server/upstream-server";
import { bridgeWsConnection } from "../../../../agent-server/wire";

type Run = { sessionId: string; turnId: string; input: unknown };
type HeldRun = Run & { finish: (stopReason?: "end_turn" | "error") => Promise<void> };

describe("Project fault boundaries", () => {
  const root = path.dirname(databasePath);
  let db: Database.Database;
  let server: Server;
  let sockets: WebSocketServer;
  let wire: AgentServer;
  let connections = 0;
  const calls: Run[] = [];
  const held = new Map<string, HeldRun>();
  const unconfirmedStops = new Set<string>();
  const cancelCalls: string[] = [];

  function newWire() {
    return new AgentServer(
      {
        harnesses: ["claude-code"],
        capabilities: () => ({
          multiTurn: true,
          sessionResume: true,
          modelSwitch: "in-session",
          thinkingLevels: true,
          images: true,
          mcpServers: true,
          permissionRequests: false,
        }),
        admission: () => ({ status: "new" }),
        async run(run: Run, sink: { emit: (event: LifecycleEvent) => Promise<void> }) {
          calls.push(run);
          await sink.emit({ type: "turn.started", ...run, timestamp: Date.now() });
          await new Promise<void>((resolve) => {
            held.set(run.sessionId, {
              ...run,
              async finish(stopReason = "end_turn") {
                held.delete(run.sessionId);
                const ended: LifecycleEvent = {
                  type: "turn.ended",
                  ...run,
                  timestamp: Date.now(),
                  stopReason,
                  ...(stopReason === "error"
                    ? {
                        error: { category: "internal" as const, message: "Injected child failure" },
                      }
                    : {}),
                };
                await sink.emit(ended);
                await sink.emit(ended);
                resolve();
              },
            });
          });
        },
        async cancel(_harness: string, sessionId: string) {
          cancelCalls.push(sessionId);
          if (unconfirmedStops.has(sessionId)) return { confirmed: false, hadTurn: true };
          await held.get(sessionId)?.finish();
          return { confirmed: true, hadTurn: true };
        },
        async closeSession() {},
        respondPermission: () => false,
        async shutdown() {},
      } as never,
      { info: { name: "projects-rigorous-scripted-source" } }
    );
  }

  function ready(creation: AgentCreation) {
    db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)").run(
      creation.sessionId,
      creation.workspaceId
    );
    db.prepare("UPDATE workspaces SET state='ready', current_session_id=? WHERE id=?").run(
      creation.sessionId,
      creation.workspaceId
    );
    const store = projects.getProjectStore();
    store.complete(store.agent(creation.workspaceId).creation_operation_id, {
      agentId: creation.workspaceId,
    });
  }

  function createReady(name: string) {
    const creation: AgentCreation = {
      workspaceId: `${name}-agent`,
      sessionId: `${name}-session`,
      repositoryId: "repo",
      title: name,
      task: `Finish ${name}`,
      baseCommit: "a".repeat(40),
      sourceBranch: "main",
      coordinator: true,
    };
    const id = projects.getProjectStore().create(
      {
        requestId: `create-${name}`,
        title: name,
        brief: creation.task,
        repositoryId: "repo",
        model: "claude-opus-4-6",
        dispatchLimit: 20,
        concurrencyLimit: 2,
      },
      creation
    );
    ready(creation);
    return { id, creation };
  }

  async function flushScheduler() {
    invalidate.mockClear();
    projects.wakeProjects();
    // Disconnected passes return before changed(), so let their zero-delay wake run.
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  beforeAll(async () => {
    fs.mkdirSync(root, { recursive: true });
    db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    getDatabase.mockReturnValue(db);
    db.prepare(
      "INSERT INTO repositories(id,name,root_path,git_default_branch) VALUES('repo','Fixture',?,'main')"
    ).run(root);
    wire = newWire();
    server = createServer();
    sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => {
      connections++;
      bridgeWsConnection(socket, wire);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    agentService.init(`ws://127.0.0.1:${address.port}`);
    await vi.waitFor(() => expect(agentService.isConnected()).toBe(true));
    projects.startProjects();
  });

  afterAll(async () => {
    projects.stopProjects();
    await Promise.all([...held.values()].map((run) => run.finish()));
    agentService.shutdown();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("settles simultaneous successful/failed children once and consumes both outcomes once", async () => {
    const { id, creation } = createReady("concurrent-outcomes");
    const store = projects.getProjectStore();
    // Begin with a coordinator that already delegated its first instruction.
    store.settle(store.reserveDispatch(creation.workspaceId)!, { status: "completed" });
    const children = ["first", "second"].map((name) => {
      const child = {
        ...creation,
        workspaceId: `${name}-agent`,
        sessionId: `${name}-session`,
        title: name,
        coordinator: false,
      };
      store.reserveAgent(id, `create-${name}`, child);
      ready(child);
      return child;
    });
    await flushScheduler();
    await vi.waitFor(() => expect(children.every((child) => held.has(child.sessionId))).toBe(true));
    const runs = children.map((child) => held.get(child.sessionId)!);
    await Promise.all([runs[0].finish(), runs[1].finish("error")]);
    await vi.waitFor(() => expect(held.has(creation.sessionId)).toBe(true));
    const outcomeRows = db
      .prepare(
        "SELECT id,payload_json FROM project_inputs WHERE project_id=? AND kind='turn_outcome'"
      )
      .all(id) as { id: string; payload_json: string }[];
    expect(outcomeRows).toHaveLength(2);
    const outcomes = outcomeRows.map((row) => JSON.parse(JSON.parse(row.payload_json).message));
    expect(new Set(outcomes.map((outcome) => outcome.turnId))).toEqual(
      new Set(runs.map((run) => run.turnId))
    );
    expect(new Set(outcomes.map((outcome) => outcome.outcome.stopReason))).toEqual(
      new Set(["end_turn", "error"])
    );
    const dispatched = db
      .prepare("SELECT input_id FROM project_dispatch_inputs WHERE input_id IN (?,?)")
      .all(...outcomeRows.map((row) => row.id));
    expect(dispatched).toHaveLength(2);
    await held.get(creation.sessionId)!.finish();
    await vi.waitFor(() => expect(projects.getProject(id).activeAgentCount).toBe(0));
    expect(calls.filter((run) => run.sessionId === creation.sessionId)).toHaveLength(1);
    expect(projects.getProject(id).pendingInputCount).toBe(0);
  });

  it("wakes queued work after an idle real WebSocket reconnect without another user action", async () => {
    const { id, creation } = createReady("idle-reconnect");
    const store = projects.getProjectStore();
    store.settle(store.reserveDispatch(creation.workspaceId)!, { status: "completed" });
    const previousConnections = connections;
    for (const socket of sockets.clients) socket.terminate();
    await vi.waitFor(() => expect(agentService.isConnected()).toBe(false));
    projects.sendProjectInput(id, {
      requestId: "offline-input",
      message: "Run this after reconnect.",
    });
    await flushScheduler();
    expect(store.pendingInputs(creation.workspaceId)).toHaveLength(1);
    await vi.waitFor(
      () => {
        expect(connections).toBeGreaterThan(previousConnections);
        expect(agentService.isConnected()).toBe(true);
      },
      { timeout: 4_000 }
    );
    await vi.waitFor(() =>
      expect(calls.filter((run) => run.sessionId === creation.sessionId)).toHaveLength(1)
    );
    expect(store.pendingInputs(creation.workspaceId)).toHaveLength(0);
    await held.get(creation.sessionId)!.finish();
    await vi.waitFor(() => expect(projects.getProject(id).activeAgentCount).toBe(0));
  });

  it("records the active source-restart boundary and permits only explicit reconciliation", async () => {
    const { id, creation } = createReady("source-restart");
    await flushScheduler();
    await vi.waitFor(() => expect(held.has(creation.sessionId)).toBe(true));
    const interrupted = held.get(creation.sessionId)!;
    const previousConnections = connections;
    // Replace the actual wire server instance. Its fresh handshake changes instanceId.
    // The old model is intentionally held; no synthetic terminal is sent to the backend.
    wire = newWire();
    for (const socket of sockets.clients) socket.terminate();
    await vi.waitFor(
      () => {
        expect(connections).toBeGreaterThan(previousConnections);
        expect(agentService.isConnected()).toBe(true);
        expect(projects.getProject(id).agents[0].status).toBe("needs-attention");
      },
      { timeout: 4_000 }
    );
    projects.sendProjectInput(id, {
      requestId: "after-source-restart",
      message: "Continue after inspecting partial work.",
    });
    await flushScheduler();
    expect(calls.filter((run) => run.sessionId === creation.sessionId)).toHaveLength(1);
    expect(projects.getProject(id).activeAgentCount).toBe(1);
    expect(projects.getProjectStore().pendingInputs(creation.workspaceId)).toHaveLength(1);
    expect(() =>
      projects.controlProject(id, "retry", "retry-unreconciled", { agentId: creation.workspaceId })
    ).toThrow("reconcile");
    projects.controlProject(id, "pause", "reconcile-source-restart");
    await vi.waitFor(() => expect(projects.getProject(id).activeAgentCount).toBe(0));
    // The fake old model cannot represent an actual OS kill; dispose only after assertions.
    await interrupted.finish();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retries an unconfirmed stop while keeping queued input paused", async () => {
    const { id, creation } = createReady("retry-unconfirmed-stop");
    await flushScheduler();
    await vi.waitFor(() => expect(held.has(creation.sessionId)).toBe(true));
    const turnId = held.get(creation.sessionId)!.turnId;
    projects.sendProjectInput(id, {
      requestId: "queued-before-unconfirmed-stop",
      message: "Continue only after I resume the Project.",
    });
    unconfirmedStops.add(creation.sessionId);
    projects.controlProject(id, "pause", "first-unconfirmed-stop");
    await vi.waitFor(() => {
      const project = projects.getProject(id);
      expect(project.paused).toBe(true);
      expect(project.activeAgentCount).toBe(1);
      expect(project.agents[0].status).toBe("needs-attention");
      expect(project.error).toContain("Stop is not yet confirmed");
    });
    const firstAttempts = cancelCalls.filter(
      (sessionId) => sessionId === creation.sessionId
    ).length;
    expect(firstAttempts).toBeGreaterThan(0);
    expect(held.get(creation.sessionId)?.turnId).toBe(turnId);

    unconfirmedStops.delete(creation.sessionId);
    projects.controlProject(id, "pause", "retry-unconfirmed-stop");
    await vi.waitFor(() => expect(projects.getProject(id).activeAgentCount).toBe(0));
    expect(
      cancelCalls.filter((sessionId) => sessionId === creation.sessionId).length
    ).toBeGreaterThan(firstAttempts);
    expect(held.has(creation.sessionId)).toBe(false);
    expect(projects.getProject(id)).toMatchObject({ paused: true, pendingInputCount: 1 });
    expect(calls.filter((run) => run.sessionId === creation.sessionId)).toEqual([
      expect.objectContaining({ turnId }),
    ]);
    expect(db.prepare("SELECT closed_at FROM project_dispatches WHERE id=?").get(turnId)).toEqual({
      closed_at: expect.any(Number),
    });
  });

  it("keeps a definitively rejected dispatch queued until the prior native turn drains", async () => {
    const { id, creation } = createReady("busy-native-owner");
    projects.controlProject(id, "pause", "hold-busy-native-owner");
    await agentService.startTurn(
      creation.sessionId,
      "prior-native-turn",
      "claude-code",
      "Finish the previously admitted work.",
      { cwd: root, model: "claude-opus-4-6" }
    );
    await vi.waitFor(() => expect(held.has(creation.sessionId)).toBe(true));
    const previous = held.get(creation.sessionId)!;
    // A stop acknowledgment may precede the terminal event. The backend's
    // optimistic idle projection must not turn a wire rejection into lost work.
    db.prepare("UPDATE sessions SET status='idle' WHERE id=?").run(creation.sessionId);
    projects.controlProject(id, "resume", "resume-busy-native-owner");
    await vi.waitFor(() => {
      const dispatch = projects
        .getProjectStore()
        .openDispatches()
        .find((row) => row.project_id === id);
      expect(dispatch).toMatchObject({ phase: "prepared", closed_at: null, error: null });
      expect(projects.getProjectStore().agent(creation.workspaceId).session_status).toBe("working");
    });
    const dispatch = projects
      .getProjectStore()
      .openDispatches()
      .find((row) => row.project_id === id)!;
    expect(projects.getProject(id).agents[0].status).toBe("queued");
    await flushScheduler();
    expect(calls.filter((run) => run.sessionId === creation.sessionId)).toHaveLength(1);
    expect(
      projects
        .getProjectStore()
        .openDispatches()
        .find((row) => row.id === dispatch.id)?.phase
    ).toBe("prepared");

    await previous.finish();
    await vi.waitFor(() => expect(held.get(creation.sessionId)?.turnId).toBe(dispatch.id));
    expect(
      calls.filter((run) => run.sessionId === creation.sessionId).map((run) => run.turnId)
    ).toEqual(["prior-native-turn", dispatch.id]);
    expect(
      db.prepare("SELECT COUNT(*) n FROM project_dispatches WHERE project_id=?").get(id)
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM project_dispatch_inputs WHERE dispatch_id=?")
        .get(dispatch.id)
    ).toEqual({ n: 1 });
    await held.get(creation.sessionId)!.finish();
    await vi.waitFor(() => expect(projects.getProject(id).activeAgentCount).toBe(0));
  });
});
