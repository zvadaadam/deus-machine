// backend/src/services/agent/turns.ts
// Starting and stopping a turn: what `sendMessage` and `stopSession` do.
//
// A send is admitted or refused as a whole. The user's message row is never
// written here: the engine echoes the prompt back and that echo is the one
// path that persists messages. So until the turn is admitted, the only copy
// of the prompt is the sender's optimistic bubble, and every way a send can
// fail must reject, which is what tells the sender to take the bubble back.

import { WireRequestError } from "@zvada/agent-server/client";
import { WIRE_ERROR_CODES } from "@zvada/agent-server/protocol";
import type * as api from "@shared/api/sessions";
import type { ParsedInputOf } from "@shared/api/op";
import { uuidv7 } from "@shared/lib/uuid";
import { readPermissionMode, readThinkingLevel } from "@shared/protocol";
import { readCloudTurnSelection, type CloudTurnSelection } from "@shared/cloud-models";
import { ACTIVE_TURN_STATUSES } from "@shared/enums";
import { getDatabase } from "../../lib/database";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { getSessionRaw, getWorkspaceForMiddleware } from "../../db";
import { computeWorkspacePath } from "../../middleware/workspace-loader";
import {
  persistLastUserMessageAt,
  persistSessionError,
  persistSessionWorking,
} from "./persistence";
import { invalidate } from "../query-engine";
import * as agentService from "./service";
import {
  startCloudTurn,
  cancelCloudTurn,
  isCloudSession,
  hasLiveCloudSession,
  announceCloudEnv,
  pushCloudSessionFacts,
} from "./cloud/driver";
import { refreshWorkspaceGithubToken } from "../cloud-workspace-init.service";

// ---- sendMessage ----

/** Start a turn in a session. Answers `api.sendMessage`; rejects when the turn is not admitted. */
export async function sendMessage(
  input: ParsedInputOf<typeof api.sendMessage>
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
  if (session && session.message_count > 0 && session.agent_harness !== agentHarness) {
    throw new ConflictError(
      `Cannot switch agent from ${session.agent_harness} to ${agentHarness} on a session with messages. Open a new chat tab instead.`
    );
  }

  // A send against an active turn would persist a user message that no agent
  // will ever answer (the wire rejects the turn with turnActive and the
  // composer shows nothing). "Needs input" counts as active too: plan
  // approval and questions park the RUNNING turn while the overlay waits.
  // Reject up front — the refusal surfaces in the UI. The wire guard
  // stays as the backstop for the status race.
  if (session && ACTIVE_TURN_STATUSES.includes(session.status)) {
    throw new ConflictError(
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

  // The cloud sidecar runs claude-code and codex-app-server (the template
  // bakes both CLIs). Anything else — codex-sdk, acp — is rejected up front
  // with a real explanation instead of a provider-session error
  // mid-connect. This MUST precede every write below: after the harness
  // persist it would leave a rejected harness on the row; after the working
  // flip it would strand the session in "working" with no turn to end it.
  if (isCloud && agentHarness !== "claude-code" && agentHarness !== "codex-app-server") {
    throw new ValidationError(
      "This agent isn't available in cloud workspaces — pick a Claude or Codex model, or use a local workspace."
    );
  }
  // AGNT chooses no harness, model or thinking level and refuses a turn that
  // leaves one out. Read all three in the platform's vocabulary here, before
  // the same writes, so a send without them is refused like the one above
  // instead of failing on the socket after the session flipped to working.
  let cloudSelection: CloudTurnSelection | undefined;
  if (isCloud) {
    const read = readCloudTurnSelection({
      harness: agentHarness,
      model,
      thinkingLevel: input.thinkingLevel,
    });
    if (!read.ok) throw new ValidationError(read.message);
    cloudSelection = read.selection;
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
      if (current && current.agent_harness !== agentHarness) {
        throw new ConflictError(
          `Cannot switch agent from ${current.agent_harness} to ${agentHarness} on a session with messages. Open a new chat tab instead.`
        );
      }
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
  invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });

  // 2. Forward to agent-server. The ACK is NOT out yet: handleCommand sends it
  // from THIS function's outcome, which is what lets the guards below — and
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
    // enforces deus's one-live-turn contract itself; every throw here answers
    // `accepted: false` — the same rejection contract as the wire path
    // below, for the same lost-prompt reason.
    // Above the try: the catch's honest revert needs to know which stage the
    // optimistic Waking flip replaced.
    const asleepStage =
      workspace?.init_stage === "paused" || workspace?.init_stage === "stopped"
        ? workspace.init_stage
        : null;
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
        getDatabase()
          .prepare("UPDATE workspaces SET init_stage = 'resuming' WHERE id = ?")
          .run(workspace.id);
        invalidate(["workspaces", "stats"], {});
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
      // The optimistic "Waking" flip above must not outlive a failed wake:
      // the prompt is rolled back, so a stuck Waking chip would promise a
      // recovery nothing is driving. Same honest revert the chip path does.
      if (asleepStage && workspace) {
        getDatabase()
          .prepare("UPDATE workspaces SET init_stage = ? WHERE id = ? AND init_stage = 'resuming'")
          .run(asleepStage, workspace.id);
        invalidate(["workspaces", "stats"], {});
        announceCloudEnv(workspace.id, sessionId, {
          status: asleepStage,
          reason: "wake failed — try again",
        });
      }
      handleAgentError(sessionId, err);
      throw err;
    }
  } else {
    // No engine turn can be admitted from here. Flipping the session to "error"
    // is only half the job: this handler's return value IS the write's answer, so
    // returning normally would report success for a turn that never ran.
    // The user's prompt exists in exactly one place at this moment — the
    // frontend's optimistic bubble — because the backend never writes the user
    // row (the engine's echo is the single persistence path). A false accept
    // therefore strands that bubble on screen forever, durable nowhere. Throw so
    // handleCommand answers `accepted: false` and the composer's rollback runs.
    if (!agentService.isConnected()) {
      const err = new Error("Agent server is disconnected");
      handleAgentError(sessionId, err);
      throw err;
    }
    if (!cwd) {
      const err = new Error("Session has no resolvable workspace");
      handleAgentError(sessionId, err);
      throw err;
    }

    // Admission is AWAITED, and that is the whole point. `turn/start` is a
    // quick-ack: the server answers the moment it admits the turn — before the
    // harness has run a step (it acks, then `void executeTurn`) — so this waits
    // for a verdict, never for the turn. The streaming half stays where it
    // belongs, on the event channel.
    //
    // The guards above only close the SYNCHRONOUS half of the lost-prompt hole.
    // Admission can also fail asynchronously: a turnActive race with a second
    // client, a server shutting down, a harness that will not spawn. Answering
    // the command before that verdict arrives reports `accepted: true` for a
    // turn the server then refuses — and the prompt exists in exactly one place
    // right now, the frontend's optimistic bubble, because the backend never
    // writes the user row (the engine's echo is the single persistence path).
    // So every rejection rethrows: handleCommand turns a throw into
    // `accepted: false`, which is the only answer that runs the composer's
    // rollback. Nothing can arrive here AFTER admission — the promise settles on
    // the ack — so there is no post-ack failure left to handle in the
    // background.
    try {
      await agentService.startTurn(sessionId, turnId, agentHarness, content, {
        cwd,
        model,
        thinkingLevel: readThinkingLevel(input.thinkingLevel),
        permissionMode,
        resume: existingAgentSessionId || undefined,
      });
    } catch (err) {
      if (err instanceof WireRequestError && err.code === WIRE_ERROR_CODES.turnActive) {
        // The session is legitimately mid-turn — another client won the race
        // between the status guard above and the wire. That RUNNING turn is
        // fine, it just is not ours, so the session must NOT be flipped to an
        // error status. Reject the send and leave the status alone; the wording
        // matches the synchronous guard, since to the user it is the same "wait
        // your turn" and the wire's own message leaks a session id.
        console.warn(
          `[CommandHandler] sendMessage rejected, turn already active: session=${sessionId}`
        );
        throw new ConflictError(
          "The agent is still working — wait for the current turn to finish."
        );
      }
      // Every other rejection — harness unavailable, shutting down, invalid
      // params, a transport that died mid-request — means no turn was admitted,
      // so the session must not be left sitting on "working".
      if (err instanceof WireRequestError) handleAgentRejection(sessionId, err.message);
      else handleAgentError(sessionId, err);
      throw err;
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

/**
 * Warn if an unconfirmed cancel has not settled within this grace period.
 * Keep Stop available while the handler still owns the live turn.
 */
const UNCONFIRMED_CANCEL_GRACE_MS = 15_000;

/**
 * Stop the session's active turn.
 *
 * The cancel outcome is a union and it MATTERS (PROTOCOL §8):
 *   cancelled / no_active_turn — the turn is provably over; go idle now.
 *   unconfirmed                — dispatched but unacknowledged. The agent may
 *                                still be writing files, so forcing "idle"
 *                                here would show a finished session while work
 *                                continues and then flip back when the real
 *                                turn.ended lands. Leave the status alone and
 *                                let turn.ended settle it. The watchdog
 *                                warns if confirmation never arrives.
 */
export async function stopSession({
  sessionId,
}: ParsedInputOf<typeof api.stopSession>): Promise<{ unconfirmed: boolean }> {
  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) throw new NotFoundError("Session not found");

  const targetTurnId = agentService.liveTurnId(sessionId);
  let result: Awaited<ReturnType<typeof agentService.stopSession>> | undefined;
  if (isCloudSession(sessionId)) {
    try {
      result = await cancelCloudTurn(sessionId, targetTurnId);
    } catch (err) {
      console.error("[CommandHandler] Failed to cancel cloud turn:", err);
    }
  } else if (agentService.isConnected()) {
    try {
      result = await agentService.stopSession({ sessionId, turnId: targetTurnId });
    } catch (err) {
      console.error("[CommandHandler] Failed to stop on agent-server:", err);
    }
  }

  // The requested turn may have ended and a successor started during the RPC.
  const live = agentService.liveTurnId(sessionId);
  if (
    (live !== undefined && live !== targetTurnId) ||
    (result?.outcome === "no_active_turn" && result.activeTurnId !== undefined)
  )
    return { unconfirmed: false };

  if (result && result.outcome !== "unconfirmed") {
    db.prepare(
      `UPDATE sessions SET status = 'idle', updated_at = datetime('now')
       WHERE id = ? AND status IN (${ACTIVE_TURN_STATUSES.map(() => "?").join(", ")})`
    ).run(sessionId, ...ACTIVE_TURN_STATUSES);
    invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
    return { unconfirmed: false };
  }

  console.warn(
    `[CommandHandler] stopSession unconfirmed: session=${sessionId} — waiting for turn.ended`
  );
  // Armed for the turn being cancelled, not for the session — see below.
  scheduleUnconfirmedCancelWatchdog(sessionId, targetTurnId);
  return { unconfirmed: true };
}

/** Bounded fallback for an unconfirmed cancel that no turn.ended ever settles. */
function scheduleUnconfirmedCancelWatchdog(
  sessionId: string,
  cancelledTurnId: string | undefined
): void {
  const timer = setTimeout(() => {
    try {
      // The watchdog belongs to ONE turn, and the status cannot identify it:
      // consecutive turns are both "working". An unconfirmed cancel usually
      // does settle — turn.ended lands, the session goes idle, the user sends
      // again — and all of that fits inside the 15s grace window, after which
      // a status-only check reads the NEW turn's "working" as the old turn's
      // stuck cancel and fails a perfectly healthy run mid-flight.
      //
      // So bail only on POSITIVE evidence that a different turn is live now.
      // `liveTurnId` returning undefined is not that evidence: it also means
      // the handler is gone (link dropped, shutdown), which is precisely when
      // a session is most likely to be stranded on "working" with no agent
      // behind it — the case this watchdog exists for. The status guard below
      // covers the remaining "it ended and nothing replaced it" case, since
      // that session is no longer in an active status.
      const live = agentService.liveTurnId(sessionId);
      if (live !== undefined && live !== cancelledTurnId) return;

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
        console.warn(`[CommandHandler] unconfirmed cancel never settled: session=${sessionId}`);
        invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
      }
    } catch (err) {
      console.error("[CommandHandler] cancel watchdog failed:", err);
    }
  }, UNCONFIRMED_CANCEL_GRACE_MS);
  // A pending watchdog must never hold the process open at shutdown.
  timer.unref?.();
}

// ---- Helpers ----

function handleAgentRejection(sessionId: string, reason?: string): void {
  const msg = reason || "Agent rejected the message";
  console.error(`[CommandHandler] Agent rejected sendMessage for session=${sessionId}: ${msg}`);
  persistSessionError(sessionId, msg, "internal");
  invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
}

function handleAgentError(sessionId: string, err: unknown): void {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("[CommandHandler] Failed to forward to agent-server:", errorMsg);
  persistSessionError(sessionId, `Agent server communication failed: ${errorMsg}`, "internal");
  invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
}
