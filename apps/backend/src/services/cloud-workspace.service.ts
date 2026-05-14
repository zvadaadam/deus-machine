import type BetterSqlite3 from "better-sqlite3";
import {
  Environment,
  createSession as createSdkSession,
  createWorkspace as createSdkWorkspace,
  isDeusError,
  stopWorkspace as stopSdkWorkspace,
  streamRuntime as streamRuntimeSdk,
} from "@deus-hq/sdk";
import type {
  PermissionResult,
  RuntimeEventStream,
  Session as CloudSession,
  SessionRuntimeEvent as CloudSessionRuntimeEvent,
} from "@deus-hq/sdk";
import type { AgentHarness, ErrorCategory } from "@shared/enums";
import type {
  AgentEvent,
  SessionErrorEvent,
  SessionIdleEvent,
  SessionStartedEvent,
} from "@shared/agent-events";
import type { ProtocolEvent, QueryResource, QServerFrame } from "@shared/types/query-protocol";
import type { RepositoryRow, SessionRow, WorkspaceRow } from "../db";
import { getSessionRaw, getWorkspaceRaw } from "../db";
import { getDatabase } from "../lib/database";
import { ValidationError } from "../lib/errors";
import { readManifest, getSetupCommand, isManifestCommandSafe } from "./manifest.service";
import { runGh } from "./gh.service";
import { getSetting } from "./settings.service";
import { invalidate } from "./query-engine";
import { broadcast } from "./ws.service";
import {
  persistMessageCreated,
  persistMessageDone,
  persistPartDone,
  persistSessionError,
  persistSessionIdle,
  persistSessionStarted,
} from "./agent/persistence";
import {
  createCloudRuntimeAdapter,
  type CloudRuntimeAdapter,
  type CloudRuntimeAdapterEvent,
} from "./cloud-runtime-adapter";

type CloudEventStream = RuntimeEventStream;

interface CloudApiConfig {
  apiKey: string;
  baseUrl?: string;
  anthropicApiKey?: string;
}

interface InitializeCloudWorkspaceArgs {
  db: BetterSqlite3.Database;
  workspaceId: string;
  repositoryId: string;
  repo: RepositoryRow;
  workspaceName: string;
  branchName: string;
  parentBranch: string;
  targetBranch: string;
  prNumber?: number | null;
  prUrl?: string | null;
  prTitle?: string | null;
}

interface CreateCloudSessionArgs {
  db: BetterSqlite3.Database;
  workspace: WorkspaceRow;
}

interface ForwardCloudTurnArgs {
  sessionId: string;
  prompt: string;
}

interface CloudWorkspaceRef {
  id: string;
  workspace_kind: string;
  cloud_workspace_id: string | null;
}

interface ActiveCloudTurn {
  events: CloudEventStream;
  controller: AbortController;
}

interface CloudTurnState {
  adapter: CloudRuntimeAdapter;
}

class CloudSessionEventError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

const SESSION_RESOURCES: QueryResource[] = ["workspaces", "sessions", "session", "stats"];
const MESSAGE_RESOURCES: QueryResource[] = ["messages", "session"];
const AGENT_HARNESS: AgentHarness = "claude";
const DEFAULT_DEUS_BASE_URL = "https://api.deusmachine.ai";
const activeCloudTurns = new Map<string, ActiveCloudTurn>();

export async function initializeCloudWorkspace(
  args: InitializeCloudWorkspaceArgs
): Promise<string> {
  if (!args.repo.git_origin_url) {
    throw new ValidationError("Cloud workspaces require a repository with a git remote URL");
  }

  const config = resolveCloudConfig();
  const environment = await buildEnvironment({
    repo: args.repo,
    repoUrl: args.repo.git_origin_url,
    branch: args.parentBranch,
    workspaceId: args.workspaceId,
  });

  const cloudWorkspace = await createSdkWorkspace({
    environment,
    checkout: { branch: args.branchName, from: args.parentBranch },
    anthropicApiKey: config.anthropicApiKey,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });

  try {
    const cloudSession = await createSdkSession({
      workspaceId: cloudWorkspace.id,
      metadata: {
        deusWorkspaceId: args.workspaceId,
        deusRepositoryId: args.repositoryId,
      },
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });

    args.db.transaction(() => {
      args.db
        .prepare(
          `
          INSERT INTO workspaces (
            id, repository_id, slug, title, git_branch, git_target_branch,
            workspace_kind, cloud_workspace_id, cloud_organization_id, cloud_status,
            current_session_id, pr_url, pr_number, state, setup_status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'cloud', ?, ?, ?, ?, ?, ?, 'ready', 'none', datetime('now'))
        `
        )
        .run(
          args.workspaceId,
          args.repositoryId,
          args.workspaceName,
          args.prTitle ?? null,
          args.branchName,
          args.targetBranch,
          cloudWorkspace.id,
          cloudWorkspace.organizationId,
          "READY",
          cloudSession.id,
          args.prUrl ?? null,
          args.prNumber ?? null
        );

      args.db
        .prepare(
          `
          INSERT INTO sessions (
            id, workspace_id, agent_harness, agent_session_id, cloud_session_id, status, updated_at
          ) VALUES (?, ?, 'claude', ?, ?, 'idle', datetime('now'))
        `
        )
        .run(cloudSession.id, args.workspaceId, cloudSession.id, cloudSession.id);
    })();

    invalidate(["workspaces", "sessions", "stats"]);
    return args.workspaceId;
  } catch (error) {
    console.warn("[CloudWorkspace] Created cloud workspace but failed to create local session", {
      cloudWorkspaceId: cloudWorkspace.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function createCloudSessionForWorkspace(
  args: CreateCloudSessionArgs
): Promise<SessionRow> {
  if (args.workspace.workspace_kind !== "cloud" || !args.workspace.cloud_workspace_id) {
    throw new ValidationError("Workspace is not a cloud workspace");
  }

  const config = resolveCloudConfig();
  const cloudSession = await createSdkSession({
    workspaceId: args.workspace.cloud_workspace_id,
    metadata: {
      deusWorkspaceId: args.workspace.id,
    },
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });

  args.db.transaction(() => {
    args.db
      .prepare(
        `
        INSERT INTO sessions (
          id, workspace_id, agent_harness, agent_session_id, cloud_session_id, status, updated_at
        ) VALUES (?, ?, 'claude', ?, ?, 'idle', datetime('now'))
      `
      )
      .run(cloudSession.id, args.workspace.id, cloudSession.id, cloudSession.id);

    args.db
      .prepare(
        "UPDATE workspaces SET current_session_id = ?, cloud_status = 'READY', updated_at = datetime('now') WHERE id = ?"
      )
      .run(cloudSession.id, args.workspace.id);
  })();

  invalidate(["workspaces", "sessions", "stats"]);

  const session = getSessionRaw(args.db, cloudSession.id);
  if (!session) throw new Error("Cloud session not found after creation");
  return session;
}

export async function stopCloudWorkspace(workspace: CloudWorkspaceRef): Promise<void> {
  if (workspace.workspace_kind !== "cloud" || !workspace.cloud_workspace_id) {
    return;
  }

  const config = resolveCloudConfig();
  setWorkspaceCloudStatus(workspace.id, "STOPPING");

  try {
    await stopSdkWorkspace(workspace.cloud_workspace_id, {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
    setWorkspaceCloudStatus(workspace.id, "STOPPED");
  } catch (error) {
    setWorkspaceCloudStatus(workspace.id, "ERROR");
    throw error;
  }
}

export function forwardCloudTurn(args: ForwardCloudTurnArgs): void {
  if (activeCloudTurns.has(args.sessionId)) {
    throw new Error("Cloud session already has an active turn");
  }

  const db = getDbForCloud();
  const session = getSessionRaw(db, args.sessionId);
  if (!session) throw new Error("Session not found");

  const workspace = getWorkspaceRaw(db, session.workspace_id);
  if (!workspace || workspace.workspace_kind !== "cloud" || !workspace.cloud_workspace_id) {
    throw new Error("Cloud workspace not found for session");
  }

  const config = resolveCloudConfig();
  const cloudSessionId = session.cloud_session_id ?? session.agent_session_id;
  if (!cloudSessionId) {
    throw new Error("Cloud session ID is missing");
  }

  const cloudSession: CloudSession = {
    id: cloudSessionId,
    organizationId: workspace.cloud_organization_id ?? "",
    userId: null,
  };

  const controller = new AbortController();
  const events = streamRuntimeSdk(cloudSession, args.prompt, {
    workspaceId: workspace.cloud_workspace_id,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    anthropicApiKey: config.anthropicApiKey,
    signal: controller.signal,
    waitForWorkspaceTimeout: 180_000,
  });

  activeCloudTurns.set(args.sessionId, { events, controller });
  void pumpCloudTurn(args.sessionId, workspace.id, events, controller);
}

export function abortCloudTurn(sessionId: string): boolean {
  const active = activeCloudTurns.get(sessionId);
  if (!active) return false;

  active.controller.abort();
  active.events.abort();
  activeCloudTurns.delete(sessionId);

  emitSessionIdle({ type: "session.idle", sessionId, agentHarness: AGENT_HARNESS });
  setSessionWorkspaceCloudStatus(sessionId, "READY");
  return true;
}

export function isCloudSession(session: SessionRow): boolean {
  const db = getDbForCloud();
  const workspace = getWorkspaceRaw(db, session.workspace_id);
  return workspace?.workspace_kind === "cloud";
}

async function buildEnvironment(args: {
  repo: RepositoryRow;
  repoUrl: string;
  branch: string;
  workspaceId: string;
}) {
  const environment = Environment.from("agnt-base")
    .repo(args.repoUrl, args.branch)
    .env(buildCloudEnv(args.repo.root_path, args.workspaceId))
    .metadata({
      deusWorkspaceId: args.workspaceId,
      deusRepositoryId: args.repo.id,
      deusRepositoryName: args.repo.name,
    });

  const manifest = readManifest(args.repo.root_path);
  const setupCmd = manifest ? getSetupCommand(manifest) : null;
  if (setupCmd) {
    if (!isManifestCommandSafe(setupCmd)) {
      throw new ValidationError("Cloud workspace setup command was rejected for safety");
    }
    environment.setup([setupCmd]);
  }

  const ghToken = await resolveGitHubToken(args.repo.root_path);
  if (ghToken) {
    environment.secrets({ GITHUB_TOKEN: ghToken, GH_TOKEN: ghToken });
  }

  return environment;
}

function buildCloudEnv(repoRootPath: string, workspaceId: string): Record<string, string> {
  const manifest = readManifest(repoRootPath);
  return {
    ...(manifest?.env ?? {}),
    DEUS_ROOT_PATH: ".",
    DEUS_WORKSPACE_PATH: ".",
    DEUS_WORKSPACE_ID: workspaceId,
    DEUS_WORKSPACE_KIND: "cloud",
  };
}

async function resolveGitHubToken(cwd: string): Promise<string | undefined> {
  const fromEnv = readEnv("GITHUB_TOKEN") ?? readEnv("GH_TOKEN");
  if (fromEnv) return fromEnv;

  const result = await runGh(["auth", "token"], { cwd, timeoutMs: 5000 });
  if (!result.success) return undefined;
  return result.stdout || undefined;
}

function resolveCloudConfig(): CloudApiConfig {
  const apiKey = readEnv("DEUS_API_KEY") ?? readSetting("deus_api_key");
  if (!apiKey) {
    throw new ValidationError("Set DEUS_API_KEY or add a Deus Cloud API key in Settings > AI");
  }

  return {
    apiKey,
    baseUrl: readEnv("DEUS_BASE_URL") ?? readSetting("deus_base_url") ?? DEFAULT_DEUS_BASE_URL,
    anthropicApiKey: readEnv("ANTHROPIC_API_KEY") ?? readSetting("anthropic_api_key") ?? undefined,
  };
}

function readEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

function readSetting(key: string): string | undefined {
  const value = getSetting(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getDbForCloud(): BetterSqlite3.Database {
  return getDatabase();
}

async function pumpCloudTurn(
  sessionId: string,
  workspaceId: string,
  events: CloudEventStream,
  controller: AbortController
): Promise<void> {
  const state: CloudTurnState = {
    adapter: createCloudRuntimeAdapter({ sessionId, agentHarness: AGENT_HARNESS }),
  };

  let endedCleanly = false;

  try {
    emitSessionStarted({ type: "session.started", sessionId, agentHarness: AGENT_HARNESS });
    setWorkspaceCloudStatus(workspaceId, "RUNNING");

    for await (const event of events) {
      handleCloudEvent(state, events, event);
      if (event.type === "turn.ended") {
        endedCleanly = event.status !== "FAILED";
      }
    }

    emitCloudRuntimeEvents(state.adapter.finalize("end_turn"));
    setWorkspaceCloudStatus(workspaceId, "READY");
    emitSessionIdle({ type: "session.idle", sessionId, agentHarness: AGENT_HARNESS });
  } catch (error) {
    if (controller.signal.aborted) {
      setWorkspaceCloudStatus(workspaceId, "READY");
      emitSessionIdle({ type: "session.idle", sessionId, agentHarness: AGENT_HARNESS });
      return;
    }

    emitSessionError({
      type: "session.error",
      sessionId,
      agentHarness: AGENT_HARNESS,
      error: errorToMessage(error),
      category: classifyCloudError(error),
    });
    setWorkspaceCloudStatus(workspaceId, "ERROR");
  } finally {
    const active = activeCloudTurns.get(sessionId);
    if (active?.events === events) {
      activeCloudTurns.delete(sessionId);
    }
    if (!endedCleanly && !controller.signal.aborted) {
      invalidate(SESSION_RESOURCES, { sessionIds: [sessionId] });
    }
  }
}

function handleCloudEvent(
  state: CloudTurnState,
  events: CloudEventStream,
  event: CloudSessionRuntimeEvent
): void {
  if (event.type === "turn.ended" && event.status === "FAILED") {
    throw new CloudSessionEventError(event.error ?? "Cloud turn failed", "TURN_FAILED");
  }
  emitCloudRuntimeEvents(state.adapter.handle(event));

  switch (event.type) {
    case "permission.request":
      events.respondToPermission(event.data.requestId, event.data.sessionId, {
        behavior: "allow",
      } satisfies PermissionResult);
      break;
    case "hook.request":
      if (event.data.needsResponse) {
        events.respondToHook(event.data.requestId, event.data.sessionId, { continue: true });
      }
      break;
    case "mcp.question":
      events.answerQuestion(
        event.data.questionId,
        event.data.sessionId,
        event.data.questions.map(() => "")
      );
      break;
    case "session.error":
      throw new CloudSessionEventError(event.error.message, event.error.code);
    default:
      break;
  }
}

function emitSessionStarted(event: SessionStartedEvent): void {
  const result = persistSessionStarted(event);
  if (result.ok) invalidate(SESSION_RESOURCES, { sessionIds: [event.sessionId] });
}

function emitSessionIdle(event: SessionIdleEvent): void {
  const result = persistSessionIdle(event);
  if (result.ok) invalidate(SESSION_RESOURCES, { sessionIds: [event.sessionId] });
}

function emitSessionError(event: SessionErrorEvent): void {
  const result = persistSessionError(event);
  if (result.ok) invalidate(SESSION_RESOURCES, { sessionIds: [event.sessionId] });
}

function emitCloudRuntimeEvents(events: CloudRuntimeAdapterEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case "message.created": {
        const result = persistMessageCreated(event);
        if (result.ok) invalidate(MESSAGE_RESOURCES, { sessionIds: [event.sessionId] });
        pushEvent("message:created", stripType(event));
        break;
      }
      case "part.created":
        persistPartDone(event);
        pushEvent("part:created", stripType(event));
        break;
      case "part.delta":
        pushEvent("part:delta", stripType(event));
        break;
      case "part.done":
        persistPartDone(event);
        pushEvent("part:done", stripType(event));
        break;
      case "message.done":
        persistMessageDone(event);
        pushEvent("message:done", stripType(event));
        break;
    }
  }
}

function pushEvent(event: ProtocolEvent, data: Omit<AgentEvent, "type">): void {
  const frame: QServerFrame = { type: "q:event", event, data };
  broadcast(JSON.stringify(frame));
}

function stripType<T extends { type: string }>(event: T): Omit<T, "type"> {
  const { type: _type, ...data } = event;
  return data;
}

function setWorkspaceCloudStatus(workspaceId: string, status: string): void {
  const db = getDbForCloud();
  db.prepare(
    "UPDATE workspaces SET cloud_status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, workspaceId);
  invalidate(["workspaces", "stats"]);
}

function setSessionWorkspaceCloudStatus(sessionId: string, status: string): void {
  const db = getDbForCloud();
  const session = getSessionRaw(db, sessionId);
  if (!session) return;
  const workspace = getWorkspaceRaw(db, session.workspace_id);
  if (workspace?.workspace_kind === "cloud") {
    setWorkspaceCloudStatus(workspace.id, status);
  }
}

function errorToMessage(error: unknown): string {
  if (isDeusError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function classifyCloudError(error: unknown): ErrorCategory {
  if (error instanceof CloudSessionEventError) return classifyCloudErrorCode(error.code);
  if (isDeusError(error)) return classifyCloudErrorCode(error.code);
  return "internal";
}

function classifyCloudErrorCode(code: string): ErrorCategory {
  if (code.includes("AUTH") || code.includes("KEY") || code.includes("PERMISSION")) return "auth";
  if (code.includes("RATE")) return "rate_limit";
  if (code.includes("TIMEOUT") || code.includes("WEBSOCKET")) return "network";
  if (code.includes("ABORT")) return "abort";
  return "internal";
}
