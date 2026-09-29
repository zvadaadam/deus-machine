/** Real Project routes, SQLite, Git worktrees, scheduler, MCP relay and wire.
 * Only the model execution and unrelated frontend/PR side effects are replaced. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LifecycleEvent } from "@zvada/agent-server/protocol";
import type { ProjectDetail } from "@shared/projects";
import type { ProjectToolRequest } from "@shared/agent-side-channel";
import { SCHEMA_SQL } from "@shared/schema";

const { databasePath, getDatabase, invalidate } = vi.hoisted(() => ({
  databasePath: `${process.cwd()}/.context/projects-wire-${crypto.randomUUID()}/deus.db`,
  getDatabase: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase, DB_PATH: databasePath }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate }));
vi.mock("../../../src/services/ws.service", () => ({ broadcast: vi.fn() }));
vi.mock("../../../src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession: vi.fn(),
}));

import routes from "../../../src/routes/projects";
import * as projects from "../../../src/services/projects/service";
import * as agentService from "../../../src/services/agent/service";
import { prepareProjectWorkspace } from "../../../src/services/workspace-init.service";
import type { AgentCreation } from "../../../src/services/projects/store";
import { AppError } from "../../../src/lib/errors";
import { AgentServer } from "../../../../agent-server/upstream-server";
import { bridgeWsConnection, observeEvents } from "../../../../agent-server/wire";
import { HostRpc } from "../../../../agent-server/host-link";

type Sink = { emit: (event: LifecycleEvent) => void | Promise<void> };
type Run = {
  sessionId: string;
  turnId: string;
  input: unknown;
  config: { systemPromptAppend?: string };
};

describe("Local Project workflow across the execution wire", () => {
  const root = path.dirname(databasePath);
  const repository = path.join(root, "repository");
  let db: Database.Database;
  let server: Server;
  let sockets: WebSocketServer;
  let wire: AgentServer;
  const calls: Run[] = [];
  const invocations: Array<{ request: ProjectToolRequest; result: unknown }> = [];
  const scriptErrors: unknown[] = [];
  const held = new Map<string, () => void>();
  const heldProjectTitles = new Set(["Interrupted execution", "Paused before admission"]);
  const app = new Hono().route("/api", routes);
  app.onError((error, context) =>
    context.json(
      { error: error.message },
      (error instanceof AppError ? error.statusCode : 500) as ContentfulStatusCode
    )
  );

  async function invoke(
    run: Run,
    operation: ProjectToolRequest["operation"],
    args: Record<string, unknown>
  ) {
    const request: ProjectToolRequest = {
      sessionId: run.sessionId,
      turnId: run.turnId,
      toolCallId: crypto.randomUUID(),
      operation,
      args,
    };
    const result = await HostRpc.requestProjectTool(request);
    invocations.push({ request, result });
    return result;
  }

  async function text(run: Run, sink: Sink, role: "user" | "assistant", body: string) {
    const messageId = `${run.turnId}-${role}`;
    const timestamp = Date.now();
    await sink.emit({
      type: "message.started",
      ...run,
      messageId,
      outputIndex: role === "user" ? 0 : 1,
      role,
      timestamp,
    });
    await sink.emit({
      type: "message.part",
      ...run,
      messageId,
      outputIndex: role === "user" ? 0 : 1,
      partIndex: 0,
      part: {
        type: "text",
        id: `${messageId}-text`,
        sessionId: run.sessionId,
        messageId,
        text: body,
        state: "done",
      },
      timestamp,
    });
    await sink.emit({ type: "message.ended", ...run, messageId, timestamp });
  }

  async function execute(run: Run, sink: Sink) {
    calls.push(run);
    await sink.emit({ type: "turn.started", ...run, timestamp: Date.now() });
    await text(run, sink, "user", String(run.input));
    const store = projects.getProjectStore();
    const agent = store.sessionAgent(run.sessionId)!;
    const project = store.project(agent.project_id);
    if (project.title === "Failed model run") {
      await sink.emit({
        type: "turn.ended",
        ...run,
        stopReason: "error",
        error: { category: "internal", message: "Scripted provider failure." },
        timestamp: Date.now(),
      });
      return;
    }
    if (heldProjectTitles.has(project.title)) {
      await new Promise<void>((resolve) => held.set(run.sessionId, resolve));
      await sink.emit({
        type: "turn.ended",
        ...run,
        stopReason: "cancelled",
        timestamp: Date.now(),
      });
      return;
    }
    try {
      if (project.coordinator_agent_id === agent.agent_id) {
        const ordinal = calls.filter((call) => call.sessionId === run.sessionId).length;
        if (ordinal === 1) {
          await invoke(run, "publish_context", {
            mode: "publish",
            path: "plan.md",
            content: "Implement and test the requested component.",
            expectedRevision: 0,
          });
          await invoke(run, "create_agent", {
            title: "Implement component",
            task: "Implement the component and publish the test evidence.",
          });
          await text(run, sink, "assistant", "Implementation delegated; waiting for its result.");
        } else {
          const child = store
            .detail(project.id)
            .agents.find((entry) => entry.role === "contributor")!;
          const transcript = (await invoke(run, "read_agent_transcript", {
            agentId: child.id,
          })) as { transcript: string };
          expect(transcript.transcript).toContain("Component implemented and tested");
          await invoke(run, "report_result", {
            summary: "The requested component is ready for your review.",
          });
          await text(run, sink, "assistant", "The combined result is ready for your review.");
        }
      } else {
        const content = (await invoke(run, "publish_context", {
          mode: "read",
          path: "plan.md",
        })) as { content: string };
        expect(content.content).toContain("Implement and test");
        await invoke(run, "report_result", {
          summary: "Component implemented and tested",
          files: [{ path: "validation.md", content: "All component checks passed." }],
        });
        await text(run, sink, "assistant", "Component implemented and tested");
      }
    } catch (error) {
      scriptErrors.push(error);
      throw error;
    }
    const ended: LifecycleEvent = {
      type: "turn.ended",
      ...run,
      stopReason: "end_turn",
      timestamp: Date.now(),
    };
    await sink.emit(ended);
    await sink.emit(ended); // Duplicate source delivery must not schedule another follow-up.
  }

  async function request(method: string, url: string, body?: unknown): Promise<ProjectDetail> {
    const response = await app.request(`/api${url}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
    return result as ProjectDetail;
  }

  beforeAll(async () => {
    fs.mkdirSync(repository, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
    fs.writeFileSync(path.join(repository, "README.md"), "Local Project fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Project test",
        "-c",
        "user.email=project-test@example.invalid",
        "commit",
        "-m",
        "Initial fixture",
      ],
      { cwd: repository, stdio: "ignore" }
    );
    db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    getDatabase.mockReturnValue(db);
    db.prepare(
      "INSERT INTO repositories(id,name,root_path,git_default_branch) VALUES('repo','Fixture',?,'main')"
    ).run(repository);
    const runtime = {
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
      run: execute,
      admission: () => ({ status: "new" }),
      async cancel(_harness: string, sessionId: string) {
        const release = held.get(sessionId);
        if (release) {
          held.delete(sessionId);
          release();
        }
        return { confirmed: true, hadTurn: true };
      },
      async closeSession() {},
      respondPermission: () => false,
      async shutdown() {},
    };
    wire = new AgentServer(runtime as never, { info: { name: "project-test-engine" } });
    observeEvents(wire);
    server = createServer();
    sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => bridgeWsConnection(socket, wire));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Wire server did not bind");
    agentService.init(`ws://127.0.0.1:${address.port}`);
    await vi.waitFor(() => expect(agentService.isConnected()).toBe(true));
    projects.startProjects();
  });

  afterAll(async () => {
    projects.stopProjects();
    for (const release of held.values()) release();
    held.clear();
    agentService.shutdown();
    for (const socket of sockets?.clients ?? []) socket.terminate();
    sockets?.close();
    server?.close();
    await new Promise((resolve) => setImmediate(resolve));
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recovers prepared work, coordinates a child, publishes results, and deduplicates outcome wakes", async () => {
    projects.stopProjects();
    const created = await request("POST", "/projects", {
      requestId: "create-first",
      title: "Build component",
      brief: "Build and test the component.",
      repositoryId: "repo",
      model: "claude-opus-4-6",
      concurrencyLimit: 1,
      dispatchLimit: 8,
    });
    expect(created.status).toBe("preparing");
    expect(calls).toHaveLength(0);
    projects.startProjects();

    await vi.waitFor(
      () => {
        expect(scriptErrors).toEqual([]);
        const detail = projects.getProject(created.id);
        expect(detail.reports).toHaveLength(2);
        expect(detail.activeAgentCount).toBe(0);
      },
      { timeout: 10_000 }
    );
    const finished = await request("GET", `/projects/${created.id}`);
    expect(finished.agents).toHaveLength(2);
    expect(finished.dispatchCount).toBe(3);
    expect(finished.pendingInputCount).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0].input).toBe("Build and test the component.");
    expect(calls[0].config.systemPromptAppend).toContain("You are the coordinator of Deus Project");
    expect(
      String(calls.find((call) => call.sessionId !== finished.coordinatorSessionId)?.input)
    ).toContain(
      `from agent ${finished.coordinatorAgentId}; session ${finished.coordinatorSessionId}`
    );
    expect(finished.files.some((file) => file.path.endsWith("/validation.md"))).toBe(true);
    const coordinatorReport = finished.reports.find(
      (report) => report.agentId === finished.coordinatorAgentId
    )!;
    const accepted = await request(
      "POST",
      `/projects/${created.id}/reports/${coordinatorReport.id}/accept`,
      { requestId: "accept-result" }
    );
    expect(accepted.reports.find((report) => report.id === coordinatorReport.id)?.accepted).toBe(
      true
    );

    // A lost tool response may be retried after its source turn has ended.
    // Return the recorded receipt, but never run a changed or new stale request.
    const childReport = invocations.find(
      (invocation) =>
        invocation.request.operation === "report_result" &&
        invocation.request.args.summary === "Component implemented and tested"
    )!;
    await expect(HostRpc.requestProjectTool(childReport.request)).resolves.toEqual(
      childReport.result
    );
    await expect(
      HostRpc.requestProjectTool({ ...childReport.request, args: { summary: "Changed result" } })
    ).rejects.toThrow("different instructions");
    await expect(
      HostRpc.requestProjectTool({ ...childReport.request, toolCallId: "new-stale-invocation" })
    ).rejects.toThrow("inactive turn");
    expect(projects.getProject(created.id).reports).toHaveLength(2);
    expect(projects.getProject(created.id).dispatchCount).toBe(3);

    projects.stopProjects();
    projects.startProjects();
    await vi.waitFor(() => expect(projects.getProject(created.id).pendingInputCount).toBe(0));
    expect(projects.getProject(created.id).dispatchCount).toBe(3);
    expect(invalidate).toHaveBeenCalledWith(expect.arrayContaining(["project", "projects"]));

    await request("POST", `/projects/${created.id}/message`, {
      requestId: "follow-up-after-acceptance",
      message: "Document one additional usage example.",
    });
    await vi.waitFor(() => {
      const detail = projects.getProject(created.id);
      expect(detail.reports).toHaveLength(3);
      expect(detail.activeAgentCount).toBe(0);
    });
    const followedUp = projects.getProject(created.id);
    expect(followedUp.reports.find((report) => report.id === coordinatorReport.id)?.accepted).toBe(
      true
    );
    expect(
      followedUp.agents.find((agent) => agent.id === created.coordinatorAgentId)?.assignmentId
    ).not.toBe(coordinatorReport.assignmentId);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }, 15_000);

  it("rejects acceptance across queued work and preserves its assignment through resume", async () => {
    const created = await request("POST", "/projects", {
      requestId: "create-acceptance-boundary",
      title: "Acceptance boundary",
      brief: "Build and test a component.",
      repositoryId: "repo",
      model: "claude-opus-4-6",
      concurrencyLimit: 1,
      dispatchLimit: 8,
    });
    await vi.waitFor(() => {
      expect(scriptErrors).toEqual([]);
      expect(projects.getProject(created.id)).toMatchObject({ status: "ready", reportCount: 2 });
    });
    const firstReport = projects
      .getProject(created.id)
      .reports.find((report) => report.agentId === created.coordinatorAgentId)!;
    await request("POST", `/projects/${created.id}/pause`, { requestId: "pause-before-follow-up" });
    await request("POST", `/projects/${created.id}/message`, {
      requestId: "queued-before-acceptance",
      message: "Document one additional usage example.",
    });
    await expect(
      request("POST", `/projects/${created.id}/reports/${firstReport.id}/accept`, {
        requestId: "premature-acceptance",
      })
    ).rejects.toThrow("HTTP 409");
    expect(projects.getProject(created.id)).toMatchObject({
      paused: true,
      dispatchCount: 3,
      pendingMessageCount: 1,
    });
    expect(
      projects.getProject(created.id).reports.find((report) => report.id === firstReport.id)
        ?.accepted
    ).toBe(false);

    await request("POST", `/projects/${created.id}/resume`, { requestId: "resume-follow-up" });
    await vi.waitFor(() => {
      expect(scriptErrors).toEqual([]);
      expect(projects.getProject(created.id)).toMatchObject({
        status: "ready",
        reportCount: 3,
        dispatchCount: 4,
        pendingInputCount: 0,
      });
    });
    const nextReport = projects.getProject(created.id).reports[0];
    expect(nextReport.assignmentId).toBe(firstReport.assignmentId);
    const accepted = await request(
      "POST",
      `/projects/${created.id}/reports/${nextReport.id}/accept`,
      { requestId: "accept-finished-follow-up" }
    );
    expect(accepted.reports.find((report) => report.id === nextReport.id)?.accepted).toBe(true);
    expect(
      db
        .prepare(
          `SELECT i.id FROM project_inputs i JOIN project_dispatch_inputs di ON di.input_id=i.id
       JOIN project_dispatches d ON d.id=di.dispatch_id
       WHERE i.project_id=? AND i.assignment_id!=d.assignment_id`
        )
        .all(created.id)
    ).toEqual([]);
  });

  it("keeps an admitted turn uncertain after owner restart and reconciles a targeted stop", async () => {
    const created = await request("POST", "/projects", {
      requestId: "create-interrupted",
      title: "Interrupted execution",
      brief: "Wait for a decision.",
      repositoryId: "repo",
      model: "claude-opus-4-6",
    });
    await vi.waitFor(() => expect(projects.getProject(created.id).activeAgentCount).toBe(1));
    await vi.waitFor(() => expect(held.size).toBe(1));
    const count = calls.length;
    projects.stopProjects();
    projects.startProjects();
    expect(projects.getProject(created.id).status).toBe("needs-attention");
    expect(projects.getProject(created.id).dispatchCount).toBe(1);
    expect(calls).toHaveLength(count);

    await request("POST", `/projects/${created.id}/pause`, { requestId: "pause-interrupted" });
    await vi.waitFor(() => expect(projects.getProject(created.id).activeAgentCount).toBe(0));
    expect(projects.getProject(created.id).paused).toBe(true);
    expect(calls).toHaveLength(count);
    expect(scriptErrors).toEqual([]);
  }, 10_000);

  it("preserves a prepared dispatch and its inputs through Pause, then resumes that exact reservation", async () => {
    projects.stopProjects();
    const created = await request("POST", "/projects", {
      requestId: "create-prepared-pause",
      title: "Paused before admission",
      brief: "Prepare this work, then wait.",
      repositoryId: "repo",
      model: "claude-opus-4-6",
    });
    const store = projects.getProjectStore();
    const coordinator = store.agent(created.coordinatorAgentId!);
    const operation = store.operation(coordinator.creation_operation_id)!;
    await prepareProjectWorkspace(JSON.parse(operation.request_json) as AgentCreation);
    store.complete(operation.id, { agentId: coordinator.agent_id });
    const prepared = store.reserveDispatch(coordinator.agent_id)!;
    expect(prepared.phase).toBe("prepared");
    const count = calls.length;
    await request("POST", `/projects/${created.id}/agents/${coordinator.agent_id}/stop`, {
      requestId: "stop-individual-prepared",
    });
    await request("POST", `/projects/${created.id}/pause`, { requestId: "pause-prepared" });

    invalidate.mockClear();
    projects.startProjects();
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(store.openDispatches().find((dispatch) => dispatch.id === prepared.id)?.phase).toBe(
      "prepared"
    );
    expect(
      db
        .prepare("SELECT COUNT(*) count FROM project_dispatch_inputs WHERE dispatch_id=?")
        .get(prepared.id)
    ).toEqual({ count: 1 });
    expect(calls).toHaveLength(count);

    await request("POST", `/projects/${created.id}/resume`, { requestId: "resume-prepared" });
    invalidate.mockClear();
    projects.wakeProjects();
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(store.agent(coordinator.agent_id).paused_at).not.toBeNull();
    expect(calls).toHaveLength(count);
    await request("POST", `/projects/${created.id}/agents/${coordinator.agent_id}/resume`, {
      requestId: "resume-individual-prepared",
    });
    await vi.waitFor(() => expect(held.has(prepared.session_id)).toBe(true));
    expect(calls.at(-1)?.turnId).toBe(prepared.id);
    expect(projects.getProject(created.id).dispatchCount).toBe(1);

    await request("POST", `/projects/${created.id}/pause`, { requestId: "settle-prepared-test" });
    await vi.waitFor(() => expect(projects.getProject(created.id).activeAgentCount).toBe(0));

    await request("POST", `/projects/${created.id}/agents/${coordinator.agent_id}/retry`, {
      requestId: "retry-after-stop",
    });
    expect(store.pendingInputs(coordinator.agent_id)[0].payload_json).toContain(prepared.id);
    await request("POST", `/projects/${created.id}/resume`, { requestId: "resume-retry" });
    await vi.waitFor(() => expect(held.has(prepared.session_id)).toBe(true));
    expect(calls.at(-1)?.turnId).not.toBe(prepared.id);
    expect(projects.getProject(created.id).dispatchCount).toBe(2);
    await request("POST", `/projects/${created.id}/agents/${coordinator.agent_id}/retry`, {
      requestId: "retry-after-stop",
    });
    expect(projects.getProject(created.id).dispatchCount).toBe(2);
    expect(store.pendingInputs(coordinator.agent_id)).toHaveLength(0);
    await expect(
      request("POST", `/projects/${created.id}/agents/${coordinator.agent_id}/retry`, {
        requestId: "retry-while-running",
      })
    ).rejects.toThrow("Stop and reconcile");
    await request("POST", `/projects/${created.id}/pause`, { requestId: "settle-retry-test" });
    await vi.waitFor(() => expect(projects.getProject(created.id).activeAgentCount).toBe(0));
  }, 10_000);

  it("shows a terminal model failure as needing attention rather than a ready result", async () => {
    const created = await request("POST", "/projects", {
      requestId: "create-model-failure",
      title: "Failed model run",
      brief: "Complete the requested task.",
      repositoryId: "repo",
      model: "claude-opus-4-6",
    });
    await vi.waitFor(() => {
      const detail = projects.getProject(created.id);
      expect(detail.dispatchCount).toBe(1);
      expect(detail.activeAgentCount).toBe(0);
    });
    const failed = projects.getProject(created.id);
    expect(failed.status).toBe("needs-attention");
    expect(failed.agents[0].status).toBe("needs-attention");
    expect(failed.reports).toHaveLength(0);
    expect(failed.error).toContain("Scripted provider failure");
  });
});
