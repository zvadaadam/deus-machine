// backend/src/services/agent/commands.ts
// Business logic for q:command dispatch.
//
// Each command handler is a focused function that:
//   1. Validates and extracts typed params
//   2. Performs DB writes
//   3. Triggers subscription invalidation
//   4. Forwards to agent-server when needed
//
// The query engine (protocol layer) delegates here — it should never
// contain business logic directly.

import { match } from "ts-pattern";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WireRequestError } from "@zvada/agent-server/client";
import { WIRE_ERROR_CODES } from "@zvada/agent-server/protocol";
import { uuidv7 } from "@shared/lib/uuid";
import { readPermissionMode, readThinkingLevel } from "@shared/protocol";
import { getDatabase } from "../../lib/database";
import { getSessionRaw, getWorkspaceForMiddleware } from "../../db";
import { computeWorkspacePath } from "../../middleware/workspace-loader";
import { spawnPty, writeToPty, resizePty, killPty } from "../pty.service";
import { watchWorkspace, unwatchWorkspace } from "../fs-watcher.service";
import { delegateToRoute } from "../route-delegate";
import {
  persistLastUserMessageAt,
  persistSessionError,
  persistSessionWorking,
} from "./persistence";
import { invalidate } from "../query-engine";
import * as agentService from "./service";
import { resolveAapPaths } from "./service";
import {
  startCloudTurn,
  cancelCloudTurn,
  isCloudSession,
  hasLiveCloudSession,
} from "./cloud/driver";
import { refreshWorkspaceGithubToken } from "../cloud-workspace-init.service";
import * as simulator from "../simulator-context";
import { launchApp, stopApp } from "../aap";
import { broadcast as wsBroadcast } from "../ws.service";
import type { AgentHarness } from "@shared/enums";
import type { CommandName } from "@shared/types/query-protocol";
import {
  type QueryParams,
  readStringParam as readString,
  readNumberParam as readNumber,
  requireParam,
} from "../../lib/query-params";

interface CommandResult {
  commandId?: string;
  [key: string]: unknown;
}

const execFileAsync = promisify(execFile);

export interface CommandContext {
  relayClient?: boolean;
}

// ---- Command Dispatch ----

export async function runCommand(
  command: CommandName,
  params: QueryParams,
  context: CommandContext = {}
): Promise<CommandResult> {
  return (
    match(command)
      .with("sendMessage", () => handleSendMessage(params))
      .with("stopSession", () => handleStopSession(params))
      // ---- PTY commands ----
      .with("pty:spawn", () => {
        const id = requireParam(params, "id", "pty:spawn");
        const cmd = readString(params, "command") ?? "bash";
        const args = Array.isArray(params.args) ? (params.args as string[]) : [];
        const cols = readNumber(params, "cols") ?? 80;
        const rows = readNumber(params, "rows") ?? 24;
        const cwd = readString(params, "cwd");

        const ptyId = spawnPty({ id, command: cmd, args, cols, rows, cwd });
        return { commandId: ptyId };
      })
      .with("pty:write", () => {
        const id = requireParam(params, "id", "pty:write");
        const data = Array.isArray(params.data) ? (params.data as number[]) : undefined;
        if (!data) throw new Error("pty:write requires data (number[])");

        writeToPty(id, data);
        return {};
      })
      .with("pty:resize", () => {
        const id = readString(params, "id");
        const cols = readNumber(params, "cols");
        const rows = readNumber(params, "rows");
        if (!id || cols === undefined || rows === undefined) {
          throw new Error("pty:resize requires id, cols, and rows");
        }

        resizePty(id, cols, rows);
        return {};
      })
      .with("pty:kill", () => {
        const id = requireParam(params, "id", "pty:kill");

        killPty(id);
        return {};
      })
      // ---- File system commands ----
      .with("fs:watch", async () => {
        const workspacePath = requireParam(params, "workspacePath", "fs:watch");

        await watchWorkspace(workspacePath);
        return {};
      })
      .with("fs:unwatch", async () => {
        const workspacePath = requireParam(params, "workspacePath", "fs:unwatch");

        await unwatchWorkspace(workspacePath);
        return {};
      })
      // ---- Git commands ----
      .with("git:clone", async () => {
        const url = readString(params, "url");
        const targetPath = readString(params, "targetPath");
        if (!url || !targetPath) throw new Error("git:clone requires url and targetPath");
        const result = (await delegateToRoute("POST", "/api/repos/clone", {
          url,
          targetPath,
        })) as { success?: boolean; path?: string; error?: string };
        if (result.error) throw new Error(result.error);
        return {};
      })
      .with("git:init", async () => {
        const projectName = readString(params, "projectName");
        const targetPath = readString(params, "targetPath");
        if (!projectName || !targetPath)
          throw new Error("git:init requires projectName and targetPath");
        const templateType = readString(params, "templateType");
        const templateUrl = readString(params, "templateUrl");
        const result = (await delegateToRoute("POST", "/api/repos/init", {
          projectName,
          targetPath,
          ...(templateType ? { template: { type: templateType, url: templateUrl } } : {}),
        })) as { success?: boolean; path?: string; githubUrl?: string; error?: string };
        if (result.error) throw new Error(result.error);
        return { githubUrl: result.githubUrl };
      })
      // ---- Route-delegated commands ----
      .with("createWorkspace", async () => {
        const repositoryId = requireParam(params, "repository_id", "createWorkspace");
        const body: Record<string, unknown> = { repository_id: repositoryId };
        const location = readString(params, "location");
        if (location) body.location = location;
        const sourceBranch = readString(params, "source_branch");
        const prUrl = readString(params, "pr_url");
        const prTitle = readString(params, "pr_title");
        const targetBranch = readString(params, "target_branch");
        if (sourceBranch) body.source_branch = sourceBranch;
        if (params.pr_number != null) body.pr_number = params.pr_number;
        if (prUrl) body.pr_url = prUrl;
        if (prTitle) body.pr_title = prTitle;
        if (targetBranch) body.target_branch = targetBranch;
        const result = (await delegateToRoute("POST", "/api/workspaces", body)) as { id?: string };
        return { commandId: result.id };
      })
      .with("retrySetup", async () => {
        const workspaceId = requireParam(params, "workspaceId", "retrySetup");
        await delegateToRoute("POST", `/api/workspaces/${workspaceId}/retry-setup`);
        return {};
      })
      .with("openPenFile", async () => {
        const workspaceId = readString(params, "workspaceId");
        const filePath = readString(params, "filePath");
        if (!workspaceId || !filePath)
          throw new Error("openPenFile requires workspaceId and filePath");
        await delegateToRoute("POST", `/api/workspaces/${workspaceId}/open-pen-file`, {
          filePath,
        });
        return {};
      })
      // ---- Simulator commands ----
      .with("sim:listDevices", async () => {
        const devices = await simulator.listDevices();
        return { devices };
      })
      .with("sim:start", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:start");
        const udid = requireParam(params, "udid", "sim:start");
        const skipBootCheck = params.skipBootCheck === true;
        const capabilities = simulator.getSimulatorCapabilities({
          relayClient: context.relayClient === true,
        });
        if (!capabilities.available) {
          throw new Error(capabilities.unavailableReason ?? "Simulator is unavailable");
        }
        // Async: start returns immediately, pushes sim:streamReady event when ready
        simulator.startStream(workspaceId, udid, skipBootCheck).catch((err) => {
          console.error("[Simulator] startStream failed:", err);
          wsBroadcast(
            JSON.stringify({
              type: "q:event",
              event: "sim:streamFailed",
              data: { workspaceId, error: err instanceof Error ? err.message : String(err) },
            })
          );
        });
        return {};
      })
      .with("sim:stop", () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:stop");
        simulator.stopStream(workspaceId);
        return {};
      })
      .with("sim:touch", () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:touch");
        const x = readNumber(params, "x");
        const y = readNumber(params, "y");
        if (x === undefined || y === undefined) {
          throw new Error("sim:touch requires numeric x and y");
        }
        const touchType = readString(params, "touchType") ?? "began";
        simulator.sendTouch(workspaceId, x, y, touchType);
        return {};
      })
      .with("sim:key", () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:key");
        const keycode = readNumber(params, "keycode");
        if (keycode === undefined) {
          throw new Error("sim:key requires a numeric keycode");
        }
        const direction = readString(params, "direction") ?? "down";
        simulator.sendKey(workspaceId, keycode, direction);
        return {};
      })
      .with("sim:scroll", () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:scroll");
        const x = readNumber(params, "x");
        const y = readNumber(params, "y");
        const dx = readNumber(params, "dx");
        const dy = readNumber(params, "dy");
        if (x === undefined || y === undefined || dx === undefined || dy === undefined) {
          throw new Error("sim:scroll requires numeric x, y, dx, dy");
        }
        simulator.sendScroll(workspaceId, x, y, dx, dy);
        return {};
      })
      .with("sim:button", () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:button");
        const buttonType = readString(params, "buttonType");
        if (!buttonType) {
          throw new Error("sim:button requires buttonType");
        }
        simulator.sendButton(workspaceId, buttonType);
        return {};
      })
      .with("sim:screenshot", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:screenshot");
        const bytes = await simulator.takeScreenshot(workspaceId);
        return { bytes };
      })
      .with("sim:inspectStart", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:inspectStart");
        const bundleId = readString(params, "bundleId");
        const snapshot = await simulator.startInspector(workspaceId, bundleId ?? undefined);
        return { snapshot };
      })
      .with("sim:inspectSnapshot", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:inspectSnapshot");
        const snapshot = await simulator.inspectorSnapshot(workspaceId);
        return { snapshot };
      })
      .with("sim:buildAndRun", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:buildAndRun");
        const workspacePath = requireParam(params, "workspacePath", "sim:buildAndRun");
        const scheme = readString(params, "scheme");
        // Async: pushes sim:buildLog, sim:buildComplete or sim:buildFailed events
        simulator.buildAndRun(workspaceId, workspacePath, scheme ?? undefined).catch((err) => {
          wsBroadcast(
            JSON.stringify({
              type: "q:event",
              event: "sim:buildFailed",
              data: { workspaceId, error: err instanceof Error ? err.message : String(err) },
            })
          );
        });
        return {};
      })
      .with("sim:hasXcodeProject", async () => {
        const workspacePath = requireParam(params, "workspacePath", "sim:hasXcodeProject");
        const hasProject = await simulator.hasXcodeProject(workspacePath);
        return { hasProject };
      })
      .with("sim:launchApp", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:launchApp");
        const bundleId = requireParam(params, "bundleId", "sim:launchApp");
        const session = simulator.getContextForWorkspace(workspaceId);
        if (!session) throw new Error("No active simulator session");
        await execFileAsync("xcrun", ["simctl", "launch", session.udid, bundleId]);
        return {};
      })
      .with("sim:terminateApp", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:terminateApp");
        const bundleId = requireParam(params, "bundleId", "sim:terminateApp");
        const session = simulator.getContextForWorkspace(workspaceId);
        if (!session) throw new Error("No active simulator session");
        await execFileAsync("xcrun", ["simctl", "terminate", session.udid, bundleId]);
        return {};
      })
      .with("sim:uninstallApp", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:uninstallApp");
        const bundleId = requireParam(params, "bundleId", "sim:uninstallApp");
        const session = simulator.getContextForWorkspace(workspaceId);
        if (!session) throw new Error("No active simulator session");
        await execFileAsync("xcrun", ["simctl", "uninstall", session.udid, bundleId]);
        return {};
      })
      // ---- AAP (agentic apps protocol) commands ----
      .with("launchApp", () => handleLaunchApp(params))
      .with("stopApp", () => handleStopApp(params))
      .exhaustive()
  );
}

/**
 * The statuses that mean "a turn is running" — the RUNNING turn is the thing
 * both sends and stops key off, so the two must read the same list or they
 * disagree about whether one exists.
 *
 * "Needs input" belongs here: plan approval and questions park the running
 * turn behind an overlay, they do not end it. A send is refused from these
 * (the wire would reject it with turnActive), and a stop IS legal from them —
 * which is why the unconfirmed-cancel watchdog matches this same set.
 */
const ACTIVE_TURN_STATUSES: readonly string[] = [
  "working",
  "needs_plan_response",
  "needs_response",
];

// ---- sendMessage ----

async function handleSendMessage(params: QueryParams): Promise<CommandResult> {
  const sessionId = requireParam(params, "sessionId", "sendMessage");
  const content = requireParam(params, "content", "sendMessage");
  const model = requireParam(params, "model", "sendMessage");
  const agentHarness = requireParam(params, "agentHarness", "sendMessage") as AgentHarness;

  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);

  // Harness lock: once a session has messages, its agent harness is bound to
  // a specific SDK process. Reject cross-harness switches to keep the server
  // authoritative; the UI disables these options too, but this is the source
  // of truth.
  if (session && session.message_count > 0 && session.agent_harness !== agentHarness) {
    throw new Error(
      `Cannot switch agent from ${session.agent_harness} to ${agentHarness} on a session with messages. Open a new chat tab instead.`
    );
  }

  // A send against an active turn would persist a user message that no agent
  // will ever answer (the wire rejects the turn with turnActive and the
  // composer shows nothing). "Needs input" counts as active too: plan
  // approval and questions park the RUNNING turn while the overlay waits.
  // Reject up front — the q:command error surfaces in the UI. The wire guard
  // stays as the backstop for the status race.
  if (session && ACTIVE_TURN_STATUSES.includes(session.status)) {
    throw new Error(
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

  // The cloud sidecar runs the claude-code harness only (it deliberately
  // never installs the Codex SDK) — reject other harnesses up front with a
  // real explanation instead of a provider-session error mid-connect. This
  // MUST precede every write below: after the harness persist it would leave
  // a rejected harness on the row; after the working flip it would strand
  // the session in "working" with no turn to ever end it.
  if (isCloud && agentHarness !== "claude-code") {
    throw new Error(
      "Codex isn't available in cloud workspaces yet — the sandbox runs Claude only. Pick a Claude model, or use a local workspace for Codex."
    );
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
        throw new Error(
          `Cannot switch agent from ${current.agent_harness} to ${agentHarness} on a session with messages. Open a new chat tab instead.`
        );
      }
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
  invalidate(["workspaces", "sessions", "session", "messages", "stats"], {
    sessionIds: [sessionId],
  });

  // 2. Forward to agent-server. The ACK is NOT out yet: handleCommand sends it
  // from THIS function's outcome, which is what lets the guards below — and
  // the admission round-trip itself — reject the send instead of
  // half-accepting it.
  const existingAgentSessionId = session?.agent_session_id ?? null;

  // The turn id is the frontend's correlation key: it seeds the optimistic
  // bubble and matches the engine's user echo when it arrives. The cloud lane
  // passes it through message.send so agnt derives the SAME echo ids.
  const turnId = readString(params, "turnId") ?? uuidv7();

  if (isCloud) {
    // Cloud lane. agnt queues overlapping sends instead of rejecting, so the
    // driver enforces deus's one-live-turn contract itself; every throw here
    // answers `accepted: false` — the same rejection contract as the wire path
    // below, for the same lost-prompt reason.
    try {
      // A send WAKES a sleeping sandbox, and its App token expires in an hour
      // — so the wake chip is not the only path that needs a fresh mint.
      // The row alone is not enough: `init_stage` only becomes "paused" once
      // a snapshot lands, so after a backend restart it reads NULL for a
      // sandbox that is genuinely asleep. No open channel = state unknown =
      // refresh. On a live sandbox this stays off the hot path.
      //
      // ENVIRONMENT lane only: inline workspaces baked their mint into the
      // DO's secret map at create time and no wake path can rewrite it — see
      // refreshWorkspaceGithubToken. This does NOT cover them.
      if (
        !hasLiveCloudSession(sessionId) ||
        workspace?.init_stage === "paused" ||
        workspace?.init_stage === "stopped"
      ) {
        await refreshWorkspaceGithubToken(workspace);
      }
      // permissionMode/maxTurns/additionalDirectories/resume have no cloud
      // channel equivalent (permissions auto-allow like the local policy;
      // resume is agnt-internal) — model and thinking DO travel.
      await startCloudTurn(sessionId, turnId, content, {
        model,
        thinkingLevel: readThinkingLevel(params.thinkingLevel),
      });
    } catch (err) {
      handleAgentError(sessionId, err);
      throw err;
    }
  } else {
    // No engine turn can be admitted from here. Flipping the session to "error"
    // is only half the job: this handler's return value IS the q:command_ack, so
    // returning normally would answer `accepted: true` for a turn that never ran.
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
        thinkingLevel: readThinkingLevel(params.thinkingLevel),
        permissionMode: readPermissionMode(params.permissionMode),
        maxTurns: readNumber(params, "maxTurns"),
        additionalDirectories: Array.isArray(params.additionalDirectories)
          ? params.additionalDirectories.filter((dir): dir is string => typeof dir === "string")
          : undefined,
        resume: existingAgentSessionId || readString(params, "resume"),
        resumeSessionAt: readString(params, "resumeSessionAt"),
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
        throw new Error("The agent is still working — wait for the current turn to finish.");
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

  return { commandId: turnId };
}

// ---- stopSession ----

/**
 * How long to let an UNCONFIRMED cancel settle itself before giving up.
 *
 * The turn is still nominally running, so `turn.ended` is expected within a
 * few seconds. If it never comes, the session would sit on "working" forever
 * with no agent behind it — the watchdog converts that into an error the user
 * can act on, and only if the status is still exactly where we left it.
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
 *                                let turn.ended settle it, with a bounded
 *                                fallback so it cannot hang forever.
 */
async function handleStopSession(params: QueryParams): Promise<CommandResult> {
  const sessionId = requireParam(params, "sessionId", "stopSession");

  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) throw new Error("Session not found");

  let confirmed = true;
  if (isCloudSession(sessionId)) {
    try {
      const result = await cancelCloudTurn(sessionId);
      confirmed = result.outcome !== "unconfirmed";
    } catch (err) {
      console.error("[CommandHandler] Failed to cancel cloud turn:", err);
      // The channel itself failed; nothing is going to deliver a turn.ended.
    }
  } else if (agentService.isConnected()) {
    try {
      const result = await agentService.stopSession({ sessionId });
      confirmed = result.outcome !== "unconfirmed";
    } catch (err) {
      console.error("[CommandHandler] Failed to stop on agent-server:", err);
      // The wire itself failed; nothing is going to deliver a turn.ended.
    }
  }

  if (confirmed) {
    db.prepare(
      "UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId);
    invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
    return {};
  }

  console.warn(
    `[CommandHandler] stopSession unconfirmed: session=${sessionId} — waiting for turn.ended`
  );
  // Armed for the turn being cancelled, not for the session — see below.
  scheduleUnconfirmedCancelWatchdog(sessionId, agentService.liveTurnId(sessionId));
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
      // Only if turn.ended never arrived: any status change means it did (or
      // the user started something else), and this must not stomp on it.
      //
      // Matching 'working' alone was too narrow. A stop is legal from every
      // ACTIVE_TURN_STATUS — cancelling a plan-approval or question overlay is
      // the common case — and an unconfirmed cancel from one of those left the
      // session parked on needs_plan_response / needs_response with no agent
      // behind it and no overlay the user could dismiss. Same set the send
      // path calls active, so "there is a turn to give up on" means one thing.
      const result = db
        .prepare(
          `UPDATE sessions
             SET status = 'error',
                 error_message = 'The agent never confirmed the stop request.',
                 error_category = 'internal',
                 updated_at = datetime('now')
           WHERE id = ? AND status IN (${ACTIVE_TURN_STATUSES.map(() => "?").join(", ")})`
        )
        .run(sessionId, ...ACTIVE_TURN_STATUSES);
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

// ---- AAP (agentic apps protocol) ----

/**
 * User-initiated launch from the Apps tab. Resolves workspaceId → workspacePath
 * the same way the Phase 3 agent-server RPC bridge does (service.ts
 * handleAapRpc) so both paths converge on identical inputs to apps.service.
 *
 * Returns the full LaunchAppResult so the q:command_ack carries runningAppId +
 * url + bootstrap for any caller that wants to react before the apps:launched
 * q:event arrives. The frontend's primary path is the event (it listens for
 * all launches, including agent-initiated ones) — this return value is just
 * belt-and-suspenders for the sync command-response path.
 */
async function handleLaunchApp(params: QueryParams): Promise<CommandResult> {
  const appId = requireParam(params, "appId", "launchApp");
  const workspaceId = requireParam(params, "workspaceId", "launchApp");

  // Shared with the agent RPC path — both converge on identical inputs to
  // apps.service.launchApp. Throws on missing workspace / unresolvable path.
  const { workspacePath, userDataDir } = resolveAapPaths({ workspaceId });

  const result = await launchApp({ appId, workspaceId, workspacePath, userDataDir });
  return { ...result };
}

async function handleStopApp(params: QueryParams): Promise<CommandResult> {
  const runningAppId = requireParam(params, "runningAppId", "stopApp");
  await stopApp(runningAppId);
  return { success: true };
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
