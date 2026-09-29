import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { uuidv7 } from "@shared/lib/uuid";
import { formatProjectPrompt } from "@shared/project-prompt";
import type {
  CreateProjectInput,
  ProjectAgent,
  ProjectDetail,
  ProjectReport,
  ProjectSummary,
} from "@shared/projects";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { ProjectContent, type ContentManifest } from "./content";
import { roleInstructions, welcomeInstruction } from "./instructions";
import { captureReportPullRequests, queryProjectPullRequests } from "./pull-requests";

export interface ProjectRow {
  id: string;
  title: string;
  repository_id: string;
  coordinator_agent_id: string | null;
  model: string;
  lifecycle: "active" | "archived";
  paused_at: number | null;
  pause_revision: number;
  dispatch_limit: number;
  concurrency_limit: number;
  revision: number;
  content_head_revision: number;
  created_at: number;
  updated_at: number;
}
export interface AgentRow {
  agent_id: string;
  project_id: string;
  creation_operation_id: string;
  paused_at: number | null;
  current_session_id: string | null;
  conversation_generation: number;
  title: string;
  state: string;
  session_status: string | null;
  error_message: string | null;
}
export interface DispatchRow {
  id: string;
  project_id: string;
  agent_id: string;
  session_id: string;
  generation: number;
  assignment_id: string;
  request_json: string;
  content_revision: number;
  phase: "prepared" | "submitting" | "admitted" | "finished" | "uncertain" | "revoked";
  outcome_json: string | null;
  error: string | null;
  closed_at: number | null;
}
export interface OperationRow {
  id: string;
  project_id: string;
  kind: string;
  target_agent_id: string | null;
  request_hash: string;
  request_json: string;
  state: "pending" | "succeeded" | "failed";
  receipt_json: string | null;
  error: string | null;
}
export interface AgentCreation {
  workspaceId: string;
  sessionId: string;
  repositoryId: string;
  title: string;
  task: string;
  baseCommit: string;
  sourceBranch: string;
  coordinator: boolean;
}
export interface InputRow {
  id: string;
  agent_id: string;
  session_id: string;
  generation: number;
  assignment_id: string;
  kind: string;
  origin: "human" | "agent" | "system";
  source_session_id: string | null;
  source_turn_id: string | null;
  payload_json: string;
  resolved_by: string | null;
}
export interface ToolActor {
  sessionId: string;
  turnId: string;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)])
    );
  return value;
}
export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export function requiredText(value: unknown, name: string, max = 32000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ValidationError(`${name} is required (maximum ${max} characters).`);
  return value.trim();
}

/** Synchronous metadata transactions; runtime requests are never awaited inside them. */
export class ProjectStore {
  constructor(
    readonly db: Database.Database,
    readonly content: ProjectContent,
    private readonly now = Date.now
  ) {}

  project(id: string): ProjectRow {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    if (!row) throw new NotFoundError("Project not found.");
    return row;
  }
  agent(id: string): AgentRow {
    const row = this.db
      .prepare(
        `SELECT a.*, w.current_session_id, w.conversation_generation, COALESCE(w.title,w.slug) title,
      w.state, s.status session_status, COALESCE(s.error_message,w.error_message) error_message
      FROM project_agents a JOIN workspaces w ON w.id=a.agent_id LEFT JOIN sessions s ON s.id=w.current_session_id WHERE a.agent_id=?`
      )
      .get(id) as AgentRow | undefined;
    if (!row) throw new NotFoundError("Project Agent not found.");
    return row;
  }
  sessionAgent(sessionId: string): AgentRow | null {
    const row = this.db
      .prepare(
        "SELECT a.agent_id FROM project_agents a JOIN sessions s ON s.workspace_id=a.agent_id WHERE s.id=?"
      )
      .get(sessionId) as { agent_id: string } | undefined;
    return row ? this.agent(row.agent_id) : null;
  }
  touch(projectId: string): void {
    this.db
      .prepare("UPDATE projects SET revision=revision+1, updated_at=? WHERE id=?")
      .run(this.now(), projectId);
  }
  operation(id: string): OperationRow | undefined {
    return this.db.prepare("SELECT * FROM project_operations WHERE id=?").get(id) as
      | OperationRow
      | undefined;
  }
  existingOperation(
    id: string,
    projectId: string,
    kind: string,
    request: unknown
  ): OperationRow | undefined {
    const old = this.operation(id);
    if (
      old &&
      (old.project_id !== projectId ||
        old.kind !== kind ||
        old.request_hash !== fingerprint(request))
    )
      throw new ConflictError("This request ID was already used with different instructions.");
    return old;
  }
  beginOperation(
    id: string,
    projectId: string,
    kind: string,
    request: unknown,
    agentId: string | null = null,
    actor?: ToolActor
  ): OperationRow {
    const old = this.existingOperation(id, projectId, kind, request);
    if (old) return old;
    this.db
      .prepare(
        `INSERT INTO project_operations(id,project_id,kind,actor_session_id,actor_turn_id,target_agent_id,request_hash,request_json,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`
      )
      .run(
        id,
        projectId,
        kind,
        actor?.sessionId ?? null,
        actor?.turnId ?? null,
        agentId,
        fingerprint(request),
        JSON.stringify(request),
        this.now(),
        this.now()
      );
    return this.operation(id)!;
  }
  complete(id: string, receipt: unknown): void {
    this.db
      .prepare(
        "UPDATE project_operations SET state='succeeded', receipt_json=?, error=NULL, updated_at=? WHERE id=?"
      )
      .run(JSON.stringify(receipt), this.now(), id);
  }
  fail(id: string, error: string): void {
    this.db
      .prepare("UPDATE project_operations SET state='failed',error=?,updated_at=? WHERE id=?")
      .run(error, this.now(), id);
  }
  manifest(projectId: string, revision?: number): ContentManifest {
    const version = revision ?? this.project(projectId).content_head_revision;
    const row = this.db
      .prepare(
        "SELECT manifest_json FROM project_content_revisions WHERE project_id=? AND revision=?"
      )
      .get(projectId, version) as { manifest_json: string } | undefined;
    if (!row) throw new NotFoundError("Project content revision not found.");
    return JSON.parse(row.manifest_json) as ContentManifest;
  }
  create(input: CreateProjectInput, creation: AgentCreation): string {
    const hash = fingerprint(input);
    const existing = this.db
      .prepare("SELECT id,creation_hash FROM projects WHERE creation_request_id=?")
      .get(input.requestId) as { id: string; creation_hash: string } | undefined;
    if (existing) {
      if (existing.creation_hash !== hash)
        throw new ConflictError("Creation request changed. Use a new request ID.");
      return existing.id;
    }
    const brief = this.content.write("brief.md", input.brief);
    const id = uuidv7();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects(id,creation_request_id,creation_hash,title,repository_id,model,dispatch_limit,concurrency_limit,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          input.requestId,
          hash,
          input.title,
          input.repositoryId,
          input.model,
          input.dispatchLimit ?? 40,
          input.concurrencyLimit ?? 2,
          this.now(),
          this.now()
        );
      this.db
        .prepare("INSERT INTO project_content_revisions VALUES(?,?,?,?)")
        .run(id, 0, JSON.stringify({ "brief.md": brief }), this.now());
      this.reserveAgent(id, `${input.requestId}:coordinator`, creation);
      this.db
        .prepare("UPDATE projects SET coordinator_agent_id=? WHERE id=?")
        .run(creation.workspaceId, id);
    })();
    return id;
  }
  reserveAgent(
    projectId: string,
    operationId: string,
    creation: AgentCreation,
    actor?: ToolActor
  ): string {
    return this.db.transaction(() => {
      const old = this.existingOperation(operationId, projectId, "create_agent", creation);
      if (old) return old.target_agent_id!;
      const project = this.project(projectId);
      if (project.lifecycle !== "active" || project.paused_at !== null)
        throw new ConflictError("Resume the Project before creating another agent.");
      if (this.dispatchCount(projectId) >= project.dispatch_limit)
        throw new ConflictError("Project turn allowance reached.");
      const members = this.db
        .prepare("SELECT COUNT(*) n FROM project_agents WHERE project_id=?")
        .get(projectId) as { n: number };
      if (members.n >= 32) throw new ConflictError("This Project has reached its 32-agent limit.");
      const slug = `project-${creation.workspaceId.slice(0, 8)}-${creation.workspaceId.slice(-8)}`;
      this.db
        .prepare(
          `INSERT INTO workspaces(id,repository_id,slug,title,git_branch,git_target_branch,state,init_stage)
        VALUES(?,?,?,?,?,?,'initializing','pending')`
        )
        .run(
          creation.workspaceId,
          creation.repositoryId,
          slug,
          creation.title,
          `deus/${slug}`,
          creation.sourceBranch
        );
      this.beginOperation(
        operationId,
        projectId,
        "create_agent",
        creation,
        creation.workspaceId,
        actor
      );
      this.db
        .prepare(
          "INSERT INTO project_agents(agent_id,project_id,creation_operation_id,created_at) VALUES(?,?,?,?)"
        )
        .run(creation.workspaceId, projectId, operationId, this.now());
      const inputId = uuidv7(),
        assignmentId = uuidv7();
      // A coordinator created without a brief opens with an introduction. That
      // system input is never shown as its task; the first human instruction
      // becomes brief.md and the ordinary coordination instructions apply.
      const welcome = creation.coordinator && !creation.task.trim();
      const message = welcome
        ? welcomeInstruction({
            firstProject:
              (this.db.prepare("SELECT COUNT(*) n FROM projects").get() as { n: number }).n <= 1,
            title: project.title,
            repositoryName:
              (
                this.db
                  .prepare("SELECT name FROM repositories WHERE id=?")
                  .get(creation.repositoryId) as { name: string } | undefined
              )?.name ?? "this repository",
          })
        : creation.task;
      this.db
        .prepare(
          `INSERT INTO project_inputs(id,project_id,agent_id,session_id,generation,kind,origin,source_session_id,source_turn_id,payload_json,dedup_key,created_at)
        VALUES(?,?,?,?,0,?,?,?,?,?,?,?)`
        )
        .run(
          inputId,
          projectId,
          creation.workspaceId,
          creation.sessionId,
          welcome ? "welcome" : "direction",
          welcome ? "system" : actor ? "agent" : "human",
          actor?.sessionId ?? null,
          actor?.turnId ?? null,
          JSON.stringify({ message }),
          `initial:${operationId}`,
          this.now()
        );
      this.db
        .prepare(
          "INSERT INTO project_assignments(id,project_id,agent_id,initiating_input_id,brief_revision,created_at) VALUES(?,?,?,?,?,?)"
        )
        .run(
          assignmentId,
          projectId,
          creation.workspaceId,
          inputId,
          project.content_head_revision,
          this.now()
        );
      this.db
        .prepare("UPDATE project_inputs SET assignment_id=? WHERE id=?")
        .run(assignmentId, inputId);
      this.touch(projectId);
      return creation.workspaceId;
    })();
  }
  assignment(agentId: string): { id: string; initiating_input_id: string; state: string } {
    const row = this.db
      .prepare(
        "SELECT id,initiating_input_id,state FROM project_assignments WHERE agent_id=? ORDER BY created_at DESC,id DESC LIMIT 1"
      )
      .get(agentId) as { id: string; initiating_input_id: string; state: string } | undefined;
    if (!row) throw new NotFoundError("Agent assignment not found.");
    return row;
  }
  addInput(
    projectId: string,
    agentId: string,
    message: string,
    dedup: string,
    origin: "human" | "agent" | "system",
    source?: ToolActor,
    kind = "message",
    replyTo?: string
  ): string {
    return this.db.transaction(() => {
      const old = this.db
        .prepare(
          "SELECT id,payload_json,agent_id,kind,reply_to,source_session_id,source_turn_id FROM project_inputs WHERE project_id=? AND dedup_key=?"
        )
        .get(projectId, dedup) as (InputRow & { reply_to: string | null }) | undefined;
      if (old) {
        if (
          old.payload_json !== JSON.stringify({ message }) ||
          old.agent_id !== agentId ||
          old.kind !== kind ||
          old.reply_to !== (replyTo ?? null) ||
          old.source_session_id !== (source?.sessionId ?? null) ||
          old.source_turn_id !== (source?.turnId ?? null)
        )
          throw new ConflictError("Input retry changed its contents.");
        return old.id;
      }
      const p = this.project(projectId),
        a = this.agent(agentId);
      if (p.lifecycle !== "active" || a.project_id !== projectId)
        throw new ConflictError("This Project cannot accept that message.");
      if (!a.current_session_id) throw new ConflictError("The agent is still preparing.");
      if (kind === "reply" && !replyTo)
        throw new ValidationError("A reply must identify the question it answers.");
      if (replyTo && kind !== "reply")
        throw new ValidationError("Use reply messages to answer a question.");
      const id = uuidv7();
      let assignment = this.assignment(agentId);
      if (replyTo) {
        const q = this.db
          .prepare("SELECT * FROM project_inputs WHERE id=? AND project_id=? AND kind='question'")
          .get(replyTo, projectId) as InputRow | undefined;
        if (!q || q.resolved_by || q.source_session_id !== a.current_session_id)
          throw new ConflictError(
            "The question is no longer awaiting a reply to this conversation."
          );
        if (source && q.session_id !== source.sessionId)
          throw new ConflictError(
            "Only the conversation that received this question may reply to it."
          );
        // A delayed answer cannot reopen accepted work or steer a newer task
        // merely because the Agent still uses the same conversation.
        const sourceDispatch = this.db
          .prepare(
            "SELECT assignment_id FROM project_dispatches WHERE id=? AND session_id=? AND agent_id=? AND generation=?"
          )
          .get(q.source_turn_id, q.source_session_id, agentId, a.conversation_generation) as
          | { assignment_id: string }
          | undefined;
        if (assignment.state !== "open" || sourceDispatch?.assignment_id !== assignment.id)
          throw new ConflictError("The question's assignment is no longer awaiting a reply.");
        this.db
          .prepare("UPDATE project_inputs SET resolved_by=? WHERE id=? AND resolved_by IS NULL")
          .run(id, replyTo);
      }
      if (assignment.state !== "open") {
        const assignmentId = uuidv7();
        this.db
          .prepare(
            "INSERT INTO project_assignments(id,project_id,agent_id,initiating_input_id,brief_revision,created_at) VALUES(?,?,?,?,?,?)"
          )
          .run(assignmentId, projectId, agentId, id, p.content_head_revision, this.now());
        assignment = { id: assignmentId, initiating_input_id: id, state: "open" };
      }
      this.db
        .prepare(
          `INSERT INTO project_inputs(id,project_id,agent_id,session_id,generation,assignment_id,kind,origin,source_session_id,source_turn_id,payload_json,dedup_key,reply_to,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          projectId,
          agentId,
          a.current_session_id,
          a.conversation_generation,
          assignment.id,
          kind,
          origin,
          source?.sessionId ?? null,
          source?.turnId ?? null,
          JSON.stringify({ message }),
          dedup,
          replyTo ?? null,
          this.now()
        );
      this.touch(projectId);
      return id;
    })();
  }
  dispatchCount(projectId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) n FROM project_dispatches WHERE project_id=?")
        .get(projectId) as { n: number }
    ).n;
  }
  openDispatches(): DispatchRow[] {
    return this.db
      .prepare("SELECT * FROM project_dispatches WHERE closed_at IS NULL ORDER BY created_at")
      .all() as DispatchRow[];
  }
  pendingCreations(): OperationRow[] {
    return this.db
      .prepare(
        "SELECT * FROM project_operations WHERE kind='create_agent' AND state='pending' ORDER BY created_at"
      )
      .all() as OperationRow[];
  }
  pendingInputs(
    agentId: string,
    assignmentId?: string
  ): (InputRow & { source_agent_id: string | null })[] {
    return this.db
      .prepare(
        `SELECT i.*, source.workspace_id source_agent_id FROM project_inputs i
      JOIN workspaces recipient ON recipient.id=i.agent_id
      LEFT JOIN sessions source ON source.id=i.source_session_id
      LEFT JOIN project_dispatch_inputs di ON di.input_id=i.id
      WHERE i.agent_id=? AND di.input_id IS NULL AND i.superseded_at IS NULL
      ${assignmentId === undefined ? "" : "AND i.assignment_id=? AND i.session_id=recipient.current_session_id AND i.generation=recipient.conversation_generation"}
      AND (i.kind!='question' OR EXISTS(SELECT 1 FROM project_dispatches d WHERE d.session_id=i.source_session_id AND d.id=i.source_turn_id AND d.closed_at IS NOT NULL))
      ORDER BY i.created_at,i.id LIMIT 16`
      )
      .all(agentId, ...(assignmentId === undefined ? [] : [assignmentId])) as (InputRow & {
      source_agent_id: string | null;
    })[];
  }
  reserveDispatch(agentId: string): DispatchRow | null {
    return this.db.transaction(() => {
      const a = this.agent(agentId),
        p = this.project(a.project_id);
      if (
        p.lifecycle !== "active" ||
        p.paused_at !== null ||
        a.paused_at !== null ||
        a.state !== "ready" ||
        !a.current_session_id ||
        this.dispatchCount(p.id) >= p.dispatch_limit
      )
        return null;
      if (
        this.db
          .prepare("SELECT 1 FROM project_dispatches WHERE agent_id=? AND closed_at IS NULL")
          .get(agentId)
      )
        return null;
      const active = (
        this.db
          .prepare(
            "SELECT COUNT(*) n FROM project_dispatches WHERE project_id=? AND agent_id!=? AND closed_at IS NULL"
          )
          .get(p.id, p.coordinator_agent_id) as { n: number }
      ).n;
      if (agentId !== p.coordinator_agent_id && active >= p.concurrency_limit) return null;
      const assignment = this.assignment(agentId);
      if (assignment.state !== "open") return null;
      const inputs = this.pendingInputs(agentId, assignment.id);
      if (!inputs.length) return null;
      const id = uuidv7(),
        coordinator = agentId === p.coordinator_agent_id;
      const files = this.manifest(p.id);
      const brief = files["brief.md"] ? this.content.read(files["brief.md"]) : "";
      const systemPromptAppend = roleInstructions({
        coordinator,
        projectTitle: p.title,
        projectId: p.id,
        agentId,
        assignmentId: assignment.id,
        contentRevision: p.content_head_revision,
        brief,
      });
      const prompt = formatProjectPrompt(
        inputs.map((i) => ({
          id: i.id,
          origin: i.origin,
          kind: i.kind,
          message: JSON.parse(i.payload_json).message,
          source: i.source_agent_id
            ? {
                agentId: i.source_agent_id,
                sessionId: i.source_session_id,
                turnId: i.source_turn_id,
              }
            : null,
        }))
      );
      this.db
        .prepare(
          `INSERT INTO project_dispatches(id,project_id,agent_id,session_id,generation,assignment_id,request_json,content_revision,phase,created_at)
        VALUES(?,?,?,?,?,?,?,?,'prepared',?)`
        )
        .run(
          id,
          p.id,
          agentId,
          a.current_session_id,
          a.conversation_generation,
          assignment.id,
          JSON.stringify({ prompt, systemPromptAppend, model: p.model, maxTurns: 24 }),
          p.content_head_revision,
          this.now()
        );
      inputs.forEach((i, position) =>
        this.db.prepare("INSERT INTO project_dispatch_inputs VALUES(?,?,?)").run(id, i.id, position)
      );
      this.touch(p.id);
      return this.db.prepare("SELECT * FROM project_dispatches WHERE id=?").get(id) as DispatchRow;
    })();
  }
  settle(dispatch: DispatchRow, outcome: unknown): void {
    this.db.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE project_dispatches SET phase='finished',outcome_json=?,closed_at=?,error=NULL WHERE id=? AND closed_at IS NULL"
        )
        .run(JSON.stringify(outcome), this.now(), dispatch.id);
      if (!changed.changes) return;
      const p = this.project(dispatch.project_id);
      if (
        dispatch.agent_id !== p.coordinator_agent_id &&
        p.lifecycle === "active" &&
        p.coordinator_agent_id
      ) {
        const reports = this.db
          .prepare("SELECT id,summary FROM project_reports WHERE turn_id=? AND session_id=?")
          .all(dispatch.id, dispatch.session_id);
        this.addInput(
          p.id,
          p.coordinator_agent_id,
          JSON.stringify({
            agentId: dispatch.agent_id,
            sessionId: dispatch.session_id,
            turnId: dispatch.id,
            outcome,
            reports,
          }),
          `outcome:${dispatch.session_id}:${dispatch.id}`,
          "system",
          { sessionId: dispatch.session_id, turnId: dispatch.id },
          "turn_outcome"
        );
      }
      this.touch(p.id);
    })();
  }
  publish(
    projectId: string,
    operationId: string,
    files: { path: string; content: string }[],
    expectedRevision: number,
    actor?: ToolActor
  ): number {
    const request = { files, expectedRevision };
    const old = this.existingOperation(operationId, projectId, "publish_content", request);
    if (old?.receipt_json) return (JSON.parse(old.receipt_json) as { revision: number }).revision;
    const blobs = files.map((f) => this.content.write(f.path, f.content));
    return this.db.transaction(() => {
      const p = this.project(projectId);
      if (p.content_head_revision !== expectedRevision)
        throw new ConflictError(
          "Project files changed. Read the latest revision and retry your edit."
        );
      this.beginOperation(operationId, projectId, "publish_content", request, null, actor);
      const manifest: ContentManifest = {
        ...this.manifest(projectId),
        ...Object.fromEntries(blobs.map((file) => [file.path, file])),
      };
      if (Object.keys(manifest).length > 256)
        throw new ValidationError("Project context is limited to 256 files.");
      const revision = expectedRevision + 1;
      this.db
        .prepare("INSERT INTO project_content_revisions VALUES(?,?,?,?)")
        .run(projectId, revision, JSON.stringify(manifest), this.now());
      this.db
        .prepare("UPDATE projects SET content_head_revision=? WHERE id=?")
        .run(revision, projectId);
      this.complete(operationId, { revision });
      this.touch(projectId);
      return revision;
    })();
  }
  /**
   * A Project created without a brief adopts the coordinator's first human
   * instruction as brief.md. Returns the new revision, or null when a brief
   * already exists or someone else published first.
   */
  adoptBrief(projectId: string, operationId: string, message: string): number | null {
    const p = this.project(projectId);
    if (p.lifecycle !== "active" || !message.trim()) return null;
    const files = this.manifest(projectId);
    const current = files["brief.md"] ? this.content.read(files["brief.md"]) : "";
    if (current.trim()) return null;
    try {
      return this.publish(
        projectId,
        operationId,
        [{ path: "brief.md", content: message }],
        p.content_head_revision
      );
    } catch (error) {
      // A concurrent publication (the coordinator or a document edit) wins;
      // the instruction is still delivered against that brief.
      if (error instanceof ConflictError) return null;
      throw error;
    }
  }
  report(
    agentId: string,
    actor: ToolActor,
    operationId: string,
    summary: string,
    files: { path: string; content: string }[],
    pullRequests: string[]
  ): string {
    const a = this.agent(agentId),
      request = { summary, files, pullRequests, actor };
    const old = this.existingOperation(operationId, a.project_id, "report_result", request);
    if (old?.receipt_json) return (JSON.parse(old.receipt_json) as { reportId: string }).reportId;
    const dispatch = this.db
      .prepare(
        "SELECT assignment_id FROM project_dispatches WHERE id=? AND session_id=? AND agent_id=? AND project_id=?"
      )
      .get(actor.turnId, actor.sessionId, agentId, a.project_id) as
      | { assignment_id: string }
      | undefined;
    if (!dispatch) throw new ConflictError("Report evidence requires its original Project turn.");
    const assignmentId = dispatch.assignment_id;
    const blobs = files.map((f) =>
      this.content.write(`results/${assignmentId}/${this.content.validatePath(f.path)}`, f.content)
    );
    return this.db.transaction(() => {
      this.beginOperation(operationId, a.project_id, "report_result", request, agentId, actor);
      const p = this.project(a.project_id),
        manifest: ContentManifest = {
          ...this.manifest(p.id),
          ...Object.fromEntries(blobs.map((file) => [file.path, file])),
        };
      if (Object.keys(manifest).length > 256)
        throw new ValidationError("Project context is limited to 256 files.");
      const revision = p.content_head_revision + 1,
        reportId = uuidv7();
      this.db
        .prepare("INSERT INTO project_content_revisions VALUES(?,?,?,?)")
        .run(p.id, revision, JSON.stringify(manifest), this.now());
      this.db.prepare("UPDATE projects SET content_head_revision=? WHERE id=?").run(revision, p.id);
      this.db
        .prepare("INSERT INTO project_reports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          reportId,
          p.id,
          operationId,
          assignmentId,
          agentId,
          actor.sessionId,
          actor.turnId,
          summary,
          revision,
          JSON.stringify(blobs),
          JSON.stringify(pullRequests),
          this.now()
        );
      captureReportPullRequests(this.db, {
        projectId: p.id,
        reportId,
        assignmentId,
        agentId,
        sessionId: actor.sessionId,
        turnId: actor.turnId,
        urls: pullRequests,
      });
      this.complete(operationId, { reportId, revision });
      this.touch(p.id);
      return reportId;
    })();
  }
  summaries(): ProjectSummary[] {
    return this.summaryRows().map(projectSummary);
  }

  detail(projectId: string): ProjectDetail {
    const project = this.summaryRows(projectId)[0];
    if (!project) throw new NotFoundError("Project not found.");
    const rows = this.db
      .prepare(
        `
      WITH assignments AS (
        SELECT id, agent_id, state, initiating_input_id, ROW_NUMBER() OVER (
          PARTITION BY agent_id ORDER BY created_at DESC, id DESC
         ) position FROM project_assignments WHERE project_id = ?
      ), history AS (
        SELECT agent_id, MAX(closed_at) closed_at FROM project_dispatches
        WHERE project_id = ? GROUP BY agent_id
      ), pending AS (
        SELECT DISTINCT i.agent_id FROM project_inputs i
        JOIN workspaces w ON w.id=i.agent_id AND w.current_session_id=i.session_id
          AND w.conversation_generation=i.generation
        JOIN project_assignments assignment ON assignment.id=i.assignment_id AND assignment.state='open'
        LEFT JOIN project_dispatch_inputs consumed ON consumed.input_id = i.id
        WHERE i.project_id = ? AND i.superseded_at IS NULL AND consumed.input_id IS NULL
      )
      SELECT a.agent_id, a.paused_at, w.current_session_id, COALESCE(w.title, w.slug) title,
        w.state, s.status session_status, assignment.id assignment_id, direction.payload_json task_json, direction.kind task_kind, op.state operation_state,
        CASE WHEN pending.agent_id IS NOT NULL THEN 1 ELSE 0 END has_pending,
        CASE WHEN history.closed_at IS NOT NULL AND d.id IS NULL AND pending.agent_id IS NULL AND assignment.state = 'open' THEN 1 ELSE 0 END can_retry,
        d.id dispatch_id, d.phase dispatch_phase,
        COALESCE(d.error, op.error, s.error_message, w.error_message) error
      FROM project_agents a
      JOIN workspaces w ON w.id = a.agent_id
      LEFT JOIN sessions s ON s.id = w.current_session_id
      JOIN assignments assignment ON assignment.agent_id = a.agent_id AND assignment.position = 1
      LEFT JOIN project_inputs direction ON direction.id = assignment.initiating_input_id
      LEFT JOIN project_operations op ON op.id = a.creation_operation_id
      LEFT JOIN project_dispatches d ON d.agent_id = a.agent_id AND d.closed_at IS NULL
      LEFT JOIN history ON history.agent_id = a.agent_id
      LEFT JOIN pending ON pending.agent_id = a.agent_id
      WHERE a.project_id = ? ORDER BY a.created_at, a.agent_id
    `
      )
      .all(projectId, projectId, projectId, projectId) as AgentDetailRow[];
    const manifest = this.manifest(projectId, project.content_head_revision);
    const brief = manifest["brief.md"] ? this.content.read(manifest["brief.md"]) : "";
    const agents: ProjectAgent[] = rows.map((a) => ({
      id: a.agent_id,
      workspaceId: a.agent_id,
      sessionId: a.current_session_id,
      title: a.title,
      role: project.coordinator_agent_id === a.agent_id ? "coordinator" : "contributor",
      assignmentId: a.assignment_id,
      // A welcome opening is not the coordinator's task; the brief is.
      task:
        a.task_kind === "welcome"
          ? brief
          : ((JSON.parse(a.task_json ?? "{}") as { message?: string }).message ?? ""),
      paused: a.paused_at !== null,
      canRetry: a.can_retry === 1 && project.lifecycle === "active",
      status:
        a.dispatch_phase === "uncertain" ||
        a.operation_state === "failed" ||
        a.session_status === "error"
          ? "needs-attention"
          : a.paused_at !== null || project.paused_at !== null
            ? a.dispatch_phase === "admitted" || a.dispatch_phase === "submitting"
              ? "stopping"
              : "paused"
            : a.state !== "ready"
              ? "preparing"
              : a.dispatch_phase === "prepared"
                ? "queued"
                : a.dispatch_id
                  ? "working"
                  : a.has_pending === 1
                    ? "queued"
                    : "idle",
      error: a.error,
    }));
    const reports = this.db
      .prepare(
        `
      SELECT r.*, COALESCE(w.title, w.slug) agent_title, a.accepted_report_id,
        CASE WHEN d.closed_at IS NOT NULL THEN 1 ELSE 0 END ready
      FROM project_reports r JOIN workspaces w ON w.id = r.agent_id
      JOIN project_assignments a ON a.id = r.assignment_id
      LEFT JOIN project_dispatches d ON d.id = r.turn_id AND d.session_id = r.session_id
        AND d.agent_id = r.agent_id AND d.project_id = r.project_id
      WHERE r.project_id = ? ORDER BY r.created_at DESC, r.id DESC
    `
      )
      .all(projectId) as ReportDetailRow[];
    const pending = this.db
      .prepare(
        `
      SELECT i.id,i.agent_id,i.origin,i.payload_json,i.created_at,
        COUNT(*) OVER() total_count,
        SUM(CASE WHEN i.origin='human' THEN 1 ELSE 0 END) OVER() human_count
      FROM project_inputs i
      JOIN workspaces recipient ON recipient.id=i.agent_id
      JOIN project_assignments assignment ON assignment.id=i.assignment_id AND assignment.state='open'
      WHERE i.project_id = ?
      AND (recipient.current_session_id IS NULL OR
        (i.session_id=recipient.current_session_id AND i.generation=recipient.conversation_generation))
      AND i.superseded_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM project_dispatch_inputs di WHERE di.input_id = i.id
      )
      ORDER BY CASE WHEN i.origin='human' THEN 0 ELSE 1 END,i.created_at,i.id LIMIT 50
    `
      )
      .all(projectId) as {
      id: string;
      agent_id: string;
      origin: InputRow["origin"];
      payload_json: string;
      created_at: number;
      total_count: number;
      human_count: number;
    }[];
    return {
      ...projectSummary(project),
      brief,
      contentRevision: project.content_head_revision,
      files: Object.values(manifest),
      agents,
      reports: reports.map(
        (r) =>
          ({
            id: r.id,
            agentId: r.agent_id,
            agentTitle: r.agent_title,
            assignmentId: r.assignment_id,
            sessionId: r.session_id,
            turnId: r.turn_id,
            summary: r.summary,
            files: JSON.parse(r.files_json),
            pullRequests: JSON.parse(r.pr_urls_json),
            revision: r.content_revision,
            createdAt: r.created_at,
            accepted: r.accepted_report_id === r.id,
            ready: r.ready === 1,
          }) satisfies ProjectReport
      ),
      pendingInputCount: pending[0]?.total_count ?? 0,
      pendingMessageCount: pending[0]?.human_count ?? 0,
      pendingMessages: pending
        .filter((input) => input.origin === "human")
        .map((input) => ({
          id: input.id,
          agentId: input.agent_id,
          message: (JSON.parse(input.payload_json) as { message: string }).message,
          createdAt: input.created_at,
        })),
      pullRequests: queryProjectPullRequests(this.db, projectId),
    };
  }

  /** Lists fetch only SQL projections; opening one Project loads its documents. */
  private summaryRows(projectId?: string): SummaryRow[] {
    const query = this.db.prepare(`
      WITH selected AS (
        SELECT p.*, r.name repository_name FROM projects p
        JOIN repositories r ON r.id = p.repository_id ${projectId ? "WHERE p.id = ?" : ""}
      ), assignments AS (
        SELECT a.*, ROW_NUMBER() OVER (
          PARTITION BY a.agent_id ORDER BY a.created_at DESC, a.id DESC
        ) position FROM project_assignments a JOIN selected p ON p.id = a.project_id
      ), assignment_dispatches AS (
        SELECT d.*, ROW_NUMBER() OVER (
          PARTITION BY d.assignment_id ORDER BY d.created_at DESC, d.id DESC
        ) position FROM project_dispatches d JOIN selected p ON p.id = d.project_id
      ), reported_assignments AS (
        SELECT DISTINCT r.assignment_id FROM project_reports r
        JOIN selected p ON p.id = r.project_id
        JOIN assignment_dispatches d ON d.id = r.turn_id AND d.session_id = r.session_id
          AND d.assignment_id = r.assignment_id AND d.agent_id = r.agent_id
          AND d.project_id = r.project_id
        WHERE d.closed_at IS NOT NULL AND d.position = 1
      ), members AS (
        SELECT a.project_id, COUNT(*) agent_count,
          SUM(CASE WHEN d.phase = 'uncertain' OR op.state = 'failed' OR s.status = 'error' THEN 1 ELSE 0 END) attention_count,
          SUM(CASE WHEN a.paused_at IS NULL AND w.state != 'ready' THEN 1 ELSE 0 END) preparing_count,
          SUM(CASE WHEN a.agent_id = p.coordinator_agent_id AND assignment.state = 'open'
            AND completed.assignment_id IS NOT NULL AND a.paused_at IS NULL THEN 1 ELSE 0 END) review_ready_count,
          SUM(CASE WHEN a.agent_id = p.coordinator_agent_id AND assignment.state = 'accepted'
            AND assignment.accepted_report_id IS NOT NULL THEN 1 ELSE 0 END) accepted_coordinator_count,
          SUM(CASE WHEN a.agent_id != p.coordinator_agent_id AND assignment.state = 'open'
            AND (completed.assignment_id IS NULL OR a.paused_at IS NOT NULL) THEN 1 ELSE 0 END) unfinished_contributor_count,
          MAX(COALESCE(d.error, op.error, s.error_message, w.error_message)) error
        FROM project_agents a JOIN selected p ON p.id = a.project_id
        JOIN workspaces w ON w.id = a.agent_id
        JOIN assignments assignment ON assignment.agent_id = a.agent_id AND assignment.position = 1
        LEFT JOIN reported_assignments completed ON completed.assignment_id = assignment.id
        LEFT JOIN sessions s ON s.id = w.current_session_id
        LEFT JOIN project_operations op ON op.id = a.creation_operation_id
        LEFT JOIN project_dispatches d ON d.agent_id = a.agent_id AND d.closed_at IS NULL
        GROUP BY a.project_id
      ), dispatches AS (
        SELECT d.project_id, COUNT(*) dispatch_count,
          SUM(CASE WHEN d.closed_at IS NULL THEN 1 ELSE 0 END) active_count,
          SUM(CASE WHEN d.closed_at IS NULL AND d.phase = 'prepared' THEN 1 ELSE 0 END) prepared_count
        FROM project_dispatches d JOIN selected p ON p.id = d.project_id GROUP BY d.project_id
      ), pending AS (
        SELECT i.project_id, COUNT(*) pending_count FROM project_inputs i
        JOIN selected p ON p.id = i.project_id
        JOIN workspaces recipient ON recipient.id=i.agent_id
        JOIN project_assignments assignment ON assignment.id=i.assignment_id AND assignment.state='open'
        WHERE i.superseded_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM project_dispatch_inputs di WHERE di.input_id = i.id
        ) AND (recipient.current_session_id IS NULL OR
          (i.session_id=recipient.current_session_id AND i.generation=recipient.conversation_generation))
        GROUP BY i.project_id
      ), reports AS (
        SELECT r.project_id, COUNT(*) report_count FROM project_reports r
        JOIN selected p ON p.id = r.project_id GROUP BY r.project_id
      )
      SELECT p.*, w.current_session_id coordinator_session_id,
        COALESCE(m.agent_count, 0) agent_count, COALESCE(m.attention_count, 0) attention_count,
        COALESCE(m.preparing_count, 0) preparing_count, m.error,
        COALESCE(m.review_ready_count, 0) review_ready_count,
        COALESCE(m.accepted_coordinator_count, 0) accepted_coordinator_count,
        COALESCE(m.unfinished_contributor_count, 0) unfinished_contributor_count,
        COALESCE(d.dispatch_count, 0) dispatch_count, COALESCE(d.active_count, 0) active_count,
        COALESCE(d.prepared_count, 0) prepared_count, COALESCE(pending.pending_count, 0) pending_count,
        COALESCE(r.report_count, 0) report_count
      FROM selected p LEFT JOIN workspaces w ON w.id = p.coordinator_agent_id
      LEFT JOIN members m ON m.project_id = p.id
      LEFT JOIN dispatches d ON d.project_id = p.id LEFT JOIN reports r ON r.project_id = p.id
      LEFT JOIN pending ON pending.project_id = p.id
      ORDER BY p.updated_at DESC, p.id DESC
    `);
    return (projectId ? query.all(projectId) : query.all()) as SummaryRow[];
  }
}

interface SummaryRow extends ProjectRow {
  repository_name: string;
  coordinator_session_id: string | null;
  agent_count: number;
  attention_count: number;
  preparing_count: number;
  dispatch_count: number;
  active_count: number;
  prepared_count: number;
  pending_count: number;
  review_ready_count: number;
  accepted_coordinator_count: number;
  unfinished_contributor_count: number;
  report_count: number;
  error: string | null;
}
interface AgentDetailRow {
  can_retry: number;
  has_pending: number;
  agent_id: string;
  paused_at: number | null;
  current_session_id: string | null;
  title: string;
  state: string;
  assignment_id: string;
  task_json: string | null;
  task_kind: string | null;
  session_status: string | null;
  operation_state: string | null;
  dispatch_id: string | null;
  dispatch_phase: string | null;
  error: string | null;
}
interface ReportDetailRow {
  id: string;
  agent_id: string;
  agent_title: string;
  assignment_id: string;
  session_id: string;
  turn_id: string;
  summary: string;
  files_json: string;
  pr_urls_json: string;
  content_revision: number;
  created_at: number;
  accepted_report_id: string | null;
  ready: number;
}
function projectSummary(p: SummaryRow): ProjectSummary {
  const status: ProjectSummary["status"] =
    p.lifecycle === "archived"
      ? "archived"
      : p.paused_at !== null
        ? "paused"
        : p.attention_count > 0
          ? "needs-attention"
          : p.preparing_count > 0
            ? "preparing"
            : p.active_count > p.prepared_count
              ? "working"
              : !p.active_count && !p.pending_count && p.accepted_coordinator_count > 0
                ? "done"
                : !p.active_count &&
                    !p.pending_count &&
                    p.review_ready_count > 0 &&
                    !p.unfinished_contributor_count
                  ? "ready"
                  : p.dispatch_count >= p.dispatch_limit && !p.active_count
                    ? "limit-reached"
                    : p.pending_count > 0 || p.prepared_count > 0
                      ? "queued"
                      : "idle";
  return {
    id: p.id,
    title: p.title,
    repositoryId: p.repository_id,
    repositoryName: p.repository_name,
    coordinatorAgentId: p.coordinator_agent_id,
    coordinatorSessionId: p.coordinator_session_id,
    status,
    model: p.model,
    paused: p.paused_at !== null,
    agentCount: p.agent_count,
    activeAgentCount: p.active_count - p.prepared_count,
    reportCount: p.report_count,
    dispatchCount: p.dispatch_count,
    dispatchLimit: p.dispatch_limit,
    concurrencyLimit: p.concurrency_limit,
    revision: p.revision,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    error: p.error,
  };
}
