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

import { createSessionToken } from "@deus-hq/sdk";
import { LIFECYCLE_EVENT_TYPES } from "@deus-hq/api";
import type { TurnCancelResult } from "@zvada/agent-server/protocol";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";
import type { ThinkingLevel } from "@shared/agent-info";
import { getCloudConfig } from "./config";
import { connectSessionSocket, type SessionSocket } from "./session-socket";
import type { AgentEventHandler } from "../event-handler";
import { relay } from "../tool-relay";
import { persistSessionNeedsResponse, persistSessionBackToWorking } from "../persistence";
import { invalidate } from "../../query-engine";
import { getDatabase } from "../../../lib/database";
import { getSessionRaw } from "../../../db";

const LIFECYCLE_TYPES: ReadonlySet<string> = new Set(LIFECYCLE_EVENT_TYPES);

interface CloudSession {
  deusSessionId: string;
  deusWorkspaceId: string;
  providerSessionId: string;
  socket: SessionSocket;
  seq: number;
}

let handler: AgentEventHandler | null = null;
const sessions = new Map<string, CloudSession>();

/** Wire the driver to the process's one event handler. Called from service init. */
export function initCloudDriver(eventHandler: AgentEventHandler): void {
  handler = eventHandler;
}

export function shutdownCloudDriver(): void {
  for (const s of sessions.values()) s.socket.close();
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

// ---- Frame dispatch ----

function dispatchFrame(session: CloudSession, frame: Record<string, unknown>): void {
  const type = typeof frame.type === "string" ? frame.type : "";
  if (!type || !handler) return;

  // Engine lifecycle events pass through verbatim under the deus session id.
  if (LIFECYCLE_TYPES.has(type)) {
    const envelope: DecodedWireEventEnvelope = {
      sessionId: session.deusSessionId,
      seq: ++session.seq,
      event: { ...frame, sessionId: session.deusSessionId } as DecodedWireEventEnvelope["event"],
    };
    handler.handle(envelope);
    return;
  }

  switch (type) {
    case "session.snapshot": {
      // Reconnect gap-heal: if the turn deus believes is live already settled
      // server-side, the snapshot's turns[] carries its outcome — synthesize
      // the turn.ended the socket gap swallowed. (Snapshot history backfill is
      // the phone-phase reconciliation work; live sessions only need this.)
      const live = handler.liveTurnId(session.deusSessionId);
      if (!live) return;
      const state = (frame.state ?? {}) as Record<string, unknown>;
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
      const data = (frame.data ?? {}) as { status?: string; step?: string };
      updateCloudWorkspace(session.deusWorkspaceId, data);
      return;
    }

    case "workspace.lifecycle":
      return; // step chatter — workspace.state carries the row-level truth

    case "session.error": {
      // agnt's terminal error envelope → the engine's error event, so the
      // existing error plumbing (facts, dedupe, status flip) runs unchanged.
      const code = typeof frame.code === "string" ? frame.code : "cloud_error";
      const message = typeof frame.message === "string" ? frame.message : "Cloud session error";
      dispatchFrame(session, {
        type: "error",
        sessionId: session.providerSessionId,
        category: "internal",
        message: `${code}: ${message}`,
        recoverable: false,
        timestamp: Date.now(),
      });
      return;
    }

    case "error": {
      // Channel-level command rejection (e.g. MESSAGE_SEND_FAILED).
      const code = typeof frame.code === "string" ? frame.code : "cloud_channel_error";
      const message = typeof frame.message === "string" ? frame.message : "Cloud channel error";
      console.warn(`[CloudDriver] channel error session=${session.deusSessionId} ${code}`);
      dispatchFrame(session, {
        type: "error",
        sessionId: session.providerSessionId,
        category: "internal",
        message: `${code}: ${message}`,
        recoverable: false,
        timestamp: Date.now(),
      });
      return;
    }

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

/** Open (or return) the live socket for a cloud session. */
export async function ensureCloudSession(deusSessionId: string): Promise<CloudSession> {
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
    throw new Error(`Session ${deusSessionId} has no cloud provider session`);
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
      sessions.delete(deusSessionId);
    },
  });
  sessions.set(deusSessionId, session);
  await session.socket.ready();
  return session;
}

// ---- Turn API (mirrors the local agentService surface) ----

export interface CloudTurnOptions {
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
    if (config.anthropicApiKey) wsOptions.apiKey = config.anthropicApiKey;
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
