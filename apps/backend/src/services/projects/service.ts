import path from "node:path";
import { z } from "zod";
import { WireRequestError } from "@zvada/agent-server/client";
import { toolResultText, WIRE_ERROR_CODES, type Part } from "@zvada/agent-server/protocol";
import { ACTIVE_TURN_STATUSES } from "@shared/enums";
import { uuidv7 } from "@shared/lib/uuid";
import type {
  CreateProjectInput,
  ProjectAgentStatusResult,
  ProjectToolOperation,
  ProjectTranscriptResult,
} from "@shared/projects";
import { DB_PATH, getDatabase } from "../../lib/database";
import { ConflictError, ValidationError } from "../../lib/errors";
import { computeWorkspacePath } from "../../middleware/workspace-loader";
import { invalidate } from "../query-engine";
import { toEngineInput } from "../agent/run-config";
import { prepareProjectWorkspace, resolveProjectBaseCommit } from "../workspace-init.service";
import { ProjectContent } from "./content";
import {
  ProjectStore,
  fingerprint,
  requiredText,
  type AgentCreation,
  type DispatchRow,
  type InputRow,
  type ToolActor,
} from "./store";

let store: ProjectStore | undefined;
let wakeTimer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let stopped = true;
let rerun = false;
const preparing = new Set<string>();
const submitting = new Set<string>();

export function getProjectStore(): ProjectStore {
  return (store ??= new ProjectStore(
    getDatabase(),
    new ProjectContent(path.join(path.dirname(DB_PATH), "projects", "blobs"))
  ));
}
export function listProjects() {
  return getProjectStore().summaries();
}
export function getProject(id: string) {
  return getProjectStore().detail(id);
}
function changed(): void {
  invalidate(["projects", "project", "workspaces", "sessions", "stats"]);
}
export function wakeProjects(): void {
  if (stopped) return;
  if (running) {
    rerun = true;
    return;
  }
  if (wakeTimer) return;
  wakeTimer = setTimeout(() => {
    wakeTimer = undefined;
    void runProjects().catch((error) => console.error("[Projects] Recovery failed", error));
  }, 0);
}
export function startProjects(): void {
  stopped = false;
  const s = getProjectStore();
  // A lost request cannot be replayed merely because the process restarted.
  s.db
    .prepare(
      "UPDATE project_dispatches SET phase='uncertain',error='Execution interrupted. Pause to reconcile before continuing.' WHERE phase IN ('submitting','admitted') AND closed_at IS NULL"
    )
    .run();
  wakeProjects();
}
export function stopProjects(): void {
  stopped = true;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = undefined;
}

const CreateSchema = z.object({
  requestId: z.string().min(1).max(160),
  title: z.string().trim().min(1).max(160),
  /** Optional: without a brief the coordinator introduces itself and asks for the goal. */
  brief: z.string().trim().max(32000).default(""),
  repositoryId: z.string().min(1),
  model: z.string().trim().min(1).max(160),
  concurrencyLimit: z.number().int().min(1).max(8).default(2),
  dispatchLimit: z.number().int().min(1).max(1000).default(40),
});
export async function createProject(value: unknown) {
  const parsed = CreateSchema.safeParse(value);
  if (!parsed.success)
    throw new ValidationError(
      "Provide a title, local repository and Claude model.",
      parsed.error.flatten()
    );
  const input: CreateProjectInput = parsed.data;
  if (input.model.includes(":")) {
    if (!input.model.startsWith("claude-code:"))
      throw new ValidationError("Projects currently use Claude models.");
    input.model = input.model.slice("claude-code:".length);
  }
  const s = getProjectStore();
  const existing = s.db
    .prepare("SELECT id FROM projects WHERE creation_request_id=?")
    .get(input.requestId) as { id: string } | undefined;
  // Let the store check the full creation fingerprint on retries, before another Git operation.
  const base = existing
    ? { baseCommit: "", sourceBranch: "" }
    : await resolveProjectBaseCommit(input.repositoryId);
  const id = s.create(input, {
    workspaceId: uuidv7(),
    sessionId: uuidv7(),
    repositoryId: input.repositoryId,
    title: input.title,
    task: input.brief,
    coordinator: true,
    ...base,
  });
  changed();
  wakeProjects();
  return getProject(id);
}
export function sendProjectInput(
  projectId: string,
  args: { requestId: string; message: string; agentId?: string }
) {
  const s = getProjectStore(),
    p = s.project(projectId);
  const agentId = args.agentId ?? p.coordinator_agent_id!;
  const message = requiredText(args.message, "Message");
  const requestId = requiredText(args.requestId, "Request ID", 160);
  // The first human instruction to a coordinator that has no brief is the brief.
  if (agentId === p.coordinator_agent_id) s.adoptBrief(projectId, `${requestId}:brief`, message);
  const id = s.addInput(projectId, agentId, message, requestId, "human");
  const target = s.agent(agentId);
  if (target.current_session_id)
    s.db
      .prepare("UPDATE sessions SET last_user_message_at=? WHERE id=?")
      .run(new Date().toISOString(), target.current_session_id);
  changed();
  wakeProjects();
  return { inputId: id };
}
export async function routeProjectMessage(
  sessionId: string,
  params: Record<string, unknown>
): Promise<{ commandId: string } | null> {
  const s = getProjectStore(),
    a = s.sessionAgent(sessionId);
  if (!a) return null;
  if (a.current_session_id !== sessionId)
    throw new ConflictError("This is Project history. Open the current conversation.");
  const p = s.project(a.project_id);
  const model =
    typeof params.model === "string" ? params.model.replace(/^claude-code:/, "") : p.model;
  if (params.agentHarness !== "claude-code" || model !== p.model)
    throw new ConflictError("Project conversations use the model selected for this Project.");
  // The Project freezes its own execution policy. A generic chat command
  // must not acknowledge a requested policy that the scheduler cannot retain.
  const unsupported = [
    "permissionMode",
    "thinkingLevel",
    "maxTurns",
    "additionalDirectories",
    "resume",
    "resumeSessionAt",
  ].find((key) => params[key] !== undefined);
  if (unsupported)
    throw new ValidationError(`Project conversations do not support the ${unsupported} option.`);
  const message = requiredText(params.content, "Message");
  if (typeof toEngineInput(message) !== "string")
    throw new ValidationError("Project conversations currently accept plain text only.");
  const result = sendProjectInput(a.project_id, {
    requestId: typeof params.turnId === "string" ? params.turnId : uuidv7(),
    message,
    agentId: a.agent_id,
  });
  return { commandId: result.inputId };
}
export function assertProjectDispatch(
  sessionId: string,
  turnId: string,
  projectId: string,
  dispatchId: string
): void {
  const s = getProjectStore(),
    a = s.sessionAgent(sessionId),
    p = s.project(projectId);
  const d = s.db.prepare("SELECT * FROM project_dispatches WHERE id=?").get(dispatchId) as
    | DispatchRow
    | undefined;
  if (
    !a ||
    a.project_id !== projectId ||
    a.current_session_id !== sessionId ||
    !d ||
    d.id !== turnId ||
    d.session_id !== sessionId ||
    d.agent_id !== a.agent_id ||
    d.generation !== a.conversation_generation ||
    d.closed_at !== null ||
    d.phase !== "submitting" ||
    p.paused_at !== null ||
    a.paused_at !== null ||
    p.lifecycle !== "active"
  )
    throw new ConflictError("This Project turn is no longer eligible to start.");
}
export async function routeProjectStop(sessionId: string): Promise<boolean> {
  const s = getProjectStore(),
    a = s.sessionAgent(sessionId);
  if (!a) return false;
  if (a.current_session_id !== sessionId)
    throw new ConflictError("Historical Project conversations cannot control current execution.");
  controlProject(a.project_id, "stop", uuidv7(), { agentId: a.agent_id });
  return true;
}

export function controlProject(
  projectId: string,
  action:
    | "pause"
    | "resume"
    | "stop"
    | "archive"
    | "limits"
    | "accept"
    | "retry"
    | "resume_agent"
    | "cancel_input",
  requestId: string,
  args: { agentId?: string; dispatchLimit?: number; reportId?: string; inputId?: string } = {}
) {
  const s = getProjectStore();
  requiredText(requestId, "Request ID", 160);
  s.db.transaction(() => {
    const old = s.existingOperation(requestId, projectId, action, args);
    if (old?.state === "succeeded") return;
    const p = s.project(projectId);
    s.beginOperation(requestId, projectId, action, args, args.agentId ?? null);
    if (action === "cancel_input") {
      if (p.lifecycle !== "active") throw new ConflictError("This Project is archived.");
      const input = s.db
        .prepare("SELECT * FROM project_inputs WHERE project_id=? AND id=?")
        .get(projectId, args.inputId) as (InputRow & { superseded_at: number | null }) | undefined;
      if (!input || input.origin !== "human")
        throw new ValidationError("Choose a queued human message in this Project.");
      if (s.db.prepare("SELECT 1 FROM project_dispatch_inputs WHERE input_id=?").get(input.id))
        throw new ConflictError(
          "This message has already been dispatched and cannot be cancelled."
        );
      const agent = s.agent(input.agent_id);
      if (
        input.superseded_at !== null ||
        input.session_id !== agent.current_session_id ||
        input.generation !== agent.conversation_generation
      )
        throw new ConflictError("This message is no longer queued for the current conversation.");
      s.db
        .prepare("UPDATE project_inputs SET superseded_at=? WHERE id=?")
        .run(Date.now(), input.id);
    }
    if (action === "pause" || action === "archive")
      s.db
        .prepare(
          "UPDATE projects SET paused_at=?,pause_revision=pause_revision+1,lifecycle=? WHERE id=?"
        )
        .run(Date.now(), action === "archive" ? "archived" : p.lifecycle, projectId);
    if (action === "resume") {
      if (p.lifecycle === "archived") throw new ConflictError("This Project is archived.");
      s.db
        .prepare("UPDATE projects SET paused_at=NULL,pause_revision=pause_revision+1 WHERE id=?")
        .run(projectId);
    }
    if (action === "resume_agent") {
      if (!args.agentId || s.agent(args.agentId).project_id !== projectId)
        throw new ValidationError("Choose an Agent in this Project.");
      s.db.prepare("UPDATE project_agents SET paused_at=NULL WHERE agent_id=?").run(args.agentId);
    }
    if (action === "stop") {
      if (!args.agentId || s.agent(args.agentId).project_id !== projectId)
        throw new ValidationError("Choose an Agent in this Project.");
      s.db
        .prepare("UPDATE project_agents SET paused_at=? WHERE agent_id=?")
        .run(Date.now(), args.agentId);
    }
    if (action === "limits") {
      const limit = args.dispatchLimit;
      if (!Number.isInteger(limit) || !limit || limit < 1 || limit > 1000)
        throw new ValidationError("Turn allowance must be between 1 and 1000.");
      s.db.prepare("UPDATE projects SET dispatch_limit=? WHERE id=?").run(limit, projectId);
    }
    if (action === "accept") {
      const report = s.db
        .prepare(
          "SELECT assignment_id,session_id,turn_id FROM project_reports WHERE project_id=? AND id=?"
        )
        .get(projectId, args.reportId) as
        | { assignment_id: string; session_id: string; turn_id: string }
        | undefined;
      if (!report) throw new ValidationError("Report not found.");
      const d = s.db
        .prepare(
          "SELECT closed_at,outcome_json FROM project_dispatches WHERE id=? AND session_id=?"
        )
        .get(report.turn_id, report.session_id) as
        | { closed_at: number | null; outcome_json: string | null }
        | undefined;
      if (!d?.closed_at)
        throw new ConflictError(
          "Wait for the reporting agent to finish before accepting its result."
        );
      const unfinished = s.db
        .prepare(
          `SELECT 1 FROM project_dispatches WHERE assignment_id=? AND closed_at IS NULL
           UNION ALL
           SELECT 1 FROM project_inputs i WHERE i.assignment_id=? AND i.superseded_at IS NULL
             AND NOT EXISTS(SELECT 1 FROM project_dispatch_inputs di WHERE di.input_id=i.id)
           LIMIT 1`
        )
        .get(report.assignment_id, report.assignment_id);
      if (unfinished)
        throw new ConflictError(
          "This assignment still has queued or running work. Finish or cancel it before accepting a result."
        );
      s.db
        .prepare("UPDATE project_assignments SET state='accepted',accepted_report_id=? WHERE id=?")
        .run(args.reportId, report.assignment_id);
    }
    if (action === "retry") {
      if (!args.agentId || s.agent(args.agentId).project_id !== projectId)
        throw new ValidationError("Choose an Agent in this Project.");
      const a = s.agent(args.agentId);
      const creation = s.operation(a.creation_operation_id);
      if (creation?.state === "failed") {
        s.db
          .prepare("UPDATE project_operations SET state='pending',error=NULL WHERE id=?")
          .run(a.creation_operation_id);
      } else {
        if (s.openDispatches().some((d) => d.agent_id === a.agent_id))
          throw new ConflictError("Stop and reconcile the current turn before retrying.");
        if (s.pendingInputs(a.agent_id, s.assignment(a.agent_id).id).length)
          throw new ConflictError("This Agent already has queued work. Resume it to continue.");
        const last = s.db
          .prepare(
            "SELECT id FROM project_dispatches WHERE agent_id=? AND closed_at IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1"
          )
          .get(a.agent_id) as { id: string } | undefined;
        if (!last) throw new ConflictError("This Agent has no previous turn to retry.");
        s.addInput(
          projectId,
          a.agent_id,
          `Continue your current assignment after turn ${last.id}. Inspect the existing files and transcript before repeating any side effects. Finish the requested work and report the result.`,
          `retry:${requestId}`,
          "human"
        );
        s.db.prepare("UPDATE project_agents SET paused_at=NULL WHERE agent_id=?").run(a.agent_id);
      }
    }
    s.complete(requestId, {});
    s.touch(projectId);
  })();
  changed();
  wakeProjects();
  return getProject(projectId);
}
export function readProjectFile(projectId: string, filePath: string, revision?: number) {
  const s = getProjectStore(),
    version = revision ?? s.project(projectId).content_head_revision;
  const manifest = s.manifest(projectId, version),
    name = s.content.validatePath(filePath);
  if (!Object.hasOwn(manifest, name)) throw new ValidationError("Project file not found.");
  const entry = manifest[name];
  return { path: filePath, content: s.content.read(entry), revision: version };
}
export function publishProjectFile(
  projectId: string,
  args: { requestId: string; path: string; content: string; expectedRevision: number }
) {
  const s = getProjectStore();
  if (s.project(projectId).lifecycle !== "active")
    throw new ConflictError("This Project is archived.");
  const revision = s.publish(
    projectId,
    requiredText(args.requestId, "Request ID", 160),
    [{ path: args.path, content: args.content }],
    args.expectedRevision
  );
  changed();
  return { revision };
}

const EnvelopeSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1).max(160),
  operation: z.enum([
    "create_agent",
    "get_agent_status",
    "read_agent_transcript",
    "send_to_agent",
    "report_result",
    "stop_agent",
    "publish_context",
  ]),
  args: z.record(z.string(), z.unknown()),
});
function toolSource(actor: ToolActor) {
  const s = getProjectStore(),
    a = s.sessionAgent(actor.sessionId);
  if (!a || a.current_session_id !== actor.sessionId)
    throw new ConflictError("Project tools require the current managed conversation.");
  const d = s.db
    .prepare("SELECT * FROM project_dispatches WHERE id=? AND session_id=?")
    .get(actor.turnId, actor.sessionId) as DispatchRow | undefined;
  if (
    !d ||
    d.closed_at !== null ||
    !["submitting", "admitted"].includes(d.phase) ||
    d.generation !== a.conversation_generation
  )
    throw new ConflictError("This Project tool invocation belongs to an inactive turn.");
  return { s, a, p: s.project(a.project_id) };
}
export function handleProjectTool(value: unknown): unknown {
  const parsed = EnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid Project tool request.");
  const envelope = parsed.data;
  if (
    envelope.operation === "get_agent_status" ||
    envelope.operation === "read_agent_transcript" ||
    (envelope.operation === "publish_context" &&
      ["list", "read"].includes(String(envelope.args.mode)))
  )
    return executeProjectTool(envelope);
  const s = getProjectStore(),
    a = s.sessionAgent(envelope.sessionId);
  if (!a) throw new ConflictError("Project tools require a managed conversation.");
  const invocationId = `tool:${fingerprint({ sessionId: envelope.sessionId, turnId: envelope.turnId, toolCallId: envelope.toolCallId })}`;
  const old = s.existingOperation(invocationId, a.project_id, "tool_invocation", envelope);
  if (old?.receipt_json) return JSON.parse(old.receipt_json);
  toolSource(envelope);
  return s.db.transaction(() => {
    s.beginOperation(invocationId, a.project_id, "tool_invocation", envelope, a.agent_id, envelope);
    const result = executeProjectTool({ ...envelope, toolCallId: `${invocationId}:effect` });
    s.complete(invocationId, result);
    return result;
  })();
}
function executeProjectTool(envelope: z.infer<typeof EnvelopeSchema>): unknown {
  const { sessionId, turnId, toolCallId, operation, args } = envelope,
    actor = { sessionId, turnId };
  const { s, a, p } = toolSource(actor),
    isCoordinator = p.coordinator_agent_id === a.agent_id;
  const targetId =
    args.agentId === "coordinator"
      ? p.coordinator_agent_id
      : typeof args.agentId === "string"
        ? args.agentId
        : a.agent_id;
  const target = targetId ? s.agent(targetId) : a;
  if (target.project_id !== p.id) throw new ConflictError("Agent is outside this Project.");
  const coordinatorOnly = (op: ProjectToolOperation) => {
    if (!isCoordinator) throw new ConflictError(`${op} is only available to the coordinator.`);
  };
  if (operation === "get_agent_status") {
    const workspaces = s.db
      .prepare(
        `SELECT w.id,w.kind,w.slug,w.git_branch,r.root_path FROM project_agents a
         JOIN workspaces w ON w.id=a.agent_id JOIN repositories r ON r.id=w.repository_id
         WHERE a.project_id=?`
      )
      .all(p.id) as Array<{
      id: string;
      kind: string;
      slug: string;
      git_branch: string | null;
      root_path: string;
    }>;
    const executions = new Map(
      workspaces.map((workspace) => {
        const workspacePath = computeWorkspacePath(workspace);
        return [
          workspace.id,
          workspacePath
            ? { kind: "local" as const, workspacePath, branch: workspace.git_branch }
            : null,
        ];
      })
    );
    return {
      agents: s
        .detail(p.id)
        .agents.filter((x) =>
          isCoordinator ? !args.agentId || x.id === target.agent_id : x.id === a.agent_id
        )
        .map((agent) => ({ ...agent, execution: executions.get(agent.id) ?? null })),
      remainingTurns: Math.max(0, p.dispatch_limit - s.dispatchCount(p.id)),
    } satisfies ProjectAgentStatusResult;
  }
  if (operation === "read_agent_transcript") {
    if (!isCoordinator && target.agent_id !== a.agent_id)
      throw new ConflictError("Contributors can read their own transcript.");
    const limit = args.limit === undefined ? 20 : args.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ValidationError("Transcript limit must be an integer between 1 and 100.");
    let beforeSeq: number | null = null;
    if (args.beforeMessageId !== undefined) {
      const cursor = s.db
        .prepare("SELECT seq FROM messages WHERE session_id=? AND id=?")
        .get(
          target.current_session_id,
          requiredText(args.beforeMessageId, "Transcript cursor", 160)
        ) as { seq: number } | undefined;
      if (!cursor) throw new ValidationError("Transcript cursor is outside this conversation.");
      beforeSeq = cursor.seq;
    }
    const messages = s.db
      .prepare(
        `SELECT id,role,turn_id FROM messages WHERE session_id=? ${beforeSeq === null ? "" : "AND seq<?"}
         ORDER BY seq DESC LIMIT ?`
      )
      .all(target.current_session_id, ...(beforeSeq === null ? [] : [beforeSeq]), limit + 1) as {
      id: string;
      role: string;
      turn_id: string | null;
    }[];
    const selected = messages.slice(0, limit),
      ids = selected.map((x) => x.id);
    const parts = ids.length
      ? (s.db
          .prepare(
            `SELECT message_id,data FROM parts WHERE message_id IN (${ids.map(() => "?").join(",")}) AND type IN ('text','tool') ORDER BY seq`
          )
          .all(...ids) as { message_id: string; data: string }[])
      : [];
    const byMessage = new Map<string, Part[]>();
    for (const row of parts) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push(JSON.parse(row.data) as Part);
      byMessage.set(row.message_id, list);
    }
    let abbreviated = false;
    const excerpt = (text: string, max: number): string => {
      if (text.length <= max) return text;
      abbreviated = true;
      return `${text.slice(0, max - 14)}\n[abbreviated]`;
    };
    const page: string[] = [];
    let pageSize = 0;
    for (const message of selected) {
      const content = (byMessage.get(message.id) ?? [])
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type !== "tool") return "";
          const input =
            part.state.status === "pending"
              ? part.state.partialInput
              : JSON.stringify(part.state.input);
          const result = toolResultText(part.state);
          return `[tool ${part.toolName}; ${part.state.status}]\ninput: ${excerpt(input, 1000)}${
            result
              ? `\n${part.state.status === "failed" ? "error" : "output"}: ${excerpt(result, 2000)}`
              : ""
          }`;
        })
        .filter(Boolean)
        .join("\n");
      const row = excerpt(
        `[${message.role}; message ${message.id}; turn ${message.turn_id ?? "unknown"}]\n${content || "[No text or tool activity recorded.]"}`,
        12000
      );
      // Keep whole message rows so the older-page cursor never skips a row
      // merely because a newer page reached its character budget.
      if (pageSize + row.length + (page.length ? 2 : 0) > 48000) break;
      pageSize += row.length + (page.length ? 2 : 0);
      page.push(row);
    }
    const hasMore = messages.length > page.length;
    return {
      sessionId: target.current_session_id,
      transcript: page.reverse().join("\n\n"),
      truncated: hasMore || abbreviated,
      nextBeforeMessageId: hasMore ? selected[page.length - 1].id : null,
    } satisfies ProjectTranscriptResult;
  }
  if (p.lifecycle !== "active" || p.paused_at !== null || a.paused_at !== null)
    throw new ConflictError("Project execution is paused.");
  if (operation === "create_agent") {
    coordinatorOnly(operation);
    const repositoryId =
      typeof args.repositoryId === "string" ? args.repositoryId : p.repository_id;
    if (repositoryId !== p.repository_id)
      throw new ValidationError("This local version creates agents in the Project's repository.");
    const parentCreation = JSON.parse(
      s.operation(a.creation_operation_id)!.request_json
    ) as AgentCreation;
    const existing = s.operation(toolCallId);
    const saved = existing ? (JSON.parse(existing.request_json) as AgentCreation) : undefined;
    const creation: AgentCreation = {
      workspaceId: saved?.workspaceId ?? uuidv7(),
      sessionId: saved?.sessionId ?? uuidv7(),
      repositoryId,
      title: requiredText(args.title, "Agent title", 160),
      task: requiredText(args.task, "Assignment"),
      baseCommit: parentCreation.baseCommit,
      sourceBranch: parentCreation.sourceBranch,
      coordinator: false,
    };
    const agentId = s.reserveAgent(p.id, toolCallId, creation, actor);
    changed();
    wakeProjects();
    return { agentId, preparing: true };
  }
  if (operation === "send_to_agent") {
    if (!isCoordinator && target.agent_id !== p.coordinator_agent_id)
      throw new ConflictError("Contributors send guidance requests to the coordinator.");
    const kind = args.kind === undefined ? "message" : requiredText(args.kind, "Message kind", 20);
    if (!["message", "question", "reply"].includes(kind))
      throw new ValidationError("Unsupported message kind.");
    const inputId = s.addInput(
      p.id,
      target.agent_id,
      requiredText(args.message, "Message"),
      `tool:${toolCallId}`,
      "agent",
      actor,
      kind,
      typeof args.replyTo === "string" ? args.replyTo : undefined
    );
    changed();
    wakeProjects();
    return { inputId, delivery: "next_turn" };
  }
  if (operation === "stop_agent") {
    coordinatorOnly(operation);
    controlProject(p.id, "stop", toolCallId, { agentId: target.agent_id });
    return { agentId: target.agent_id, stopping: true };
  }
  if (operation === "publish_context") {
    if (args.mode === "list")
      return { revision: p.content_head_revision, files: Object.values(s.manifest(p.id)) };
    if (args.mode === "read") return readProjectFile(p.id, requiredText(args.path, "Path", 240));
    coordinatorOnly(operation);
    if (
      args.mode !== "publish" ||
      typeof args.content !== "string" ||
      !Number.isInteger(args.expectedRevision)
    )
      throw new ValidationError("Publish requires path, text content and expectedRevision.");
    const filePath = requiredText(args.path, "Path", 240);
    if (filePath.startsWith("results/"))
      throw new ValidationError("Use report_result to publish result artifacts.");
    return publishProjectFile(p.id, {
      requestId: toolCallId,
      path: filePath,
      content: args.content,
      expectedRevision: args.expectedRevision as number,
    });
  }
  const report = z
    .object({
      summary: z.string().trim().min(1).max(16000),
      files: z
        .array(z.object({ path: z.string().min(1).max(200), content: z.string().max(256 * 1024) }))
        .max(24)
        .default([]),
      pullRequests: z.array(z.string().url().max(2048)).max(24).default([]),
    })
    .safeParse(args);
  if (!report.success)
    throw new ValidationError("Report requires a summary and optional text files/PR URLs.");
  for (const url of report.data.pullRequests) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new ValidationError("PR links must use HTTP or HTTPS.");
  }
  const reportId = s.report(
    a.agent_id,
    actor,
    toolCallId,
    report.data.summary,
    report.data.files,
    report.data.pullRequests
  );
  changed();
  return { reportId };
}

async function runProjects(): Promise<void> {
  if (running || stopped) return;
  running = true;
  rerun = false;
  try {
    const s = getProjectStore();
    // Recovery reads committed source outcomes; callback delivery is only a wake hint.
    for (const d of s.openDispatches()) {
      const turn = s.db
        .prepare("SELECT ended_at,outcome FROM turns WHERE session_id=? AND turn_id=?")
        .get(d.session_id, d.id) as { ended_at: number | null; outcome: string | null } | undefined;
      if (turn?.ended_at)
        s.settle(d, turn.outcome ? JSON.parse(turn.outcome) : { status: "completed" });
    }
    const creations = s.pendingCreations();
    for (const op of creations) {
      if (preparing.has(op.id)) continue;
      const p = s.project(op.project_id);
      if (p.paused_at !== null || p.lifecycle !== "active") continue;
      if (op.target_agent_id && s.agent(op.target_agent_id).paused_at !== null) continue;
      const preparingInProject = creations.filter(
        (candidate) => candidate.project_id === p.id && preparing.has(candidate.id)
      ).length;
      if (preparing.size >= 8 || preparingInProject >= p.concurrency_limit) continue;
      preparing.add(op.id);
      void prepareProjectWorkspace(JSON.parse(op.request_json) as AgentCreation)
        .then(() => {
          s.complete(op.id, { agentId: op.target_agent_id });
          s.touch(op.project_id);
        })
        .catch((error) => {
          s.fail(op.id, error instanceof Error ? error.message : String(error));
          s.touch(op.project_id);
        })
        .finally(() => {
          preparing.delete(op.id);
          changed();
          wakeProjects();
        });
    }
    const agentService = await import("../agent/service");
    if (!agentService.isConnected()) return;
    const commands = await import("../agent/commands");
    for (const d of s.openDispatches()) {
      const p = s.project(d.project_id),
        a = s.agent(d.agent_id);
      if (
        (p.paused_at !== null || a.paused_at !== null || p.lifecycle !== "active") &&
        !submitting.has(d.id)
      ) {
        if (d.phase === "prepared") {
          // Reserved but never sent: keep the same dispatch for explicit Resume.
          continue;
        }
        try {
          const result = await commands.stopProjectSession(d.session_id, d.id);
          if (
            result.outcome === "cancelled" ||
            (result.outcome === "no_active_turn" && !result.activeTurnId)
          )
            s.settle(d, { status: "cancelled", reason: "Project stopped" });
          else
            s.db
              .prepare(
                "UPDATE project_dispatches SET phase='uncertain',error=? WHERE id=? AND closed_at IS NULL"
              )
              .run("Stop is not yet confirmed; execution may still be running.", d.id);
        } catch (error) {
          s.db
            .prepare(
              "UPDATE project_dispatches SET phase='uncertain',error=? WHERE id=? AND closed_at IS NULL"
            )
            .run(String(error), d.id);
        }
      }
    }
    const agents = s.db
      .prepare("SELECT agent_id FROM project_agents ORDER BY created_at")
      .all() as { agent_id: string }[];
    const preparedByAgent = new Map(
      s
        .openDispatches()
        .filter((d) => d.phase === "prepared")
        .map((d) => [d.agent_id, d])
    );
    for (const { agent_id } of agents) {
      if (stopped) break;
      const existing = preparedByAgent.get(agent_id);
      const d = existing ?? s.reserveDispatch(agent_id);
      if (!d || d.phase !== "prepared") continue;
      const p = s.project(d.project_id),
        a = s.agent(d.agent_id);
      if (p.paused_at !== null || a.paused_at !== null || p.lifecycle !== "active") continue;
      // A confirmed stop can precede the native terminal. Keep the next turn
      // reserved until that owner drains; the terminal event wakes us again.
      if (ACTIVE_TURN_STATUSES.some((status) => status === a.session_status)) continue;
      const request = JSON.parse(d.request_json) as {
        prompt: string;
        systemPromptAppend: string;
        model: string;
        maxTurns: number;
      };
      const claimed = s.db
        .prepare(
          "UPDATE project_dispatches SET phase='submitting' WHERE id=? AND phase='prepared' AND closed_at IS NULL"
        )
        .run(d.id);
      if (!claimed.changes) continue;
      submitting.add(d.id);
      changed();
      try {
        await commands.sendProjectMessage(
          {
            sessionId: d.session_id,
            turnId: d.id,
            content: request.prompt,
            model: request.model,
            agentHarness: "claude-code",
            maxTurns: request.maxTurns,
          },
          {
            projectId: d.project_id,
            dispatchId: d.id,
            systemPromptAppend: request.systemPromptAppend,
          }
        );
        s.db
          .prepare(
            "UPDATE project_dispatches SET phase='admitted',admitted_at=? WHERE id=? AND closed_at IS NULL"
          )
          .run(Date.now(), d.id);
      } catch (error) {
        if (error instanceof WireRequestError && error.code === WIRE_ERROR_CODES.turnActive) {
          // The source rejected admission: the same saved input and dispatch
          // may run after its prior owner ends. A lost ACK remains uncertain.
          s.db
            .prepare(
              "UPDATE project_dispatches SET phase='prepared',error=NULL WHERE id=? AND closed_at IS NULL"
            )
            .run(d.id);
        } else {
          s.db
            .prepare(
              "UPDATE project_dispatches SET phase='uncertain',error=? WHERE id=? AND closed_at IS NULL"
            )
            .run(error instanceof Error ? error.message : String(error), d.id);
        }
      } finally {
        submitting.delete(d.id);
        s.touch(p.id);
      }
    }
    changed();
  } finally {
    running = false;
    if (rerun && !stopped) wakeProjects();
  }
}
