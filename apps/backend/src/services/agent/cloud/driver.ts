// backend/src/services/agent/cloud/driver.ts
// Cloud session driver: agnt-backed sessions feeding the SAME fold as local.
//
// One raw session socket per cloud session. Incoming frames are agnt's
// SessionRuntimeEvent union = engine lifecycle events (published verbatim,
// additively extended) + agnt platform events. The lifecycle half is wrapped
// into DecodedWireEventEnvelope — deus session id, synthetic per-session seq —
// and handed to the one event handler; persistence, invalidation and the WS
// push all run unchanged. The platform half becomes deus effects here:
// workspace.state → workspace row, session.error → engine error event,
// mcp.question → the existing askUserQuestion relay, permission.request →
// auto-allow (parity with the local ClaudeToolPolicy, which answers every
// tool-use question in-process — deus has no interactive permission UI).

import { createSession, createSessionToken } from "@deus-hq/sdk";
import { LIFECYCLE_EVENT_TYPES } from "@deus-hq/api";
import type { TurnCancelResult } from "@zvada/agent-server/protocol";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";
import type { ThinkingLevel } from "@shared/protocol";
import { CloudEnvStateSchema, type CloudEnvEvent } from "@shared/events";
import { getCloudConfig } from "./config";
import { connectSessionSocket, type SessionSocket } from "./session-socket";
import type { AgentEventHandler } from "../event-handler";
import { relay } from "../tool-relay";
import { persistSessionNeedsResponse, persistSessionBackToWorking } from "../persistence";
import { invalidate } from "../../query-engine";
import { broadcast } from "../../ws.service";
import { getDatabase } from "../../../lib/database";
import { getSessionRaw } from "../../../db";

const LIFECYCLE_TYPES: ReadonlySet<string> = new Set(LIFECYCLE_EVENT_TYPES);

interface PendingDiff {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CloudSession {
  deusSessionId: string;
  deusWorkspaceId: string;
  providerSessionId: string;
  socket: SessionSocket;
  seq: number;
  /** In-flight diff.request round-trips, keyed by requestId. */
  pendingDiffs: Map<string, PendingDiff>;
}

let handler: AgentEventHandler | null = null;
const sessions = new Map<string, CloudSession>();

/** Wire the driver to the process's one event handler. Called from service init. */
export function initCloudDriver(eventHandler: AgentEventHandler): void {
  handler = eventHandler;
}

function rejectPendingDiffs(session: CloudSession, reason: string): void {
  for (const pending of session.pendingDiffs.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  session.pendingDiffs.clear();
}

export function shutdownCloudDriver(): void {
  for (const s of sessions.values()) {
    rejectPendingDiffs(s, "cloud driver shutting down");
    s.socket.close();
  }
  sessions.clear();
  handler = null;
}

// ---- Workspace row effects ----

function updateCloudWorkspace(workspaceId: string, data: { status?: string; step?: string }): void {
  const db = getDatabase();
  const status = data.status ?? "";
  if (status === "running") {
    db.prepare(
      "UPDATE workspaces SET state = 'ready', init_stage = NULL, error_message = NULL WHERE id = ? AND state != 'archived'"
    ).run(workspaceId);
  } else if (status === "provisioning") {
    db.prepare(
      "UPDATE workspaces SET state = 'initializing', init_stage = ? WHERE id = ? AND state != 'archived'"
    ).run(data.step ?? "provisioning", workspaceId);
  } else if (status === "error") {
    db.prepare(
      "UPDATE workspaces SET state = 'error', error_message = ? WHERE id = ? AND state != 'archived'"
    ).run(data.step ?? "cloud workspace error", workspaceId);
  } else {
    // paused/stopped/resuming — surface as the init stage without leaving 'ready'.
    db.prepare("UPDATE workspaces SET init_stage = ? WHERE id = ? AND state != 'archived'").run(
      status || null,
      workspaceId
    );
  }
  invalidate(["workspaces", "stats"], {});
}

/** Push an environment event to connected clients (q:event "cloud:env").
 *  Ephemeral on purpose: the chat shows a live provisioning/wake progress
 *  stack from these; nothing is persisted and a refresh clears them.
 *  Validated at this seam — a malformed platform frame is dropped here, not
 *  shipped to the UI (the workspace-row update has its own tolerance).
 *  Exported so routes (cloud-wake) can announce synthetic states — e.g. the
 *  optimistic "resuming" line — through the same pipe as real frames. */
export function announceCloudEnv(workspaceId: string, sessionId: string, data: unknown): void {
  const parsed = CloudEnvStateSchema.safeParse(data);
  if (!parsed.success) return;
  const payload: CloudEnvEvent = { workspaceId, sessionId, data: parsed.data };
  broadcast(JSON.stringify({ type: "q:event", event: "cloud:env", data: payload }));
}

function broadcastCloudEnv(session: CloudSession, data: unknown): void {
  announceCloudEnv(session.deusWorkspaceId, session.deusSessionId, data);
}

// ---- Frame dispatch ----

/** Wrap one event under the deus session id and feed the shared fold. */
function pushToFold(session: CloudSession, event: Record<string, unknown>): void {
  if (!handler) return;
  const envelope: DecodedWireEventEnvelope = {
    sessionId: session.deusSessionId,
    seq: ++session.seq,
    event: { ...event, sessionId: session.deusSessionId } as DecodedWireEventEnvelope["event"],
  };
  handler.handle(envelope);
}

/** agnt error envelopes (code/message) → the engine's error event, so the
 *  existing error plumbing (facts, dedupe, status flip) runs unchanged. */
function pushCloudError(session: CloudSession, code: unknown, message: unknown): void {
  pushToFold(session, {
    type: "error",
    category: "internal",
    message: `${typeof code === "string" ? code : "cloud_error"}: ${
      typeof message === "string" ? message : "Cloud session error"
    }`,
    recoverable: false,
    timestamp: Date.now(),
  });
}

function dispatchFrame(session: CloudSession, frame: Record<string, unknown>): void {
  const type = typeof frame.type === "string" ? frame.type : "";
  if (!type || !handler) return;

  // Engine lifecycle events pass through verbatim under the deus session id.
  // agnt's published set omits the engine `error` member (it re-wraps errors
  // in its own envelopes below), but a frame that IS engine-shaped — carrying
  // `category` — passes through as-is.
  if (LIFECYCLE_TYPES.has(type) || (type === "error" && typeof frame.category === "string")) {
    pushToFold(session, frame);
    return;
  }

  switch (type) {
    case "session.snapshot": {
      const state = (frame.state ?? {}) as Record<string, unknown>;

      // Truth refresh on (re)connect: the snapshot's session status is the
      // only way to learn the sandbox is asleep after a backend restart —
      // no workspace.state event fires for an already-paused VM. Asleep
      // states hit the row AND the chat stack ("paused — wakes on your next
      // message"); awake ones just clear a stale asleep marker, silently.
      const sessionStatus = typeof state.status === "string" ? state.status : "";
      if (sessionStatus === "paused" || sessionStatus === "stopped") {
        updateCloudWorkspace(session.deusWorkspaceId, { status: sessionStatus });
        broadcastCloudEnv(session, { status: sessionStatus });
      } else if (sessionStatus === "provisioning") {
        // Connected mid-setup (fresh create attaches while the sandbox is
        // still building) — show the stack immediately; the step events
        // that follow append to it.
        updateCloudWorkspace(session.deusWorkspaceId, { status: "provisioning" });
        broadcastCloudEnv(session, { status: "provisioning" });
      } else if (sessionStatus === "ready" || sessionStatus === "running") {
        updateCloudWorkspace(session.deusWorkspaceId, { status: "running" });
      }

      // Reconnect gap-heal: if the turn deus believes is live already settled
      // server-side, the snapshot's turns[] carries its outcome — synthesize
      // the turn.ended the socket gap swallowed. (Snapshot history backfill is
      // the phone-phase reconciliation work; live sessions only need this.)
      const live = handler.liveTurnId(session.deusSessionId);
      if (!live) return;
      if (state.currentTurnId === live) return;
      const turns = Array.isArray(state.turns) ? (state.turns as Record<string, unknown>[]) : [];
      const outcome = turns.find((t) => t.turnId === live);
      if (!outcome) return;
      dispatchFrame(session, {
        type: "turn.ended",
        sessionId: session.providerSessionId,
        turnId: outcome.turnId,
        stopReason: outcome.stopReason ?? "end_turn",
        ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
        ...(outcome.cost !== undefined ? { cost: outcome.cost } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        timestamp: Date.now(),
      });
      return;
    }

    case "workspace.state": {
      const data = (frame.data ?? {}) as { status?: string; step?: string; reason?: string };
      updateCloudWorkspace(session.deusWorkspaceId, data);
      broadcastCloudEnv(session, data);
      // A sandbox that dies mid-turn strands the spinner: agnt keeps the
      // execute queued for replay, but a stopped/errored VM replays nothing
      // until a wake — so the live turn must FAIL VISIBLY here, not hang.
      // (Real case: sidecar dies on a credential error → clean WS close →
      // workspace 'stopped', and the only trace was an ephemeral env line.)
      if (data.status === "stopped" || data.status === "error") {
        const live = handler?.liveTurnId(session.deusSessionId);
        if (live) {
          const detail = data.reason ?? data.step;
          dispatchFrame(session, {
            type: "turn.ended",
            sessionId: session.providerSessionId,
            turnId: live,
            stopReason: "error",
            error: {
              category: "internal",
              message: `Sandbox ${data.status}${detail ? ` — ${detail}` : ""}. Send again to restart it.`,
            },
            timestamp: Date.now(),
          });
        }
      }
      return;
    }

    case "workspace.lifecycle":
      return; // step chatter — workspace.state carries the row-level truth

    case "diff.response": {
      const data = (frame.data ?? {}) as { requestId?: string };
      if (!data.requestId) return;
      const pending = session.pendingDiffs.get(data.requestId);
      if (!pending) return;
      session.pendingDiffs.delete(data.requestId);
      clearTimeout(pending.timer);
      pending.resolve(data as Record<string, unknown>);
      return;
    }

    case "diff.update":
      // Live dirty-file push. The Changes panel polls the diff routes on
      // working sessions (same cadence as local), so the push is advisory
      // here — Sprint 2 turns it into an invalidation signal.
      return;

    case "session.error":
      pushCloudError(session, frame.code, frame.message);
      return;

    case "error":
      // Channel-level command rejection (e.g. MESSAGE_SEND_FAILED). Engine-
      // shaped error events (with `category`) never reach here — the
      // passthrough above claims them.
      console.warn(
        `[CloudDriver] channel error session=${session.deusSessionId} ${String(frame.code ?? "")}`
      );
      pushCloudError(session, frame.code, frame.message);
      return;

    case "mcp.question": {
      const data = (frame.data ?? {}) as {
        questionId?: string;
        sessionId?: string;
        questions?: unknown[];
      };
      if (!data.questionId) return;
      void relayQuestion(session, data as { questionId: string; questions?: unknown[] });
      return;
    }

    case "permission.request": {
      const data = (frame.data ?? {}) as { requestId?: string };
      if (!data.requestId) return;
      session.socket.send({
        type: "permission.response",
        requestId: data.requestId,
        sessionId: session.providerSessionId,
        result: { behavior: "allow" },
      });
      return;
    }

    default:
      // diff.*, browser.*, hook.*, checkpoint:* — later sprints.
      return;
  }
}

/** Relay an AskUserQuestion to the frontend and answer over the socket. */
async function relayQuestion(
  session: CloudSession,
  data: { questionId: string; questions?: unknown[] }
): Promise<void> {
  const sessionId = session.deusSessionId;
  const needs = persistSessionNeedsResponse(sessionId);
  if (needs.ok)
    invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
  try {
    const response = await relay({
      requestId: crypto.randomUUID(),
      sessionId,
      method: "askUserQuestion",
      params: { sessionId, questions: data.questions ?? [] },
      timeoutMs: 24 * 60 * 60 * 1000,
    });
    const answers = extractAnswers(response);
    session.socket.send({
      type: "mcp.answer",
      questionId: data.questionId,
      sessionId: session.providerSessionId,
      answers,
    });
  } catch (err) {
    console.warn(`[CloudDriver] askUserQuestion relay failed: ${String(err)}`);
  } finally {
    const back = persistSessionBackToWorking(sessionId);
    if (back.ok)
      invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
  }
}

function extractAnswers(response: unknown): string[] {
  if (Array.isArray(response)) return response.map(String);
  if (response && typeof response === "object") {
    const maybe = (response as Record<string, unknown>).answers;
    if (Array.isArray(maybe)) return maybe.map(String);
  }
  return [String(response ?? "")];
}

// ---- Session lifecycle ----

const connecting = new Map<string, Promise<CloudSession>>();

/** Open (or return) the live socket for a cloud session. Concurrent callers
 *  (create pipeline vs. a fast first send, diff polls vs. wake) share one
 *  in-flight connect — a lost race would leak a second socket that
 *  double-delivers every frame to the fold. */
export async function ensureCloudSession(deusSessionId: string): Promise<CloudSession> {
  const existing = sessions.get(deusSessionId);
  if (existing?.socket.isOpen()) return existing;

  const inFlight = connecting.get(deusSessionId);
  if (inFlight) return inFlight;

  const attempt = connectCloudSession(deusSessionId).finally(() => {
    connecting.delete(deusSessionId);
  });
  connecting.set(deusSessionId, attempt);
  return attempt;
}

async function connectCloudSession(deusSessionId: string): Promise<CloudSession> {
  const existing = sessions.get(deusSessionId);
  if (existing?.socket.isOpen()) return existing;
  existing?.socket.close();
  sessions.delete(deusSessionId);

  const config = getCloudConfig();
  if (!config) throw new Error("Cloud workspaces are not configured (missing agnt API key)");

  const db = getDatabase();
  const row = getSessionRaw(db, deusSessionId);
  if (!row) throw new Error(`Session not found: ${deusSessionId}`);
  if (!row.provider_session_id) {
    // New chat tabs create bare deus session rows (the generic session route
    // knows nothing about lanes) — the agnt twin is created lazily on first
    // cloud contact. The deus id doubles as the client-supplied id, so a
    // retried create converges instead of duplicating platform sessions.
    const workspace = db
      .prepare("SELECT kind, provider_workspace_id FROM workspaces WHERE id = ?")
      .get(row.workspace_id) as
      | { kind?: string; provider_workspace_id?: string | null }
      | undefined;
    if (workspace?.kind !== "cloud" || !workspace.provider_workspace_id) {
      throw new Error(`Session ${deusSessionId} has no cloud provider session`);
    }
    const created = await createSession({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      workspaceId: workspace.provider_workspace_id,
      sessionId: deusSessionId,
    });
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run(
      created.id,
      deusSessionId
    );
    row.provider_session_id = created.id;
  }

  const { token } = await createSessionToken(row.provider_session_id, {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    expiresIn: 24 * 60 * 60,
  });

  const session: CloudSession = {
    deusSessionId,
    deusWorkspaceId: row.workspace_id,
    providerSessionId: row.provider_session_id,
    seq: 0,
    pendingDiffs: new Map(),
    // Assigned below — the frame callback closes over the session object.
    socket: undefined as unknown as SessionSocket,
  };
  session.socket = connectSessionSocket({
    baseUrl: config.baseUrl,
    providerSessionId: row.provider_session_id,
    token,
    onFrame: (frame) => dispatchFrame(session, frame),
    onDown: (reason) => {
      console.warn(`[CloudDriver] socket down session=${deusSessionId}: ${reason}`);
      rejectPendingDiffs(session, reason);
      sessions.delete(deusSessionId);
    },
  });
  sessions.set(deusSessionId, session);
  await session.socket.ready();
  return session;
}

// ---- Turn API (mirrors the local agentService surface) ----

export interface CloudTurnOptions {
  /** Model override — agnt's sidecar honors options.model (else its default). */
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export async function startCloudTurn(
  deusSessionId: string,
  turnId: string,
  prompt: string,
  options: CloudTurnOptions = {}
): Promise<void> {
  if (!handler) throw new Error("Cloud driver not initialized");
  const config = getCloudConfig();
  if (!config) throw new Error("Cloud workspaces are not configured (missing agnt API key)");

  // agnt QUEUES overlapping sends instead of rejecting them; deus's contract
  // is one live turn per session, so enforce it here (parity with the wire's
  // turnActive rejection on the local path).
  if (handler.liveTurnId(deusSessionId)) {
    throw new Error("The agent is still working — wait for the current turn to finish.");
  }

  const session = await ensureCloudSession(deusSessionId);
  const registered = handler.beginTurn(deusSessionId, turnId);
  try {
    const wsOptions: Record<string, unknown> = {};
    // Deus picks the per-turn credential EXPLICITLY — subscription first,
    // API key fallback. No env-ordering accidents like the raw CLI (where a
    // stray ANTHROPIC_API_KEY silently outranks the subscription token).
    // The oauth branch requires agnt's authKind-aware sidecar (engine 0.3.1).
    if (config.claudeOauthToken) {
      wsOptions.apiKey = config.claudeOauthToken;
      wsOptions.authKind = "oauth";
    } else if (config.anthropicApiKey) {
      wsOptions.apiKey = config.anthropicApiKey;
    }
    if (options.model) wsOptions.model = options.model;
    if (options.thinkingLevel) wsOptions.thinkingLevel = options.thinkingLevel;
    session.socket.send({
      type: "message.send",
      text: prompt,
      messageId: crypto.randomUUID(),
      turnId,
      idempotencyKey: turnId,
      ...(Object.keys(wsOptions).length > 0 ? { options: wsOptions } : {}),
    });
  } catch (err) {
    if (registered) handler.abortTurn(deusSessionId, turnId);
    throw err;
  }
  if (!registered) handler.beginTurn(deusSessionId, turnId, { force: true });
}

export async function cancelCloudTurn(deusSessionId: string): Promise<TurnCancelResult> {
  const live = handler?.liveTurnId(deusSessionId);
  if (!live) return { outcome: "no_active_turn" };
  const session = await ensureCloudSession(deusSessionId);
  session.socket.send({ type: "agent.cancel", turnId: live });
  // The confirmation is the turn.ended{cancelled} lifecycle event — the
  // dispatch alone cannot promise the sidecar stopped (PROTOCOL §8 semantics).
  return { outcome: "unconfirmed", turnId: live };
}

/** Whether this session row belongs to the cloud lane. */
export function isCloudSession(deusSessionId: string): boolean {
  const db = getDatabase();
  const row = getSessionRaw(db, deusSessionId);
  return Boolean(row?.provider_session_id);
}

// ---- Diff channel (sandbox worktree diffs over the session socket) ----

const DIFF_TIMEOUT_MS = 20_000;

export type CloudDiffRequest =
  | { scope: "SUMMARY" }
  | { scope: "FILE"; path: string; format: "DIFF" | "CONTENT" };

export interface CloudDiffSummary {
  files: Array<{
    type: string;
    path: string;
    oldPath?: string;
    additions?: number;
    deletions?: number;
  }>;
  error?: string;
}

export interface CloudDiffFile {
  path: string;
  content?: string;
  diff?: string;
  error?: string;
}

/** One diff.request round-trip against the sandbox's live worktree. */
export async function requestCloudDiff(
  deusSessionId: string,
  request: CloudDiffRequest
): Promise<Record<string, unknown>> {
  const session = await ensureCloudSession(deusSessionId);
  const requestId = crypto.randomUUID();
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pendingDiffs.delete(requestId);
      reject(new Error("cloud diff request timed out"));
    }, DIFF_TIMEOUT_MS);
    session.pendingDiffs.set(requestId, { resolve, reject, timer });
  });
  session.socket.send({ type: "diff.request", data: { ...request, requestId } });
  return response;
}

/** SUMMARY: which files differ in the sandbox worktree right now. */
export async function getCloudDiffSummary(deusSessionId: string): Promise<CloudDiffSummary> {
  const data = await requestCloudDiff(deusSessionId, { scope: "SUMMARY" });
  return {
    files: Array.isArray(data.files) ? (data.files as CloudDiffSummary["files"]) : [],
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}

/** FILE: unified diff or full content for one sandbox path. */
export async function getCloudDiffFile(
  deusSessionId: string,
  path: string,
  format: "DIFF" | "CONTENT"
): Promise<CloudDiffFile> {
  const data = await requestCloudDiff(deusSessionId, { scope: "FILE", path, format });
  return {
    path,
    ...(typeof data.content === "string" ? { content: data.content } : {}),
    ...(typeof data.diff === "string" ? { diff: data.diff } : {}),
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}
