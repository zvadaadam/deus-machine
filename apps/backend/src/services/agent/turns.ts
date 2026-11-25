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
import { invalidate } from "../query-engine";
import {
  admitTurn,
  claimTurn,
  holdingTurn,
  lastTurn,
  refuseTurn,
  releaseTurn,
  stopStartingTurn,
} from "./chat-turn";
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

const STEER_READ = new ConflictError("The agent already read this message.");

export async function withdrawSteerRetry(sessionId: string, turnId: string) {
  const turn = holdingTurn(sessionId);
  if (turn?.turnId !== turnId || turn.phase !== "preparing" || !turn.setup) return false;
  turn.setup.controller.abort(STEER_READ);
  await turn.setup.done;
  return true;
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
  if (holdingTurn(sessionId)?.turnId === turnId)
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
  origin?: Origin,
  firstTask = false
): Promise<{ turnId: string }> {
  const turnId = input.turnId;
  if (!turnId) return sendMessageOnce(input, origin, firstTask);
  const previous = previousSend(input, turnId, origin);
  if (previous) return previous;
  const key = `${input.sessionId}\0${turnId}`;
  // Its text kept as a digest: a send with images would otherwise sit in memory for minutes.
  const request = { content: digest(input.content), origin: encodeOrigin(origin) };
  const db = getDatabase();
  let admissions = admissionsOf.get(db);
  if (!admissions) admissionsOf.set(db, (admissions = new Map()));
  const done = sendMessageOnce(input, origin, firstTask);
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
  origin?: Origin,
  firstTask = false
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

  if (session?.is_hidden) throw new ConflictError("That chat is archived; it takes no messages.");
  const workspace = session ? getWorkspaceForMiddleware(db, session.workspace_id) : undefined;
  const isCloud = workspace?.kind === "cloud";
  const holder = holdingTurn(sessionId);
  if (holder && holder.phase !== "running")
    throw new ChatBusyError("The agent is starting another turn — wait for it to begin.");
  if (holder || (isCloud && session && ACTIVE_TURN_STATUSES.includes(session.status))) {
    throw new ChatBusyError(
      session?.status === "needs_response" || session?.status === "needs_plan_response"
        ? "The agent is waiting for your response — answer the pending prompt first."
        : "The agent is still working — wait for the current turn to finish."
    );
  }
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

  // The first send binds the harness before its user echo increments the message count.
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

  const turnId = input.turnId ?? uuidv7();
  const sentAt = Date.now();
  const start = isCloud ? undefined : Promise.withResolvers<void>();
  const setup = start && { controller: new AbortController(), done: start.promise, firstTask };
  if (setup) claimTurn(sessionId, turnId, setup, sentAt);
  const working = persistSessionWorking(sessionId);
  if (!working.ok) {
    refuseTurn(sessionId, turnId);
    throw new Error(working.error);
  }
  invalidate(["workspaces", "sessions", "session"], { sessionIds: [sessionId] });

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
      if (!holdingTurn(sessionId) && lastTurn(sessionId)?.turnId !== turnId)
        handleAgentError(sessionId, turnId, err);
      throw err;
    }
  } else if (setup) {
    try {
      if (!agentService.isConnected()) throw new AgentServerDisconnectedError();
      if (!cwd) throw new ConflictError("Session has no resolvable workspace");
      await agentService.startTurn(sessionId, turnId, agentHarness, content, {
        cwd,
        signal: setup.controller.signal,
        model,
        thinkingLevel: readThinkingLevel(input.thinkingLevel),
        permissionMode,
        resume: session?.agent_session_id || undefined,
        ...(origin ? { origin } : {}),
      });
      admitTurn(sessionId, turnId);
    } catch (err) {
      if (setup.controller.signal.aborted && err === setup.controller.signal.reason) {
        if (err === STEER_READ && refuseTurn(sessionId, turnId)) settleStopped(sessionId);
        throw err;
      }
      const stopped = holdingTurn(sessionId)?.setup?.stoppedBy;
      const refused = refuseTurn(sessionId, turnId);
      if (err instanceof WireRequestError && err.code === WIRE_ERROR_CODES.turnActive) {
        if (refused && stopped) agentService.notifyTurnInterrupted(sessionId, turnId, true);
        throw new ChatBusyError(
          "The agent is still working — wait for the current turn to finish."
        );
      }
      if (refused) handleAgentError(sessionId, turnId, err);
      throw err;
    } finally {
      start.resolve();
    }
  }

  // Only an admitted send dates the workspace's last prompt.
  if (persistLastUserMessageAt(sessionId, new Date(sentAt).toISOString()).ok)
    invalidate(["workspaces", "sessions"], { sessionIds: [sessionId] });

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

  const turn = stopStartingTurn(sessionId, by);
  const targetTurnId = turn?.turnId;
  agentService.notifyStopAsked(sessionId, {
    by,
    turnId: targetTurnId,
    endedAt: targetTurnId ? getTurn(db, sessionId, targetTurnId)?.endedAt : undefined,
  });
  if (turn?.setup) {
    const { setup } = turn;
    if (turn.phase === "preparing") {
      releaseTurn(sessionId, turn.turnId, "local", by);
      setup.controller.abort(new ConflictError("Stopped before it started."));
      settleStopped(sessionId, turn.turnId);
    }
    await setup.done;
    if (holdingTurn(sessionId)?.turnId !== targetTurnId) return { unconfirmed: false };
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
  const live = holdingTurn(sessionId)?.turnId;
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
  const starting = holdingTurn(sessionId);
  if (!starting || starting.turnId === goneTurnId) {
    getDatabase()
      .prepare(
        `UPDATE sessions SET status = 'idle', updated_at = datetime('now')
         WHERE id = ? AND status IN (${ACTIVE_TURN_STATUSES.map(() => "?").join(", ")})`
      )
      .run(sessionId, ...ACTIVE_TURN_STATUSES);
  }
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
      const live = holdingTurn(sessionId)?.turnId;
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
  const message =
    err instanceof WireRequestError
      ? err.message || "Agent rejected the message"
      : `Agent server communication failed: ${err instanceof Error ? err.message : String(err)}`;
  console.error(`[CommandHandler] Failed to start turn: session=${sessionId} ${message}`);
  persistSessionError(sessionId, message, "internal");
  agentService.notifyTurnInterrupted(sessionId, turnId, true);
  invalidate(["workspaces", "sessions", "session"], { sessionIds: [sessionId] });
}
