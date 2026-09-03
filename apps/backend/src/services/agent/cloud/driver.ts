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
// simulator.* → ./simulator (an in-memory device cache + q:event cloud:simulator),
// sandboxUrlTemplate → ./preview (an in-memory template cache + q:event cloud:preview),
// mcp.question → the existing askUserQuestion relay, permission.request →
// auto-allow (parity with the local ClaudeToolPolicy, which answers every
// tool-use question in-process — deus has no interactive permission UI).

import { createSession, createSessionToken } from "@deus-hq/sdk";
import { LIFECYCLE_EVENT_TYPES } from "@deus-hq/api";
import type { TurnCancelResult } from "@zvada/agent-server/protocol";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";
import type { ThinkingLevel } from "@shared/protocol";
import {
  CloudEnvStateSchema,
  type CloudEnvEvent,
  type CloudSimulatorPlatform,
  type CloudSimulatorStatus,
} from "@shared/events";
import {
  applyCloudSimulatorStatus,
  buildCloudSimulatorExecFrameData,
  forgetCloudSimulators,
  parkCloudSimulator,
  readCloudSimulatorExecResult,
  readCloudSimulatorStatus,
  relayCloudSimulatorEvent,
  SIMULATOR_EXEC_TIMEOUT_MS,
  type CloudSimulatorExecRequest,
  type CloudSimulatorExecResult,
  type CloudSimulatorReadContext,
  type CloudSimulatorSource,
} from "./simulator";
import {
  applyCloudPreviewTemplate,
  forgetCloudPreviewTemplates,
  getCloudPreviewTemplate,
  type CloudPreviewSource,
} from "./preview";
import {
  answeredAskUserQuestionInput,
  questionsFromAskUserQuestionInput,
  isCancelledAnswers,
} from "@shared/ask-user-question";
import { getCloudConfig, setCloudIdentityChangedHandler } from "./config";
import { connectSessionSocket, type SessionSocket } from "./session-socket";
import type { AgentEventHandler } from "../event-handler";
import { relay, cancelSessionRelays } from "../tool-relay";
import { persistSessionNeedsResponse, persistSessionBackToWorking } from "../persistence";
import { invalidate } from "../../query-engine";
import { broadcast } from "../../ws.service";
import { getDatabase } from "../../../lib/database";
import { emitPtyData, emitPtyExit } from "../../pty.service";
import { getSessionRaw } from "../../../db";
import { clearGithubTokenRefreshFlights } from "../../cloud-workspace-init.service";

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
  /** In-flight request/response round-trips (diff, fs, simulator exec), keyed
   *  by requestId. requestIds are per-call UUIDs, so one map cannot cross-resolve. */
  pending: Map<string, PendingDiff>;
  /** Armed grace timer for a stopped/error state seen while a turn is live —
   *  see scheduleTurnKill. */
  pendingTurnKill: ReturnType<typeof setTimeout> | null;
  /** Client commands (permission/question answers) that arrived while the
   *  socket was between retries — drained by onOpen. */
  outbox: Record<string, unknown>[];
  /** The platform identity this socket authenticated under. A message that
   *  was already queued when an account switch closed the socket still fires
   *  its callback; frames from a previous identity are dropped at dispatch. */
  identityGeneration: number;
}

let handler: AgentEventHandler | null = null;
const sessions = new Map<string, CloudSession>();
/** Queued commands of a session whose socket gave up (terminal onDown) —
 *  handed to the next connect for that session. See sendOnLiveSocket. */
const orphanedOutboxes = new Map<string, Record<string, unknown>[]>();

/** Wire the driver to the process's one event handler. Called from service init. */
export function initCloudDriver(eventHandler: AgentEventHandler): void {
  handler = eventHandler;
  // Account switch = every open channel is authenticated as the WRONG
  // identity. Close them all; the next send reconnects under the new config.
  setCloudIdentityChangedHandler(() => {
    // Established sockets AND in-flight attempts: a connect started under
    // account A must not land its A-authenticated session into the map
    // after B signs in, and new callers must not adopt A's pending promise.
    identityGeneration += 1;
    connecting.clear();
    orphanedOutboxes.clear();
    clearGithubTokenRefreshFlights();
    for (const s of sessions.values()) {
      rejectPendingDiffs(s, "platform identity changed");
      clearTurnKill(s);
      s.socket.close();
    }
    sessions.clear();
    // The cached device statuses were account A's phones (their stream URLs
    // are capability URLs): forget them; the next connect under the right
    // account replays whatever is really there.
    forgetCloudSimulators();
    // Same for the computers' host templates: capability URLs of account A's
    // sandboxes. The next running frame / snapshot under the right account
    // restores whatever is really there.
    forgetCloudPreviewTemplates();
    // The clients hold the same account-scoped caches (device stores, host
    // templates, screenshots): tell them to start over.
    broadcast(
      JSON.stringify({
        type: "q:event",
        event: "cloud:identity",
        data: { generation: identityGeneration },
      })
    );
  });
}

function rejectPendingDiffs(session: CloudSession, reason: string): void {
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  session.pending.clear();
  // Terminals bound to this channel die with it (v1: no reattach). The
  // sidecar kills its side when the replacement socket opens; this is the
  // frontend's honest close so xterm doesn't sit frozen on a dead pipe.
  for (const [ptyId, owner] of cloudPtys) {
    if (owner === session.deusSessionId) {
      cloudPtys.delete(ptyId);
      emitPtyExit(ptyId, reason);
    }
  }
}

/** Resolve one requestId-correlated round-trip (diff, fs, simulator exec). */
function settlePending(
  session: CloudSession,
  requestId: string,
  data: Record<string, unknown>
): void {
  const pending = session.pending.get(requestId);
  if (!pending) return;
  session.pending.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(data);
}

export function shutdownCloudDriver(): void {
  forgetCloudSimulators();
  forgetCloudPreviewTemplates();
  for (const s of sessions.values()) {
    rejectPendingDiffs(s, "cloud driver shutting down");
    clearTurnKill(s);
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
  // The hosted device attaches to the SANDBOX: agnt parks every device when
  // the sandbox parks (stopped/paused/error) and settles a `stopped` status —
  // but that settle rides the session socket, which is often exactly what is
  // down when the sandbox dies. Park the cached device here too, so no client
  // keeps a stream URL for a device the platform already billed off.
  if (status === "stopped" || status === "paused" || status === "error") {
    parkCloudSimulator(workspaceId);
  }
  invalidate(["workspaces", "stats"], {});
}

/** Push an environment event to connected clients (q:event "cloud:env").
 *  Ephemeral on purpose: the chat shows a live provisioning/wake progress
 *  stack from these; nothing is persisted and a refresh clears them.
 *  Validated at this seam — a malformed platform frame is dropped here, not
 *  shipped to the UI (the workspace-row update has its own tolerance).
 *  Exported so the wake path (cloud-workspace-init) can announce synthetic states — e.g. the
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

/** The ids a platform frame is attributed to (see ./simulator, ./preview). */
function frameSource(session: CloudSession): CloudSimulatorSource & CloudPreviewSource {
  return { workspaceId: session.deusWorkspaceId, sessionId: session.deusSessionId };
}

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

/**
 * A sandbox that dies mid-turn strands the spinner: agnt keeps the execute
 * queued for replay, but a stopped/errored VM replays nothing until a wake —
 * so the live turn must FAIL VISIBLY, not hang. Reached from BOTH truth
 * sources: the live `workspace.state` frame, and the reconnect snapshot (the
 * frame is lost when the socket is down while the sandbox stops).
 * `paused` is deliberately excluded — agnt legitimately replays after a wake.
 */
/**
 * A stopped/error state with a live turn is AMBIGUOUS: either the sandbox
 * died mid-turn (nothing will ever come — the turn must fail visibly), or a
 * send just WOKE a stopped sandbox and agnt is provisioning toward running
 * exactly that queued turn (killing it here cancels the user's own restart —
 * the "Send again to restart it" loop). The tiebreaker is the next state:
 * recovery emits provisioning/resuming within seconds. So arm a grace timer
 * instead of killing immediately; any recovering state disarms it.
 */
const TURN_KILL_GRACE_MS = 20_000;

function scheduleTurnKill(session: CloudSession, status: string, detail?: string): void {
  const armedFor = handler?.liveTurnId(session.deusSessionId);
  if (!armedFor) return;
  if (session.pendingTurnKill) return;
  session.pendingTurnKill = setTimeout(() => {
    session.pendingTurnKill = null;
    // Fire only against the turn this was armed for: turn A may have settled
    // during the grace window and turn B started — killing B off A's stale
    // stopped-state would cancel a healthy fresh turn.
    if (handler?.liveTurnId(session.deusSessionId) !== armedFor) return;
    failLiveTurn(session, status, detail);
  }, TURN_KILL_GRACE_MS);
}

function clearTurnKill(session: CloudSession): void {
  if (!session.pendingTurnKill) return;
  clearTimeout(session.pendingTurnKill);
  session.pendingTurnKill = null;
}

function failLiveTurn(session: CloudSession, status: string, detail?: string): void {
  const live = handler?.liveTurnId(session.deusSessionId);
  if (!live) return;
  // Drop the SERVER-side turn before inviting a resend. agnt keeps the
  // execute queued on the session DO (reachable while the VM is down), so
  // without this the queued turn replays on the next wake and runs alongside
  // whatever the user sent — the same work twice, against the same worktree.
  try {
    session.socket.send({ type: "agent.cancel", turnId: live });
  } catch {
    // The socket is often already closing here — that is exactly the case
    // this runs in. A failed cancel must not stop the turn from failing.
  }
  dispatchFrame(session, {
    type: "turn.ended",
    sessionId: session.providerSessionId,
    turnId: live,
    stopReason: "error",
    error: {
      category: "internal",
      message: `Sandbox ${status}${detail ? ` — ${detail}` : ""}. Send again to restart it.`,
    },
    timestamp: Date.now(),
  });
}

function dispatchFrame(session: CloudSession, frame: Record<string, unknown>): void {
  const type = typeof frame.type === "string" ? frame.type : "";
  if (!type || !handler) return;
  // A socket the identity change closed can still deliver a queued message:
  // account A's status would repopulate the just-cleared caches and
  // rebroadcast its stream URL under account B. Likewise a session object a
  // reconnect has replaced no longer speaks for its id.
  if (session.identityGeneration !== identityGeneration) return;
  const current = sessions.get(session.deusSessionId);
  if (current && current !== session) return;

  // A question relayed during this turn can no longer be answered once the
  // turn is over (stopped, killed, timed out): settle its relay now — the
  // renderer drops the overlay on the tool:cancel it broadcasts — instead of
  // leaving a 24h wait whose eventual answer would reach a request the agent
  // has abandoned. (The relay's catch answers the sidecar with a deny, which
  // it ignores for a request it no longer holds.)
  if (type === "turn.ended") cancelSessionRelays(session.deusSessionId, "turn ended");

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
      // The snapshot carries the host template too — the only source after a
      // backend restart, when no `running` transition will fire again.
      if (typeof state.sandboxUrlTemplate === "string" || state.sandboxUrlTemplate === null) {
        applyCloudPreviewTemplate(frameSource(session), state.sandboxUrlTemplate);
      }
      // The device's last known status rides the snapshot too (the platform
      // mirrors its latest simulator.status there): after a backend restart
      // it is the only way to learn of a device that is still running — and
      // billing. Applied BEFORE the sandbox-status branches below, so a
      // parked sandbox overrides a mirror older than the park.
      if (state.latestSimulatorStatus && typeof state.latestSimulatorStatus === "object") {
        applyCloudSimulatorStatus(
          frameSource(session),
          state.latestSimulatorStatus as Record<string, unknown>
        );
      }
      if (sessionStatus === "paused" || sessionStatus === "stopped") {
        updateCloudWorkspace(session.deusWorkspaceId, { status: sessionStatus });
        broadcastCloudEnv(session, { status: sessionStatus });
        // The live `workspace.state` frame is LOST when the socket is down
        // while the sandbox stops; this snapshot is then the only truth, and
        // the `currentTurnId === live` early return below would strand the
        // spinner forever. Fail here, before that gate. (paused replays.)
        if (sessionStatus === "stopped") scheduleTurnKill(session, "stopped");
      } else if (sessionStatus === "error") {
        updateCloudWorkspace(session.deusWorkspaceId, { status: "error" });
        broadcastCloudEnv(session, { status: "error" });
        scheduleTurnKill(session, "error");
      } else if (sessionStatus === "provisioning") {
        // Connected mid-setup (fresh create attaches while the sandbox is
        // still building) — show the stack immediately; the step events
        // that follow append to it.
        updateCloudWorkspace(session.deusWorkspaceId, { status: "provisioning" });
        broadcastCloudEnv(session, { status: "provisioning" });
        // Recovery truth can arrive VIA the snapshot when the live
        // workspace.state frame fell into a socket gap — the reconnect
        // doesn't fire onDown (the socket retries internally), so an armed
        // kill survives to here and must be disarmed the same way the live
        // frame path disarms it.
        clearTurnKill(session);
      } else if (sessionStatus === "ready" || sessionStatus === "running") {
        updateCloudWorkspace(session.deusWorkspaceId, { status: "running" });
        clearTurnKill(session);
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
      const data = (frame.data ?? {}) as {
        status?: string;
        step?: string;
        reason?: string;
        sandboxUrlTemplate?: string | null;
      };
      updateCloudWorkspace(session.deusWorkspaceId, data);
      // The public host template rides the running state: a new sandbox
      // (reprovision) brings a new one, a platform-reported `null` means no
      // sandbox behind the session. Absent = an older platform / a state that
      // never carries it: untouched.
      if (data.sandboxUrlTemplate !== undefined) {
        applyCloudPreviewTemplate(frameSource(session), data.sandboxUrlTemplate);
      }
      broadcastCloudEnv(session, data);
      // Real case: sidecar dies on a credential error → clean WS close →
      // workspace 'stopped', and the only trace was an ephemeral env line.
      if (data.status === "stopped" || data.status === "error") {
        scheduleTurnKill(session, data.status, data.reason ?? data.step);
      } else if (
        data.status === "provisioning" ||
        data.status === "resuming" ||
        data.status === "running"
      ) {
        // Recovery underway — the queued turn replays when the sandbox is up.
        clearTurnKill(session);
      }
      return;
    }

    case "workspace.lifecycle":
      return; // step chatter — workspace.state carries the row-level truth

    case "diff.response":
    case "fs.response": {
      const data = (frame.data ?? {}) as { requestId?: string };
      if (!data.requestId) return;
      settlePending(session, data.requestId, data as Record<string, unknown>);
      return;
    }

    case "simulator.exec.response": {
      // FLAT, unlike diff/fs: the simulator family follows the browser
      // events' shape (fields beside `type`, no `data` wrapper).
      if (typeof frame.requestId !== "string") return;
      settlePending(session, frame.requestId, frame);
      return;
    }

    case "simulator.status":
      applyCloudSimulatorStatus(frameSource(session), frame);
      return;

    case "simulator.screenshot":
    case "simulator.action_result":
      relayCloudSimulatorEvent(
        frameSource(session),
        type === "simulator.screenshot" ? "screenshot" : "action_result",
        frame
      );
      return;

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
      const data = (frame.data ?? {}) as {
        requestId?: string;
        toolName?: unknown;
        input?: unknown;
      };
      if (!data.requestId) return;
      // Claude Code's built-in AskUserQuestion collects its answers THROUGH
      // this bridge (questions in `input`, answers back in `updatedInput`) —
      // and it is the question tool the model actually uses. Auto-allowing it
      // returned an empty answer set: the agent reported the question as
      // dismissed. Route it to the same overlay as the MCP question tool.
      const questions =
        data.toolName === "AskUserQuestion" ? questionsFromAskUserQuestionInput(data.input) : [];
      if (questions.length > 0) {
        void relayAskUserQuestionPermission(session, data.requestId, data.input, questions);
        return;
      }
      void sendPermissionResponse(session, data.requestId, { behavior: "allow" });
      return;
    }

    case "pty.data": {
      const data = (frame.data ?? {}) as { ptyId?: string; data?: string };
      if (!data.ptyId || typeof data.data !== "string") return;
      if (!cloudPtys.has(data.ptyId)) return; // late frames after kill
      emitPtyData(data.ptyId, Array.from(Buffer.from(data.data, "base64")));
      return;
    }

    case "pty.exit": {
      const data = (frame.data ?? {}) as { ptyId?: string; error?: string };
      if (!data.ptyId || !cloudPtys.has(data.ptyId)) return;
      cloudPtys.delete(data.ptyId);
      emitPtyExit(data.ptyId, data.error);
      return;
    }

    default:
      // browser.*, hook.*, checkpoint:* — later sprints.
      return;
  }
}

/**
 * The socket serving the session NOW. The one a question arrived on may be
 * gone by the time the user answers — `onDown` drops it from the map and
 * nothing reopens it until the next send — while the sidecar's request is
 * still pending (24h). So an answer reconnects rather than being dropped: a
 * dropped answer left the agent blocked behind an overlay the user had
 * already closed.
 */
async function sendOnLiveSocket(
  deusSessionId: string,
  frame: Record<string, unknown>
): Promise<void> {
  const live = sessions.get(deusSessionId);
  if (live?.socket.isOpen()) {
    live.socket.send(frame);
    return;
  }
  if (live) {
    // In the map but not open: the socket is between retries (it keeps
    // reconnecting in the background). Park the frame; onOpen drains it.
    live.outbox.push(frame);
    return;
  }
  // No session at all (the socket gave up earlier): park the frame FIRST — a
  // reconnect whose setup fails (mint, token exchange) must not lose a freshly
  // submitted answer — then connect. The replacement inherits the parked
  // queue when it registers and drains it on open; if setup fails the frame
  // simply waits for the next connect. ready()'s deadline rejecting while the
  // fresh socket keeps retrying is covered the same way: the registered
  // session already holds the frame.
  orphanedOutboxes.set(deusSessionId, [...(orphanedOutboxes.get(deusSessionId) ?? []), frame]);
  await ensureCloudSession(deusSessionId);
  const opened = sessions.get(deusSessionId);
  if (opened?.socket.isOpen()) flushOutbox(opened);
}

function flushOutbox(session: CloudSession): void {
  for (const frame of session.outbox.splice(0)) {
    try {
      session.socket.send(frame);
    } catch (err) {
      console.warn(`[CloudDriver] queued command not delivered: ${String(err)}`);
    }
  }
}

/** Answer a permission request over the session's live socket. Never throws
 *  out of the relay's settle path: a failed delivery is logged and the
 *  sidecar's own timeout settles the request. */
async function sendPermissionResponse(
  session: CloudSession,
  requestId: string,
  result:
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message: string }
): Promise<void> {
  try {
    await sendOnLiveSocket(session.deusSessionId, {
      type: "permission.response",
      // Nested under `data` like every ClientCommand payload (see mcp.answer).
      data: { requestId, sessionId: session.providerSessionId, result },
    });
  } catch (err) {
    console.warn(`[CloudDriver] permission response not delivered (${requestId}): ${String(err)}`);
  }
}

/** The permission-bridge twin of `relayQuestion`: same overlay, answered as
 *  an allow whose `updatedInput` carries the answers (deny on cancel/failure —
 *  the agent sees "declined" rather than a silent empty answer set). */
async function relayAskUserQuestionPermission(
  session: CloudSession,
  requestId: string,
  input: unknown,
  questions: ReturnType<typeof questionsFromAskUserQuestionInput>
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
      params: { sessionId, questions },
      timeoutMs: 24 * 60 * 60 * 1000,
    });
    const answers = extractAnswers(response);
    const cancelled = isCancelledAnswers(answers);
    await sendPermissionResponse(
      session,
      requestId,
      cancelled
        ? { behavior: "deny", message: "The user dismissed the question" }
        : { behavior: "allow", updatedInput: answeredAskUserQuestionInput(input, answers) }
    );
  } catch (err) {
    console.warn(`[CloudDriver] askUserQuestion (permission) relay failed: ${String(err)}`);
    await sendPermissionResponse(session, requestId, {
      behavior: "deny",
      message: "Question relay failed",
    });
  } finally {
    const back = persistSessionBackToWorking(sessionId);
    if (back.ok)
      invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
  }
}

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
    // The ClientCommand schema nests the payload under `data` (the DO spreads
    // `command.data` toward the sidecar); a flat frame fails its parse and the
    // agent waits out the sidecar's question timeout unanswered.
    await sendOnLiveSocket(session.deusSessionId, {
      type: "mcp.answer",
      data: { questionId: data.questionId, sessionId: session.providerSessionId, answers },
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
/** Bumped on every platform-identity change; stale connects check it. */
let identityGeneration = 0;

/**
 * Monotonic account-switch counter. Callers that await across the identity
 * boundary (cloud-workspace-init's refresh path) capture it before the await
 * and bail on mismatch — the clear()-based invalidation cannot cover work
 * that REGISTERS after the clear ran.
 */
export function getCloudIdentityGeneration(): number {
  return identityGeneration;
}

/** Open (or return) the live socket for a cloud session. Concurrent callers
 *  (create pipeline vs. a fast first send, diff polls vs. wake) share one
 *  in-flight connect — a lost race would leak a second socket that
 *  double-delivers every frame to the fold. */
export async function ensureCloudSession(deusSessionId: string): Promise<CloudSession> {
  const existing = sessions.get(deusSessionId);
  if (existing?.socket.isOpen()) return existing;

  const inFlight = connecting.get(deusSessionId);
  if (inFlight) return inFlight;

  const attempt: Promise<CloudSession> = connectCloudSession(deusSessionId).finally(() => {
    // Only OUR entry: an identity change clears the map and a new attempt may
    // already occupy this key — an unconditional delete would evict the
    // replacement and let a later caller open a duplicate socket.
    if (connecting.get(deusSessionId) === attempt) connecting.delete(deusSessionId);
  });
  connecting.set(deusSessionId, attempt);
  return attempt;
}

async function connectCloudSession(deusSessionId: string): Promise<CloudSession> {
  const existing = sessions.get(deusSessionId);
  if (existing?.socket.isOpen()) return existing;
  // Answers queued on the replaced (or given-up) socket belong to the session,
  // not the socket: the sidecar's request is still pending, so they ride the
  // replacement instead of dying with the old channel. They wait in
  // `orphanedOutboxes` until the replacement is REGISTERED — a failed mint or
  // token exchange below must not be the moment they vanish.
  if (existing && existing.outbox.length > 0) {
    orphanedOutboxes.set(deusSessionId, [
      ...(orphanedOutboxes.get(deusSessionId) ?? []),
      ...existing.outbox.splice(0),
    ]);
  }
  if (existing) {
    clearTurnKill(existing);
    // The replaced channel's in-flight reads AND its terminals die here —
    // without this sweep a socket blip left cloud ptys as live cursors
    // silently swallowing keystrokes (no exit ever emitted).
    rejectPendingDiffs(existing, "session channel reconnecting");
    existing.socket.close();
  }
  sessions.delete(deusSessionId);

  const generationAtStart = identityGeneration;
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
      // Which engine runs this session. Discovery (the Mac-closed web list)
      // projects it back, so a codex session keeps its harness — a bare
      // discovery row would otherwise default to claude and the next direct
      // send would run the turn under the wrong agent + credential.
      metadata: { harness: row.agent_harness },
    });
    if (generationAtStart !== identityGeneration) {
      // The account changed while createSession was in flight. Persisting the
      // OLD identity's provider id would poison the row: every later connect
      // under the new account would reuse it and fail its token mint forever.
      throw new Error("Platform identity changed during connect — retry under the new account");
    }
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run(
      created.id,
      deusSessionId
    );
    row.provider_session_id = created.id;
  }

  // Stamp the harness on EVERY connect, not just the lazy-create branch: the
  // workspace pipeline pre-creates the provider session (before any harness is
  // known) and stores its id, so that branch is skipped for a workspace's
  // first session — and `createSession` converging on an existing row keeps
  // its metadata anyway. Idempotent and best-effort; discovery merely degrades
  // to its claude default if it's lost.
  void pushCloudSessionMetadata(row.provider_session_id, { harness: row.agent_harness }, config);
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
    pending: new Map(),
    pendingTurnKill: null,
    outbox: [...(orphanedOutboxes.get(deusSessionId) ?? [])],
    identityGeneration: generationAtStart,
    // Assigned below — the frame callback closes over the session object.
    socket: undefined as unknown as SessionSocket,
  };
  session.socket = connectSessionSocket({
    baseUrl: config.baseUrl,
    providerSessionId: row.provider_session_id,
    token,
    onFrame: (frame) => dispatchFrame(session, frame),
    onOpen: () => flushOutbox(session),
    onDown: (reason) => {
      console.warn(`[CloudDriver] socket down session=${deusSessionId}: ${reason}`);
      // Queued answers outlive the socket that gave up: the next connect for
      // this session (the next send, or the next answer) inherits them.
      if (session.outbox.length > 0) {
        orphanedOutboxes.set(deusSessionId, [
          ...(orphanedOutboxes.get(deusSessionId) ?? []),
          ...session.outbox.splice(0),
        ]);
      }
      rejectPendingDiffs(session, reason);
      // The armed kill (if any) must not fire against a torn-down session —
      // the reconnect's own snapshot re-evaluates the sandbox truthfully.
      clearTurnKill(session);
      sessions.delete(deusSessionId);
    },
  });
  if (generationAtStart !== identityGeneration) {
    // The account changed while this connect was in flight: the socket is
    // authenticated as the PREVIOUS identity and must not enter the map.
    session.socket.close();
    throw new Error("Platform identity changed during connect — retry under the new account");
  }
  sessions.set(deusSessionId, session);
  // Registered: the queue now lives on the session (drained by onOpen).
  orphanedOutboxes.delete(deusSessionId);
  await session.socket.ready();
  return session;
}

// ---- Session metadata (what discovery shows the Mac-closed web) ----

/**
 * Merge client-owned facts (`title`, `harness`) into the platform session's
 * metadata via `PATCH /sessions/:id/metadata`. Best-effort by design: the web
 * list degrades (untitled row, claude default) if it's lost, and the platform
 * may predate the endpoint — a 404 is logged once, never thrown.
 */
async function pushCloudSessionMetadata(
  providerSessionId: string,
  metadata: Record<string, string>,
  config: { baseUrl: string; apiKey: string }
): Promise<void> {
  // One provider session's pushes run in order. The connect-time default
  // stamp and the first-send restamp both write `harness`; two independent
  // fire-and-forget PATCHes could land with the older value last and hand
  // discovery a Codex session labelled Claude.
  const prev = metadataPushChains.get(providerSessionId) ?? Promise.resolve();
  const run = prev.then(() => patchCloudSessionMetadata(providerSessionId, metadata, config));
  metadataPushChains.set(providerSessionId, run);
  await run;
  if (metadataPushChains.get(providerSessionId) === run)
    metadataPushChains.delete(providerSessionId);
}

const metadataPushChains = new Map<string, Promise<void>>();

async function patchCloudSessionMetadata(
  providerSessionId: string,
  metadata: Record<string, string>,
  config: { baseUrl: string; apiKey: string }
): Promise<void> {
  try {
    const res = await fetch(
      `${config.baseUrl}/sessions/${encodeURIComponent(providerSessionId)}/metadata`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ metadata }),
      }
    );
    if (!res.ok) {
      console.warn(
        `[CloudDriver] session metadata push failed (${res.status}) for ${providerSessionId}`
      );
    }
  } catch (err) {
    console.warn(`[CloudDriver] session metadata push failed: ${String(err)}`);
  }
}

/**
 * Merge client-owned facts (`title`, `harness`) onto a deus session's cloud
 * twin, so the Mac-closed web lists it by name and seeds the right agent.
 * No-op for local sessions and for cloud sessions whose twin doesn't exist
 * yet (the create path stamps then).
 */
export function pushCloudSessionFacts(
  deusSessionId: string,
  metadata: Record<string, string>
): void {
  const config = getCloudConfig();
  if (!config) return;
  const row = getDatabase()
    .prepare(
      `SELECT s.provider_session_id AS provider_session_id, w.kind AS kind
         FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.id = ?`
    )
    .get(deusSessionId) as { provider_session_id?: string | null; kind?: string } | undefined;
  if (row?.kind !== "cloud" || !row.provider_session_id) return;
  void pushCloudSessionMetadata(row.provider_session_id, metadata, config);
}

/** Mirror a deus session's title onto its cloud twin. */
export function pushCloudSessionTitle(deusSessionId: string, title: string): void {
  pushCloudSessionFacts(deusSessionId, { title });
}

// ---- Turn API (mirrors the local agentService surface) ----

export interface CloudTurnOptions {
  /** Model override — agnt's sidecar honors options.model (else its default). */
  model?: string;
  /** Which engine harness runs the turn; the wire defaults to claude-code. */
  agentHarness?: string;
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
    if (options.agentHarness === "codex-app-server") {
      // Codex: the credential is the auth.json FILE, held only as the
      // canonical platform secret — the session DO resolves it at dispatch
      // (deus's backend never carries it). Only the harness rides the wire.
      wsOptions.harness = "codex-app-server";
    } else if (config.claudeOauthToken) {
      // Deus picks the per-turn credential EXPLICITLY — subscription first,
      // API key fallback. No env-ordering accidents like the raw CLI (where
      // a stray ANTHROPIC_API_KEY silently outranks the subscription token).
      // The oauth branch requires agnt's authKind-aware sidecar (0.3.1+).
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

/**
 * Whether a channel to this session is OPEN right now.
 *
 * Without one, the workspace row's `init_stage` is not evidence of anything:
 * the driver only learns "paused"/"stopped" from a snapshot, so after a
 * backend restart the row reads NULL for a sandbox that is actually asleep.
 */
export function hasLiveCloudSession(deusSessionId: string): boolean {
  return sessions.get(deusSessionId)?.socket.isOpen() ?? false;
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

/** One requestId-correlated round-trip against the sandbox. The `<type>.request`
 *  frame is answered by the matching `<type>.response`, resolved by requestId
 *  in dispatchFrame. Diff, fs and the simulator exec share this — the only
 *  differences are the frame name and the deadline (a device verb can wait on
 *  a UI target; a diff cannot). */
function roundTrip(
  session: CloudSession,
  type: "diff.request" | "fs.request" | "simulator.exec.request",
  request: Record<string, unknown>,
  timeoutMs = DIFF_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  const requestId = crypto.randomUUID();
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(requestId);
      reject(new Error(`cloud ${type} timed out`));
    }, timeoutMs);
    session.pending.set(requestId, { resolve, reject, timer });
  });
  try {
    session.socket.send({ type, data: { ...request, requestId } });
  } catch (err) {
    // Socket closed between ensureCloudSession and send — reject NOW instead
    // of leaking the pending entry until its timeout fires an unhandled reject.
    const entry = session.pending.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      session.pending.delete(requestId);
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return response;
}

/** One diff.request round-trip against the sandbox's live worktree. */
export async function requestCloudDiff(
  deusSessionId: string,
  request: CloudDiffRequest
): Promise<Record<string, unknown>> {
  const session = await ensureCloudSession(deusSessionId);
  return roundTrip(session, "diff.request", request as Record<string, unknown>);
}

/** One fs.request round-trip (list/read) against the sandbox worktree. */
export async function requestCloudFs(
  deusSessionId: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const session = await ensureCloudSession(deusSessionId);
  return roundTrip(session, "fs.request", request);
}

// ── Cloud PTY: the frontend's pty:* commands, rerouted onto the session channel.
// Registry maps a frontend ptyId to the deus session whose channel carries it —
// write/resize/kill arrive with only the ptyId.
const cloudPtys = new Map<string, string>();

export function isCloudPty(ptyId: string): boolean {
  return cloudPtys.has(ptyId);
}

export async function openCloudPty(
  deusSessionId: string,
  args: { ptyId: string; cols: number; rows: number; cwd?: string }
): Promise<void> {
  const session = await ensureCloudSession(deusSessionId);
  cloudPtys.set(args.ptyId, deusSessionId);
  try {
    session.socket.send({ type: "pty.open", data: { ...args } });
  } catch (err) {
    cloudPtys.delete(args.ptyId); // never leak a registry entry for a frame that never left
    throw err;
  }
}

export function writeCloudPty(ptyId: string, bytes: number[]): void {
  const session = sessions.get(cloudPtys.get(ptyId) ?? "");
  if (!session) throw new Error(`Cloud PTY not found: ${ptyId}`);
  session.socket.send({
    type: "pty.input",
    data: { ptyId, data: Buffer.from(bytes).toString("base64") },
  });
}

export function resizeCloudPty(ptyId: string, cols: number, rows: number): void {
  const session = sessions.get(cloudPtys.get(ptyId) ?? "");
  if (!session) return;
  session.socket.send({ type: "pty.resize", data: { ptyId, cols, rows } });
}

export function killCloudPty(ptyId: string): void {
  const session = sessions.get(cloudPtys.get(ptyId) ?? "");
  cloudPtys.delete(ptyId);
  if (!session) return;
  session.socket.send({ type: "pty.close", data: { ptyId } });
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

// ---- Hosted simulator control (the same device the agent drives) ----
// State and effects live in ./simulator.ts; what stays here is what rides the
// session channel: which socket a device command goes to, and the round-trip.

export {
  parseCloudSimulatorPlatform,
  type CloudSimulatorExecRequest,
  type CloudSimulatorExecResult,
} from "./simulator";

/**
 * The channel every device command rides: the workspace's current session.
 * The device belongs to the WORKSPACE (agnt fans its status out to every
 * session, and a late joiner gets the current state on connect), so any
 * session would do — the current one is the one most likely to already hold
 * an open socket.
 */
function currentCloudSessionRow(workspaceId: string): {
  sessionId: string;
  providerSessionId: string | null;
} {
  const row = getDatabase()
    .prepare(
      `SELECT w.kind AS kind, w.current_session_id AS session_id, s.provider_session_id AS provider_session_id
         FROM workspaces w LEFT JOIN sessions s ON s.id = w.current_session_id
        WHERE w.id = ?`
    )
    .get(workspaceId) as
    | { kind?: string; session_id?: string | null; provider_session_id?: string | null }
    | undefined;
  if (!row) throw new Error(`Workspace not found: ${workspaceId}`);
  if (row.kind !== "cloud") throw new Error("Hosted simulators run in cloud workspaces only");
  if (!row.session_id) {
    throw new Error("This cloud workspace has no session to reach its sandbox through");
  }
  let providerSessionId = row.provider_session_id ?? null;
  if (!providerSessionId) {
    // A chat that never sent a cloud turn has no platform session yet — but
    // the DEVICE belongs to the workspace's sandbox, not to a chat, so an
    // older, provisioned chat of the same workspace reports it just as well.
    // Without this, a fresh chat next to a running (billing) device would
    // read "no device" and offer Start.
    const sibling = getDatabase()
      .prepare(
        `SELECT provider_session_id FROM sessions
          WHERE workspace_id = ? AND provider_session_id IS NOT NULL
          ORDER BY COALESCE(last_user_message_at, updated_at) DESC
          LIMIT 1`
      )
      .get(workspaceId) as { provider_session_id?: string | null } | undefined;
    providerSessionId = sibling?.provider_session_id ?? null;
  }
  return { sessionId: row.session_id, providerSessionId };
}

async function cloudSessionForWorkspace(workspaceId: string): Promise<CloudSession> {
  return ensureCloudSession(currentCloudSessionRow(workspaceId).sessionId);
}

/** The workspace's device status right now — see readCloudSimulatorStatus for
 *  when the cache answers and when the platform does. */
export async function getCloudSimulatorStatus(
  workspaceId: string
): Promise<CloudSimulatorStatus | null> {
  let context: CloudSimulatorReadContext;
  try {
    const row = currentCloudSessionRow(workspaceId);
    context = {
      sessionId: row.sessionId,
      providerSessionId: row.providerSessionId,
      liveSocket: sessions.get(row.sessionId)?.socket.isOpen() === true,
    };
  } catch {
    // Not a cloud workspace / no session: nothing to ask the platform with.
    context = { sessionId: null, providerSessionId: null, liveSocket: false };
  }
  return readCloudSimulatorStatus(workspaceId, context);
}

/** The one-shot read behind `cloudPreview`. The platform's REST carries no
 *  template — only a session socket does (the running frame, the snapshot) —
 *  so an unknown template with no socket to bring it (this backend restarted,
 *  or an identity change closed every socket while the workspace stayed
 *  selected) is an unanswerable read: open the workspace's session and let its
 *  snapshot announce the template as cloud:preview. `undefined` tells the
 *  client to keep waiting rather than render "no sandbox". */
export function readCloudPreviewTemplate(workspaceId: string): string | null | undefined {
  const known = getCloudPreviewTemplate(workspaceId);
  if (known !== undefined) return known;
  try {
    void cloudSessionForWorkspace(workspaceId).catch((err) => {
      console.warn(
        `[CloudDriver] preview reseed connect failed for ${workspaceId}: ${String(err)}`
      );
    });
  } catch {
    // Not a cloud workspace, or no session yet: nothing could carry a template.
  }
  return undefined;
}

/** Boot a hosted device. The outcome rides simulator.status (starting → ready,
 *  or error) — the resolved promise only says the sandbox channel took it. */
export async function startCloudSimulator(
  workspaceId: string,
  platform?: CloudSimulatorPlatform
): Promise<void> {
  const session = await cloudSessionForWorkspace(workspaceId);
  session.socket.send({ type: "simulator.start", data: platform ? { platform } : {} });
}

/** Stop one device, or every running one when no platform is named. */
export async function stopCloudSimulator(
  workspaceId: string,
  platform?: CloudSimulatorPlatform
): Promise<void> {
  const session = await cloudSessionForWorkspace(workspaceId);
  session.socket.send({ type: "simulator.stop", data: platform ? { platform } : {} });
}

/** One device verb, answered by simulator.exec.response (correlated by
 *  requestId like diff/fs). Any exec counts as device activity for the
 *  platform's idle stop — the tab's keep-alive is an `appstate` through here. */
export async function execCloudSimulator(
  workspaceId: string,
  request: CloudSimulatorExecRequest
): Promise<CloudSimulatorExecResult> {
  const data = buildCloudSimulatorExecFrameData(request);
  const session = await cloudSessionForWorkspace(workspaceId);
  const response = await roundTrip(
    session,
    "simulator.exec.request",
    data,
    SIMULATOR_EXEC_TIMEOUT_MS
  );
  return readCloudSimulatorExecResult(response);
}
