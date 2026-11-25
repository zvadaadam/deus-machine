// backend/src/services/agent/turns.ts
// Strict turn admission and cancellation, shared by the composer, its queue and the operator.
// The engine's echo writes the user's message. The caller keeps the prompt until admission.

import { createHash } from "node:crypto";
import { WireRequestError } from "@zvada/agent-server/client";
import { WIRE_ERROR_CODES, type AgentInput, type Origin } from "@zvada/agent-server/protocol";
import type * as api from "@shared/api/sessions";
import type { ParsedInputOf } from "@shared/api/op";
import { uuidv7 } from "@shared/lib/uuid";
import { readPermissionMode, readThinkingLevel } from "@shared/protocol";
import { readCloudTurnSelection, type CloudTurnSelection } from "@shared/cloud-models";
import { canPlan, HARNESSES } from "@shared/harnesses";
import { ACTIVE_TURN_STATUSES } from "@shared/enums";
import { getDatabase } from "../../lib/database";
import {
  AgentServerDisconnectedError,
  ChatBusyError,
  ConflictError,
  DifferentTurnMessageError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors";
import { encodeOrigin, getSessionRaw, getTurn, getWorkspaceForMiddleware } from "../../db";
import { computeWorkspacePath } from "../../middleware/workspace-loader";
import {
  persistLastUserMessageAt,
  persistSessionError,
  persistSessionWorking,
} from "./persistence";
import { invalidate, onInvalidate } from "../query-engine";
import * as agentService from "./service";
import { toEngineInput, withoutImageParts } from "./run-config";
import {
  startCloudTurn,
  cancelCloudTurn,
  isCloudSession,
  hasLiveCloudSession,
  announceCloudEnv,
  pushCloudSessionFacts,
} from "./cloud/driver";
import { refreshWorkspaceGithubToken } from "../cloud-workspace-init.service";
import { rollbackSendWake, setCloudWakeStage, watchCloudReports } from "../workspace-lifecycle";

// ---- sendMessage ----

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** The sends of a turn id this process has asked the engine for, per database, by session and turn, for a while. */
type Admission = { content: string; origin: string | null; done: Promise<{ turnId: string }> };
const admissionsOf = new WeakMap<object, Map<string, Admission>>();
const ADMISSION_KEPT_MS = 10 * 60_000;

/** Stop interrupts app setup. Once turn/start is on the wire, Stop waits for its answer. */
type Starting = {
  turnId: string;
  preparing: AbortController;
  done: Promise<void>;
  stoppedBy?: Origin;
};
type SetupEnd = { turnId: string; outcome: "cancelled"; cancelledBy: Origin };
const admitting = new Map<string, Starting | SetupEnd>();

function startingTurn(sessionId: string) {
  const entry = admitting.get(sessionId);
  return entry && "preparing" in entry ? entry : undefined;
}

export function currentTurnId(sessionId: string) {
  return agentService.liveTurnId(sessionId) ?? startingTurn(sessionId)?.turnId;
}

export function stoppedBeforeStart(sessionId: string) {
  const entry = admitting.get(sessionId);
  return entry && "cancelledBy" in entry ? entry : undefined;
}

const STEER_READ = new ConflictError("The agent already read this message.");

export async function withdrawSteerRetry(sessionId: string, turnId: string) {
  const admission = startingTurn(sessionId);
  if (admission?.turnId !== turnId) return false;
  admission.preparing.abort(STEER_READ);
  return admission.done.then(
    () => false,
    (error) => error === STEER_READ
  );
}

// A turn stopped before the wire ends in memory; it was never in the transcript.
let unwatchEnds: (() => void) | undefined;
function recordSetupStop(sessionId: string, turnId: string, cancelledBy: Origin) {
  admitting.set(sessionId, { turnId, cancelledBy, outcome: "cancelled" });
  unwatchEnds ??= onInvalidate((resources, ctx) => {
    if (
      ctx?.sessionIds?.length ||
      !(resources.includes("workspaces") || resources.includes("sessions"))
    )
      return;
    const ended = [...admitting.keys()].filter((id) => stoppedBeforeStart(id));
    const gone = getDatabase()
      .prepare<[string], { id: string }>(
        `SELECT value AS id FROM json_each(?) WHERE NOT EXISTS (
         SELECT 1 FROM sessions s JOIN workspaces w ON s.workspace_id = w.id
         WHERE s.id = value AND s.is_hidden = 0 AND w.state != 'archived')`
      )
      .all(JSON.stringify(ended));
    for (const { id } of gone) admitting.delete(id);
    if (ended.length === gone.length) {
      unwatchEnds?.();
      unwatchEnds = undefined;
    }
  });
}

export function requireSameHarness(current: string, requested: string): void {
  if (current !== requested)
    throw new ConflictError(
      `Cannot switch agent from ${current} to ${requested} on a session with messages. Open a new chat tab instead.`
    );
}

/** Compare the content the echo kept, independent of the ids assigned to its parts. */
function matchesEcho(messageId: string, input: AgentInput, kind: "turn" | "steer") {
  const stored = getDatabase()
    .prepare<[string], { data: string }>("SELECT data FROM parts WHERE message_id = ? ORDER BY seq")
    .all(messageId)
    .map(({ data }) => JSON.parse(data) as Record<string, unknown>);
  const received = stored.some((part) => part.type === "image") ? input : withoutImageParts(input);
  if (typeof received === "string") {
    if (stored.some((part) => part.type !== "text")) return false;
    const text = stored.map((part) => part.text).join("");
    return kind === "turn" ? text.trim() === received.trim() : text === received;
  }
  return (
    received.length === stored.length &&
    received.every((part, i) => {
      const echo = stored[i];
      if (part.type !== echo?.type) return false;
      if (part.type === "text") return part.text === echo.text;
      return (
        part.mimeType === echo.mimeType &&
        part.data === echo.data &&
        part.url === echo.url &&
        (part.type !== "file" || part.filename === echo.filename)
      );
    })
  );
}

/** A durable read receipt belongs to one turn and sender. A live turn knows the input it took. */
export function retryReadSteer(
  { sessionId, turnId, content, agentHarness }: ParsedInputOf<typeof api.steerMessage>,
  steerId: string,
  origin?: Origin
) {
  const echo = getDatabase()
    .prepare<
      [string, string],
      { id: string; turn_id: string; origin: string | null }
    >("SELECT id, turn_id, origin FROM messages WHERE session_id = ? AND steer_id = ?")
    .get(sessionId, steerId);
  if (!echo) return;
  if (echo.turn_id !== turnId || echo.origin !== encodeOrigin(origin))
    throw new DifferentTurnMessageError();
  const input = toEngineInput(content);
  if (agentService.liveTurnId(sessionId) === turnId)
    return agentService.steerTurn(agentHarness, {
      sessionId,
      turnId,
      steerId,
      input,
      origin,
    });
  if (!matchesEcho(echo.id, input, "steer")) throw new DifferentTurnMessageError();
  return true;
}

/** Replay an admission without starting another turn. */
export function previousSend(
  input: ParsedInputOf<typeof api.sendMessage>,
  turnId: string,
  origin?: Origin
) {
  const known = admissionsOf.get(getDatabase())?.get(`${input.sessionId}\0${turnId}`);
  if (known) {
    if (known.content !== digest(input.content) || known.origin !== encodeOrigin(origin))
      throw new DifferentTurnMessageError();
    return known.done;
  }
  const db = getDatabase();
  if (!getTurn(db, input.sessionId, turnId)) return;
  const echo = db
    .prepare<[string, string], { id: string; origin: string | null; kind: string }>(
      `SELECT m.id, m.origin, w.kind FROM messages m
       JOIN sessions s ON s.id = m.session_id JOIN workspaces w ON w.id = s.workspace_id
       WHERE m.session_id = ? AND m.turn_id = ? AND m.role = 'user' ORDER BY m.seq LIMIT 1`
    )
    .get(input.sessionId, turnId);
  if (echo) {
    const received = echo.kind === "cloud" ? input.content : toEngineInput(input.content);
    if (echo.origin !== encodeOrigin(origin) || !matchesEcho(echo.id, received, "turn"))
      throw new DifferentTurnMessageError();
  }
  return Promise.resolve({ turnId });
}

/**
 * Start a turn in a session. Rejects when the turn
 * is not admitted. The same turn id asked again (a caller retrying a send
 * whose answer it lost) answers as the first did, once that one's admission
 * is known: success only for the same request (text and sender), a pending
 * one awaited, a failed one failed; a different request under that id is a
 * conflict. Its state is left as it is.
 */
export async function sendMessage(
  input: ParsedInputOf<typeof api.sendMessage>,
  origin?: Origin
): Promise<{ turnId: string }> {
  const turnId = input.turnId;
  if (!turnId) return sendMessageOnce(input, origin);
  const previous = previousSend(input, turnId, origin);
  if (previous) return previous;
  const key = `${input.sessionId}\0${turnId}`;
  // Its text kept as a digest: a send with images would otherwise sit in memory for minutes.
  const request = { content: digest(input.content), origin: encodeOrigin(origin) };
  const db = getDatabase();
  let admissions = admissionsOf.get(db);
  if (!admissions) admissionsOf.set(db, (admissions = new Map()));
  const done = sendMessageOnce(input, origin);
  admissions.set(key, { ...request, done });
  // A send that failed was not admitted: a retry runs anew.
  const kept = admissions;
  done.catch(() => kept.delete(key));
  setTimeout(() => {
    if (kept.get(key)?.done === done) kept.delete(key);
  }, ADMISSION_KEPT_MS).unref?.();
  return done;
}

async function sendMessageOnce(
  input: ParsedInputOf<typeof api.sendMessage>,
  /** Who sent it when not the person: the operator's host passes it; the operation's input never carries one. */
  origin?: Origin
): Promise<{ turnId: string }> {
  const { sessionId, content, model, agentHarness } = input;
  const permissionMode = readPermissionMode(input.permissionMode);
  if (input.permissionMode !== undefined && permissionMode === undefined) {
    throw new ValidationError("Unsupported permission mode");
  }

  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);

  // Harness lock: once a session has messages, its agent harness is bound to
  // a specific SDK process. Reject cross-harness switches to keep the server
  // authoritative; the UI disables these options too, but this is the source
  // of truth.
  if (session && session.message_count > 0) requireSameHarness(session.agent_harness, agentHarness);

  // A send against an active turn would persist a user message that no agent
  // will ever answer (the wire rejects the turn with turnActive and the
  // composer shows nothing). "Needs input" counts as active too: plan
  // approval and questions park the RUNNING turn while the overlay waits.
  // The wire guard covers the same race during admission.
  if (session?.is_hidden) throw new ConflictError("That chat is archived; it takes no messages.");
  if (session && ACTIVE_TURN_STATUSES.includes(session.status)) {
    throw new ChatBusyError(
      session.status === "working"
        ? "The agent is still working — wait for the current turn to finish."
        : "The agent is waiting for your response — answer the pending prompt first."
    );
  }

  // Resolve the workspace server-side: it decides the TRANSPORT (local
  // agent-server vs cloud driver) and, for local, the authoritative cwd —
  // caller-provided values are ignored. Resolved before ANY write below so
  // lane validation can reject without touching state.
  const workspace = session ? getWorkspaceForMiddleware(db, session.workspace_id) : undefined;
  const isCloud = workspace?.kind === "cloud";
  let cwd: string | undefined;
  if (workspace && !isCloud) {
    cwd = computeWorkspacePath(workspace) ?? undefined;
  }

  // AGNT chooses no harness, model or thinking level and refuses a turn that
  // leaves one out. Read all three in the platform's vocabulary here, before
  // every write below, so a send without them is refused in words instead of
  // failing on the socket after the session flipped to working.
  let cloudSelection: CloudTurnSelection | undefined;
  if (isCloud) {
    const read = readCloudTurnSelection({
      harness: agentHarness,
      model,
      thinkingLevel: input.thinkingLevel,
    });
    if (!read.ok) throw new ValidationError(read.message);
    cloudSelection = read.selection;
  } else if (permissionMode === "plan" && !canPlan(agentHarness, workspace?.kind)) {
    throw new ValidationError(`${HARNESSES[agentHarness].label} does not offer plan mode.`);
  }

  // New sessions default to Claude at creation time because the user may pick
  // the actual harness in the composer before the first send. Persist that
  // first-send choice so follow-up turns route to the same agent process.
  //
  // AFTER the active-turn guard, and that ordering is the whole point: the
  // harness column must only move for a send that is actually going to run.
  // The first turn of a session opens an ECHO-ONLY window — the status is
  // already "working" while `message_count` is still 0, because the user row
  // is written by the engine's echo, not by this handler. A second client
  // sending a DIFFERENT harness inside that window passes the lock above
  // (0 messages, nothing to lock), and rebinding there would point the row at
  // harness B while the admitted turn runs under A — after which the echo
  // lands and the lock rejects every follow-up send under A. The guard above
  // now rejects that second send before it can write anything.
  //
  // Nothing awaits between the read at the top of this function and this
  // write, so within the one process that owns this database the guard and the
  // write cannot be interleaved by another send.
  if (session && session.message_count === 0 && session.agent_harness !== agentHarness) {
    const result = db
      .prepare(
        `
        UPDATE sessions
        SET agent_harness = ?, updated_at = datetime('now')
        WHERE id = ? AND message_count = 0
      `
      )
      .run(agentHarness, sessionId);

    if (result.changes === 0) {
      const current = getSessionRaw(db, sessionId);
      if (current) requireSameHarness(current.agent_harness, agentHarness);
    } else if (isCloud) {
      // The driver's connect-time harness stamp already ran for this session
      // under its DEFAULT harness: the workspace pipeline pre-opens the socket
      // before any choice is made, and that open socket short-circuits every
      // later `ensureCloudSession`. Restamp the choice now, or discovery keeps
      // listing the session as Claude and the web seeds the wrong agent.
      pushCloudSessionFacts(sessionId, { harness: agentHarness });
    }
  }

  // 1. Flip the session to "working" optimistically. The user's MESSAGE row is
  // NOT written here: the engine echoes the prompt back as
  // message.started{role:"user"} and that echo is the single persistence path
  // for message rows (same turn_id, same parts, one writer). The frontend
  // renders its own optimistic bubble from cache until the echo lands.
  //
  // The STATUS is all that moves optimistically. `sentAt` is the send's own
  // clock reading, but it is not written until the turn is admitted, below.
  const sentAt = new Date().toISOString();
  const working = persistSessionWorking(sessionId);
  if (!working.ok) throw new Error(working.error);
  invalidate(["workspaces", "sessions", "session"], { sessionIds: [sessionId] });

  // 2. Forward to agent-server. The ACK is NOT out yet: the write's answer is
  // sent from THIS function's outcome, which is what lets the guards below — and
  // the admission round-trip itself — reject the send instead of
  // half-accepting it.
  const existingAgentSessionId = session?.agent_session_id ?? null;

  // The turn id is the frontend's correlation key: it seeds the optimistic
  // bubble and matches the engine's user echo when it arrives. The cloud lane
  // passes it through message.send so agnt derives the SAME echo ids.
  const turnId = input.turnId ?? uuidv7();

  if (isCloud && cloudSelection) {
    // Cloud lane (its selection was read above, so this is every cloud send).
    // agnt queues overlapping sends instead of rejecting, so the driver
    // enforces deus's one-live-turn contract itself; every throw here fails
    // the write — the same rejection contract as the wire path
    // below, for the same lost-prompt reason.
    // Above the try: the catch's honest revert needs to know which stage the
    // optimistic Waking flip replaced.
    const asleepStage =
      workspace?.init_stage === "paused" || workspace?.init_stage === "stopped"
        ? workspace.init_stage
        : null;
    const latest = asleepStage && workspace ? watchCloudReports(workspace.id) : undefined;
    try {
      // A send WAKES a sleeping sandbox, and its App token expires in an hour
      // — so the wake chip is not the only path that needs a fresh mint.
      // The row alone is not enough: `init_stage` only becomes "paused" once
      // a snapshot lands, so after a backend restart it reads NULL for a
      // sandbox that is genuinely asleep. No open channel = state unknown =
      // refresh. On a live sandbox this stays off the hot path.
      //
      // Both lanes: refreshWorkspaceGithubToken re-mints and rewrites the DO's
      // secret map for inline workspaces (agntCreateWorkspace on the existing
      // id) and re-upserts the environment-scoped secret for named ones.
      if (asleepStage && workspace) {
        // The wake takes tens of seconds (mint + reprovision/resume) and the
        // real agnt state frames only start once the workspace DO picks the
        // turn up — announce NOW so the send is never met with silence. The
        // chip flips to "Waking" (init_stage resuming) and the chat shows the
        // env line immediately; real frames replace both within seconds.
        setCloudWakeStage(workspace.id, "resuming");
        announceCloudEnv(workspace.id, sessionId, {
          status: "resuming",
          step: asleepStage === "stopped" ? "Restarting sandbox" : "Waking sandbox",
        });
      }
      if (!hasLiveCloudSession(sessionId) || asleepStage) {
        await refreshWorkspaceGithubToken(workspace);
      }
      // permissionMode/maxTurns/additionalDirectories/resume have no cloud
      // channel equivalent (permissions auto-allow like the local policy;
      // resume is agnt-internal) — the harness, model and thinking DO travel.
      await startCloudTurn(sessionId, turnId, content, cloudSelection);
    } catch (err) {
      // A report can confirm resuming. A wake on another device can clear it without a report.
      if (asleepStage && workspace && !latest?.() && rollbackSendWake(workspace.id, asleepStage)) {
        announceCloudEnv(workspace.id, sessionId, {
          status: asleepStage,
          reason: "wake failed — try again",
        });
      }
      handleAgentError(sessionId, turnId, err);
      throw err;
    }
  } else {
    if (!agentService.isConnected()) {
      const err = new AgentServerDisconnectedError();
      handleAgentError(sessionId, turnId, err);
      throw err;
    }
    if (!cwd) {
      const err = new ConflictError("Session has no resolvable workspace");
      handleAgentError(sessionId, turnId, err);
      throw err;
    }

    // turn/start answers at admission. The streamed reply arrives through the event handler.
    const preparing = new AbortController();
    const done = agentService.startTurn(sessionId, turnId, agentHarness, content, {
      cwd,
      signal: preparing.signal,
      model,
      thinkingLevel: readThinkingLevel(input.thinkingLevel),
      permissionMode,
      resume: existingAgentSessionId || undefined,
      ...(origin ? { origin } : {}),
    });
    const admission: Starting = { turnId, preparing, done };
    admitting.set(sessionId, admission);
    try {
      await done;
    } catch (err) {
      if (preparing.signal.aborted && err === preparing.signal.reason) {
        if (admission.stoppedBy) {
          recordSetupStop(sessionId, turnId, admission.stoppedBy);
          settleStopped(sessionId, turnId);
        } else if (currentTurnId(sessionId) === turnId) {
          admitting.delete(sessionId);
          settleStopped(sessionId);
        }
        throw err;
      }
      if (err instanceof WireRequestError && err.code === WIRE_ERROR_CODES.turnActive) {
        if (admission.stoppedBy) agentService.notifyTurnInterrupted(sessionId, turnId, true);
        // Another turn won admission. Keep it working and return the typed refusal.
        console.warn(
          `[CommandHandler] sendMessage rejected, turn already active: session=${sessionId}`
        );
        throw new ChatBusyError(
          "The agent is still working — wait for the current turn to finish."
        );
      }
      handleAgentError(sessionId, turnId, err);
      throw err;
    } finally {
      // A quick turn can end and start its successor before its admission reply.
      if (admitting.get(sessionId) === admission) admitting.delete(sessionId);
    }
  }

  // 3. The turn is admitted, so the send is real — and only now is the send
  // timestamp true. Everything above this line can still reject, and a rejected
  // send that had already stamped `last_user_message_at` left the workspace
  // looking permanently prompted: no `git checkout -- .` cleanup on init, and
  // `isFirstSession` false for a workspace nobody ever prompted. The status
  // flip stays optimistic because every rejection path moves it back; the
  // timestamp has no such undo, so it waits instead.
  // `failed()` logs its own error — a stamp that misses is a stale sidebar
  // ordering, not a reason to reject a turn the engine is already running.
  if (persistLastUserMessageAt(sessionId, sentAt).ok) {
    invalidate(["workspaces", "sessions"], { sessionIds: [sessionId] });
  }

  return { turnId };
}

// ---- stopSession ----

/** Per database and turn, the stop that took effect (its origin, JSON), for a moment: it keeps the credit. */
const effectiveStops = new WeakMap<object, Map<string, string>>();

const CANCEL_GRACE_MS = 15_000;

/**
 * Stop the session's active turn.
 *
 * A native cancel can be confirmed before its last echo and turn.ended arrive.
 * Keep the chat occupied until that end. If delivery stalls, the watchdog settles
 * a confirmed stop and warns about an unconfirmed one.
 */
export async function stopSession(
  { sessionId }: ParsedInputOf<typeof api.stopSession>,
  /** Who stops it, kept on the turn so a reader can say who did. */
  by: Origin = { kind: "person" }
): Promise<{ unconfirmed: boolean }> {
  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) throw new NotFoundError("Session not found");

  const targetTurnId = currentTurnId(sessionId);
  const admission = startingTurn(sessionId);
  agentService.notifyStopAsked(sessionId, {
    by,
    turnId: targetTurnId,
    endedAt: targetTurnId ? getTurn(db, sessionId, targetTurnId)?.endedAt : undefined,
  });
  if (admission && admission.turnId === targetTurnId) {
    admission.stoppedBy ??= by;
    admission.preparing.abort(new ConflictError("Stopped before it started."));
    // A lost reply can leave the named turn running.
    await admission.done.catch(() => {});
    if (currentTurnId(sessionId) !== targetTurnId) return { unconfirmed: false };
  }
  const mine = JSON.stringify(by);
  const key = `${sessionId}\0${targetTurnId}`;
  // Claimed before the stop is sent, so a reader seeing the cancel can say who:
  // the first claim holds while it is pending.
  if (targetTurnId) {
    db.prepare(
      `INSERT INTO turns (session_id, turn_id, cancelled_by) VALUES (?, ?, ?)
       ON CONFLICT(session_id, turn_id) DO UPDATE SET cancelled_by = COALESCE(turns.cancelled_by, excluded.cancelled_by)`
    ).run(sessionId, targetTurnId, mine);
  }
  const credit = (who: string | null) =>
    targetTurnId &&
    db
      .prepare("UPDATE turns SET cancelled_by = ? WHERE session_id = ? AND turn_id = ?")
      .run(who, sessionId, targetTurnId);
  let result: Awaited<ReturnType<typeof agentService.stopSession>> | undefined;
  const cloud = isCloudSession(sessionId);
  try {
    if (cloud) result = await cancelCloudTurn(sessionId, targetTurnId);
    else if (agentService.isConnected())
      result = await agentService.stopSession({ sessionId, turnId: targetTurnId });
  } catch (err) {
    console.error("[CommandHandler] Could not stop the turn:", err);
  }

  // The credit is the stop that took effect: the first that did keeps it; one that
  // definitely did not (no answer, nothing running) gives up its claim.
  const tookEffect = result?.outcome === "cancelled" || result?.outcome === "unconfirmed";
  if (targetTurnId) {
    let stops = effectiveStops.get(db);
    if (!stops) effectiveStops.set(db, (stops = new Map()));
    const winner = stops.get(key);
    if (tookEffect && !winner) {
      stops.set(key, mine);
      setTimeout(() => stops.delete(key), 60_000).unref?.();
      credit(mine);
    } else if (!tookEffect) {
      const held = (
        db
          .prepare("SELECT cancelled_by FROM turns WHERE session_id = ? AND turn_id = ?")
          .get(sessionId, targetTurnId) as { cancelled_by: string | null } | undefined
      )?.cancelled_by;
      if (held === mine) credit(winner ?? null);
    }
  }

  // The requested turn may have ended and a successor started during the RPC.
  const live = currentTurnId(sessionId);
  if (
    (live !== undefined && live !== targetTurnId) ||
    (result?.outcome === "no_active_turn" && result.activeTurnId !== undefined)
  )
    return { unconfirmed: false };

  const unconfirmed = !result || result.outcome === "unconfirmed";
  if (unconfirmed || (!cloud && live && result?.outcome === "cancelled")) {
    scheduleCancelWatchdog(sessionId, targetTurnId, !unconfirmed);
  } else {
    settleStopped(sessionId, cloud ? undefined : live);
  }
  return { unconfirmed };
}

function settleStopped(sessionId: string, goneTurnId?: string, cause?: "cancelled"): void {
  getDatabase()
    .prepare(
      `UPDATE sessions SET status = 'idle', updated_at = datetime('now')
       WHERE id = ? AND status IN (${ACTIVE_TURN_STATUSES.map(() => "?").join(", ")})`
    )
    .run(sessionId, ...ACTIVE_TURN_STATUSES);
  if (goneTurnId && !agentService.giveUpTurn(sessionId, goneTurnId, cause))
    agentService.notifyTurnInterrupted(sessionId, goneTurnId, true);
  invalidate(["workspaces", "sessions", "session"], { sessionIds: [sessionId] });
}

function scheduleCancelWatchdog(
  sessionId: string,
  cancelledTurnId: string | undefined,
  confirmed: boolean
): void {
  const timer = setTimeout(() => {
    try {
      // A successor may still be preparing its apps. Without either owner the
      // status guard below distinguishes a settled chat from one left active.
      const live = currentTurnId(sessionId);
      if (live !== undefined && live !== cancelledTurnId) return;
      if (confirmed) {
        if (live) settleStopped(sessionId, live, "cancelled");
        return;
      }

      const db = getDatabase();
      // Keep a live turn's working/question/plan status and add the warning.
      // Missing native ownership marks an active session as error; a turn
      // that already settled is excluded by the status guard.
      const result = db
        .prepare(
          `UPDATE sessions
             SET status = COALESCE(?, status),
                 error_message = COALESCE(error_message, 'The agent never confirmed the stop request.'),
                 error_category = COALESCE(error_category, 'internal'),
                 updated_at = datetime('now')
           WHERE id = ? AND status IN (${ACTIVE_TURN_STATUSES.map(() => "?").join(", ")})`
        )
        .run(live === undefined ? "error" : null, sessionId, ...ACTIVE_TURN_STATUSES);
      if (result.changes > 0) {
        agentService.notifyTurnInterrupted(sessionId, cancelledTurnId, live === undefined);
        console.warn(`[CommandHandler] unconfirmed cancel never settled: session=${sessionId}`);
        invalidate(["workspaces", "sessions", "session"], { sessionIds: [sessionId] });
      }
    } catch (err) {
      console.error("[CommandHandler] cancel watchdog failed:", err);
    }
  }, CANCEL_GRACE_MS);
  // A pending watchdog must never hold the process open at shutdown.
  timer.unref?.();
}

// ---- Helpers ----

function handleAgentError(sessionId: string, turnId: string, err: unknown): void {
  // Events can confirm admission even when its reply is lost.
  if (agentService.liveTurnId(sessionId) === turnId) return;
  const message =
    err instanceof WireRequestError
      ? err.message || "Agent rejected the message"
      : `Agent server communication failed: ${err instanceof Error ? err.message : String(err)}`;
  console.error(`[CommandHandler] Failed to start turn: session=${sessionId} ${message}`);
  const current = currentTurnId(sessionId);
  if (current === undefined || current === turnId)
    persistSessionError(sessionId, message, "internal");
  agentService.notifyTurnInterrupted(sessionId, turnId, true);
  invalidate(["workspaces", "sessions", "session"], { sessionIds: [sessionId] });
}
