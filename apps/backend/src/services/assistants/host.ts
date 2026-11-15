// backend/src/services/assistants/host.ts
// This computer as a host of the operator tools (`@zvada/agent-server/operator`):
// what a session is here, how one is read, and how a turn is started, stopped
// and answered. The tools themselves, their words and their waits are the
// module's.
//
// A session is a workspace's current chat: named by the workspace's slug and
// listed under its project. Only this computer's own workspaces are sessions
// for now: a cloud workspace is never listed, found or acted on, and a start
// always makes a local one. An archived one is not listed; named, it is
// refused as archived (`entry`), not as unknown. Everything goes through the
// operations the app itself uses (`runAsThisComputer`), so an assistant's
// send, stop or answer is the app's own. Who may call which tool is decided
// before a call reaches here (./operator.ts); every write is checked again
// here, just before it happens, since a held call may outlive the person's
// decision: an operation through `act`, the host's own writes (holding or
// dropping a first message, answering a request) by `assertMayWrite`.
//
// A session's id is its workspace's, always; a method reads the chat from the
// row. A start returns as soon as the workspace exists: the host keeps the
// first message and sends it when setup ends. Repeats: an identical request
// from the same caller, made while the first is still in flight, is the same
// request and runs nothing new.

import {
  OperatorError,
  callHint,
  quoted,
  type Answer,
  type OperatorHost,
  type SendOptions,
  type SessionEntry,
  type SessionView,
} from "@zvada/agent-server/operator";
import type { AnyOp, InputOf, OutputOf } from "@shared/api/op";
import * as repos from "@shared/api/repos";
import * as sessions from "@shared/api/sessions";
import * as workspaces from "@shared/api/workspaces";
import { ACTIVE_TURN_STATUSES } from "@shared/enums";
import type { DiffStats, Workspace } from "@shared/types/workspace";
import type { Caller } from "../../api/registry";
import { AppError, ConflictError, NotFoundError } from "../../lib/errors";
import { liveTurnId } from "../agent/service";
import { answer as answerToolRequest, pendingFor } from "../agent/tool-relay";
import { onInvalidate, runAsThisComputer as run } from "../query-engine";
import { getSetting } from "../settings.service";
import { assertMayWrite } from "./access";
import { ASSISTANT_FAILURE } from "./sentences";
import { turnSettings } from "./turn-settings";
import { replyFor, waitingOf } from "./waiting";

/** Lines changed are read for this many of the most recent workspaces; git is not free. */
const DIFF_STATS_LIMIT = 8;
/** How long one workspace's lines changed are reused by the next list. */
const DIFF_STATS_TTL_MS = 15_000;
/** A first message waits this long for its workspace's setup; then it is not sent. */
const SETUP_LIMIT_MS = 30 * 60_000;
/** A turn that was told to stop has this long to end before a message replaces it. */
const STOP_WAIT_MS = 15_000;
/**
 * A stopped turn shows idle before the engine has ended it; a message sent in
 * between is refused as "still working". A send waits this long for it.
 */
const ENDING_WAIT_MS = 5_000;
/** Messages read to find the chat's latest turn. */
const RECENT_MESSAGES = 50;
/** Why a first message was not sent, remembered for this many workspaces. */
const UNSENT_KEPT = 200;
/** The longest a held call waits, for any caller (hosted assistants cut a call off after 2 to 4 minutes). */
const MAX_WAIT_SECONDS = 90;
/** A held call answers this long before its connection is cut, so the answer still arrives. */
const CUT_MARGIN_SECONDS = 5;

const isActive = (status: string | null | undefined) =>
  status != null && ACTIVE_TURN_STATUSES.includes(status);
/** A chat's status as the operator reads it. */
const statusOf = (status: string | null | undefined): "working" | "error" | "idle" =>
  isActive(status) ? "working" : status === "error" ? "error" : "idle";
const WORKING: SessionView = { status: "working", messages: [], waiting: [] };
const gone = () =>
  new OperatorError(`That session is gone (archived or deleted).\n  ${callHint("list_sessions")}`);
const failed = (error: string): SessionView => ({
  status: "error",
  messages: [],
  waiting: [],
  error,
});

/** Whose a request is: an assistant, a paired device, or this computer's own window. */
function callerKey(caller: Caller): string {
  if (caller.assistant) return `assistant:${caller.assistant.clientId}`;
  return caller.deviceId ? `device:${caller.deviceId}` : "window";
}

/** How long one of `caller`'s calls may wait, in whole seconds: the operator's `maxWaitSeconds`. */
export function maxWaitFor(caller: Caller, now = Date.now()): number {
  // Never past the caller's connection, less the margin an answer needs to arrive.
  const left =
    caller.endsAt === undefined ? Infinity : caller.endsAt - now - CUT_MARGIN_SECONDS * 1000;
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(left / 1000)));
}

/** SQLite's `datetime('now')` is UTC without a zone; ISO strings carry one. */
function epochMs(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** `map` with `key` set, keeping at most `limit` entries (the oldest goes first). */
function keep<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value as K);
}

/**
 * One caller's request: in flight while it is being sent (or its workspace
 * made), while it waits as its workspace's first message, or while the turn
 * it started runs.
 */
interface Flight {
  caller: Caller;
  message: string;
  /** Its workspace being made, or its message being sent: null when neither. */
  busy: Promise<unknown> | null;
  workspaceId?: string;
  /** The turn it started, once sent. */
  sessionId?: string;
  turnId?: string;
}

export interface DeusHost extends OperatorHost<Caller> {
  /** The workspace a listed session is (its id is the workspace's), for the tools Deus adds. */
  workspaceOf(sessionId: string): Promise<Workspace>;
  /**
   * Run one of the app's operations for `caller`. A write is refused, just
   * before it happens, when the caller is an assistant no longer allowed to
   * operate. Every operation the tools run goes through here.
   */
  act<O extends AnyOp>(caller: Caller, op: O, input: InputOf<O>): Promise<OutputOf<O>>;
}

export function createDeusHost(): DeusHost {
  const diffStats = new Map<string, { at: number; stats: DiffStats | null }>();
  /** Requests in flight, by caller, workspace (or project, for a start) and message. */
  const flights = new Map<string, Flight>();
  /**
   * First messages waiting for setup, by workspace, with how to stop watching
   * that setup: a watcher lives exactly as long as its entry. They live in this
   * process only: after a restart the session is idle with no messages. This is
   * the one place a backend message queue would replace.
   */
  const firsts = new Map<string, { flight: Flight; unwatch: () => void }>();
  /** Why a workspace's first message was not sent, until a send through the host succeeds. */
  const unsent = new Map<string, string>();

  const inFlight = (f: Flight) =>
    f.busy !== null ||
    (f.workspaceId !== undefined && firsts.get(f.workspaceId)?.flight === f) ||
    (f.turnId !== undefined && liveTurnId(f.sessionId!) === f.turnId);

  /** The flight for this key when it is still in flight; ones that ended are forgotten. */
  function flightOf(key: string): Flight | undefined {
    for (const [k, f] of flights) if (!inFlight(f)) flights.delete(k);
    return flights.get(key);
  }
  const keyOf = (caller: Caller, scope: string, message: string) =>
    JSON.stringify([callerKey(caller), scope, message.trim()]);

  async function act<O extends AnyOp>(
    caller: Caller,
    op: O,
    input: InputOf<O>
  ): Promise<OutputOf<O>> {
    if (op.kind === "write") assertMayWrite(caller);
    return run(op, input);
  }

  /** This computer's own workspaces: the only ones an assistant meets. */
  async function allWorkspaces(): Promise<Workspace[]> {
    const groups = await run(workspaces.workspaces, {});
    return groups.flatMap((group) => group.workspaces).filter((w) => w.kind !== "cloud");
  }

  /**
   * The archived workspace of this computer's own that a reference names, as
   * the module matches a listed one: its id, its name, or project/name.
   */
  async function archivedNamed(ref: string): Promise<Workspace | undefined> {
    const id = ref.trim();
    const key = id.toLowerCase();
    const groups = await run(workspaces.workspaces, { state: "archived" });
    return groups
      .flatMap((group) => group.workspaces)
      .find(
        (w) =>
          w.kind !== "cloud" &&
          (w.id === id ||
            (!key.includes("/") && w.slug.toLowerCase() === key) ||
            `${w.repo_name}/${w.slug}`.toLowerCase() === key)
      );
  }

  /**
   * Lines changed for the most recently active ready workspaces, each reused
   * for a while. Only the ones considered now are kept.
   */
  async function recentDiffStats(all: readonly Workspace[]): Promise<Map<string, DiffStats>> {
    const now = Date.now();
    const recent = all
      .filter((w) => w.state === "ready")
      .sort((a, b) => (activityOf(b) ?? 0) - (activityOf(a) ?? 0))
      .slice(0, DIFF_STATS_LIMIT);
    const considered = new Set(recent.map((w) => w.id));
    for (const id of diffStats.keys()) if (!considered.has(id)) diffStats.delete(id);
    await Promise.all(
      recent.map(async (w) => {
        const held = diffStats.get(w.id);
        if (held && now - held.at < DIFF_STATS_TTL_MS) return;
        const stats = await run(workspaces.diffStats, { workspaceId: w.id }).catch(() => null);
        diffStats.set(w.id, { at: now, stats });
      })
    );
    const found = new Map<string, DiffStats>();
    for (const w of recent) {
      const stats = diffStats.get(w.id)?.stats;
      if (stats) found.set(w.id, stats);
    }
    return found;
  }

  /**
   * The view of a workspace whose chat does not speak for it: being set up or
   * its first message being sent (working), a failed start (error), or a chat
   * with no messages whose first message was not sent (error, with why).
   * Undefined: the chat's own view. "No messages" is the row's, in the list
   * and the view alike.
   */
  function beforeFirst(w: Workspace): SessionView | undefined {
    if (w.state === "initializing" || firsts.has(w.id)) return WORKING;
    const reason = unsent.get(w.id);
    if (!w.current_session_id) return failed(reason ?? w.error_message ?? "Setup failed");
    return reason && !w.latest_message_sent_at ? failed(reason) : undefined;
  }

  /** Its phase as the list shows it: as `beforeFirst`, else its chat's. */
  function phaseOfWorkspace(w: Workspace): SessionEntry["phase"] {
    const before = beforeFirst(w);
    if (before) return before.status;
    const sessionId = w.current_session_id;
    if (sessionId && pendingFor(sessionId).some((request) => waitingOf(request))) {
      return "needs_input";
    }
    return statusOf(w.session_status);
  }

  function entryOf(w: Workspace, stats?: DiffStats): SessionEntry {
    const lines =
      stats && (stats.additions || stats.deletions)
        ? `+${stats.additions} -${stats.deletions}`
        : "";
    const note = [
      lines,
      w.pr_number ? `PR #${w.pr_number}` : "",
      w.setup_status === "failed" ? "setup failed" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const title = w.title ?? undefined;
    const lastActivityAt = activityOf(w);
    return {
      // The workspace's id, before its chat exists and after: a wait keys what it saw by it.
      id: w.id,
      name: w.slug,
      group: w.repo_name,
      phase: phaseOfWorkspace(w),
      ...(title ? { title } : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      ...(note ? { note } : {}),
      root: w.workspace_path,
    };
  }

  /** The one row: one of this computer's own that is not archived, or gone. */
  async function workspaceOf(workspaceId: string): Promise<Workspace> {
    let found: Workspace;
    try {
      found = await run(workspaces.workspace, { workspaceId });
    } catch (error) {
      if (error instanceof NotFoundError) throw gone();
      throw error;
    }
    if (found.kind === "cloud" || found.state === "archived") throw gone();
    return found;
  }

  /** A workspace's chat, or why it has none yet (being set up, or its setup failed). */
  function chatOf(w: Workspace): string {
    if (w.current_session_id) return w.current_session_id;
    throw new OperatorError(
      w.state === "error"
        ? `${quoted(w.slug)} could not be set up: ${quoted(w.error_message ?? "unknown error")}`
        : `${quoted(w.slug)} is still being set up.\n  ${callHint("wait_for_session", { session: w.slug })}`
    );
  }

  /**
   * Resolves at the next change a session may have had (the app invalidates
   * `workspaces`, `sessions` or `session`), or when `signal` aborts; either way
   * its listener is gone.
   */
  function nextChange(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        stop();
        signal.removeEventListener("abort", done);
        resolve();
      };
      const stop = onInvalidate((resources) => {
        if (resources.some((r) => r === "workspaces" || r === "sessions" || r === "session"))
          done();
      });
      if (signal.aborted) done();
      else signal.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * Bounded wait until the chat has no turn running, by its status and by the
   * engine: looked at again at each change the app announces (the engine's
   * `turn.ended` and a stop both invalidate the session), never on a timer.
   */
  async function untilSettled(sessionId: string, ms: number): Promise<boolean> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), ms);
    let look: AbortController | undefined;
    try {
      for (;;) {
        // Listening before the read, so a change that lands while it reads still wakes us.
        look = new AbortController();
        const changed = nextChange(AbortSignal.any([deadline.signal, look.signal]));
        const { status } = (await run(sessions.session, { sessionId })) ?? {};
        if (!isActive(status) && liveTurnId(sessionId) === undefined) return true;
        if (deadline.signal.aborted) return false;
        await changed;
        look.abort();
      }
    } finally {
      look?.abort();
      clearTimeout(timer);
    }
  }

  /** Send one turn to a chat as its composer would; the turn id the app gave it. */
  async function sendOnce(
    caller: Caller,
    sessionId: string,
    message: string,
    { delivery }: SendOptions
  ): Promise<string> {
    const session = await run(sessions.session, { sessionId });
    if (!session) throw new OperatorError(`That session is gone.\n  ${callHint("list_sessions")}`);
    const ref = session.slug ?? sessionId;
    if (delivery === "interrupt" && isActive(session.status)) {
      await act(caller, sessions.stopSession, { sessionId });
      if (!(await untilSettled(sessionId, STOP_WAIT_MS))) {
        throw new OperatorError(
          `${quoted(ref)} did not stop within ${STOP_WAIT_MS / 1000}s, so nothing was sent.\n  ${callHint("wait_for_session", { session: ref })}`
        );
      }
    } else if (!isActive(session.status) && liveTurnId(sessionId) !== undefined) {
      // Stopped a moment ago: let the engine end it, or the send below is refused.
      await untilSettled(sessionId, ENDING_WAIT_MS);
    }
    const { turns } = await run(sessions.messages, { sessionId, limit: RECENT_MESSAGES });
    const settings = turnSettings(
      session.agent_harness,
      turns,
      getSetting("default_thinking_level")
    );
    try {
      const { turnId } = await act(caller, sessions.sendMessage, {
        sessionId,
        content: message,
        ...settings,
      });
      return turnId;
    } catch (error) {
      // Busy: the module's words for it, with the call that answers or waits.
      if (error instanceof ConflictError) {
        const next = pendingFor(sessionId).some((request) => waitingOf(request))
          ? callHint("answer_request", { session: ref, answer: "<your answer>" })
          : callHint("wait_for_session", { session: ref });
        throw new OperatorError(`${error.message} Nothing was sent.\n  ${next}`);
      }
      throw error;
    }
  }

  /** Send `flight`'s message as a turn; it is in flight while sent and while that turn runs. */
  async function sendAs(flight: Flight, sessionId: string, options: SendOptions) {
    const sending = sendOnce(flight.caller, sessionId, flight.message, options);
    flight.busy = sending;
    try {
      flight.turnId = await sending;
      flight.sessionId = sessionId;
    } finally {
      flight.busy = null;
    }
  }

  /** A first message the host holds for `workspaceId`: dropped, with why when it is said later. */
  function drop(workspaceId: string, reason?: string) {
    firsts.get(workspaceId)?.unwatch();
    firsts.delete(workspaceId);
    if (reason) keep(unsent, workspaceId, reason, UNSENT_KEPT);
  }

  /**
   * Keep `flight` as the first message of a workspace being set up, and watch
   * the setup (on the signal `changed` uses: its end invalidates `workspaces`)
   * until the message is sent, dropped, or 30 minutes pass.
   */
  function hold(workspaceId: string, flight: Flight) {
    flight.workspaceId = workspaceId;
    let watching = true;
    const stop = onInvalidate((resources) => {
      if (resources.includes("workspaces")) void look();
    });
    const giveUp = setTimeout(
      () =>
        drop(workspaceId, "Setup did not finish within 30 minutes. The first task was not sent."),
      SETUP_LIMIT_MS
    );
    giveUp.unref?.();
    const unwatch = () => {
      watching = false;
      stop();
      clearTimeout(giveUp);
    };
    firsts.set(workspaceId, { flight, unwatch });
    async function look() {
      let w: Workspace;
      try {
        w = await run(workspaces.workspace, { workspaceId });
      } catch (error) {
        // Gone drops it; any other failure to read is looked at again at the next change.
        if (watching && error instanceof NotFoundError) drop(workspaceId);
        return;
      }
      if (!watching) return;
      if (w.state === "archived") drop(workspaceId);
      else if (w.state === "error") {
        const why = `Setup failed: ${w.error_message ?? "unknown error"}. The first task was not sent.`;
        drop(workspaceId, why);
      } else if (w.state === "ready" && w.current_session_id) {
        unwatch();
        await sendFirst(workspaceId, w.current_session_id);
      }
    }
    void look();
  }

  async function sendFirst(workspaceId: string, sessionId: string) {
    const { flight } = firsts.get(workspaceId)!;
    try {
      // Through `act`: an assistant no longer allowed to operate gets nothing sent.
      await sendAs(flight, sessionId, { delivery: "auto" });
      unsent.delete(workspaceId);
    } catch (error) {
      const known = error instanceof OperatorError || error instanceof AppError;
      if (!known) console.error("[Assistants] A first task could not be sent:", error);
      const why = known ? error.message.split("\n")[0] : ASSISTANT_FAILURE;
      keep(unsent, workspaceId, `The first task was not sent: ${why}`, UNSENT_KEPT);
    } finally {
      firsts.delete(workspaceId);
    }
  }

  /** The project a start names, by its name or its folder's. */
  async function projectNamed(group: string) {
    const projects = await run(repos.repos, {});
    const wanted = group.trim().toLowerCase();
    const project = projects.find(
      (p) =>
        p.name.toLowerCase() === wanted ||
        (p.root_path ?? "").split("/").pop()?.toLowerCase() === wanted
    );
    if (!project) {
      const known = projects.map((p) => quoted(p.name)).join(", ") || "(none)";
      throw new OperatorError(`No project ${quoted(group)} on this computer. Projects: ${known}`);
    }
    return project;
  }

  const host: DeusHost = {
    workspaceOf,
    act,

    async list() {
      const all = await allWorkspaces();
      const stats = await recentDiffStats(all);
      return all.map((w) => entryOf(w, stats.get(w.id)));
    },

    async view(_caller, id, options): Promise<SessionView> {
      const w = await workspaceOf(id);
      const before = beforeFirst(w);
      if (before) return before;
      const sessionId = w.current_session_id!;
      const session = await run(sessions.session, { sessionId });
      if (!session) throw gone();
      const page = await run(sessions.messages, {
        sessionId,
        limit: options?.last ?? RECENT_MESSAGES,
      });
      const status = statusOf(session.status);
      return {
        status,
        messages: page.messages.map((m) => ({
          role: m.role,
          parts: m.parts ?? [],
          ...(m.parent_tool_call_id ? { nested: true } : {}),
        })),
        waiting: pendingFor(sessionId).flatMap((request) => waitingOf(request) ?? []),
        ...(status === "error" && session.error_message ? { error: session.error_message } : {}),
        ...(page.has_older ? { older: true } : {}),
      };
    },

    // Same caller, same session, same words while that message is in flight: a repeat.
    async send(caller, id, message, options) {
      const w = await workspaceOf(id);
      const key = keyOf(caller, w.id, message);
      if (flightOf(key)) return { duplicate: true };
      const flight: Flight = { caller, message, busy: null };
      const first = firsts.get(w.id);
      if (first) {
        // The host's own first message: an interrupt replaces it while it waits.
        if (first.flight.busy || options.delivery !== "interrupt") {
          throw new OperatorError(
            `${quoted(w.slug)} has not started its first task yet. Nothing was sent.\n  ${callHint("wait_for_session", { session: w.slug })}`
          );
        }
        assertMayWrite(caller);
        flight.workspaceId = w.id;
        first.flight = flight;
        flights.set(key, flight);
        // Said, since the view cannot show it: the task that waited will not run.
        return {
          note: `The first task of ${quoted(w.slug)}, not sent yet, was replaced by this message.`,
        };
      }
      // Being set up with no message the host holds: the app may hold the person's.
      const sessionId = chatOf(w);
      flights.set(key, flight);
      await sendAs(flight, sessionId, options);
      unsent.delete(w.id);
      return undefined;
    },

    async cancel(caller, id) {
      const w = await workspaceOf(id);
      const first = firsts.get(w.id);
      if (first && !first.flight.busy) {
        assertMayWrite(caller);
        drop(w.id);
        return {
          note: `The first task of ${quoted(w.slug)} was dropped before it was sent; nothing will run. ${quoted(w.slug)} is still being set up.`,
        };
      }
      // Being sent: let it land, then stop its turn.
      if (first) await first.flight.busy!.catch(() => {});
      const sessionId = chatOf(first ? await workspaceOf(id) : w);
      await act(caller, sessions.stopSession, { sessionId });
      return undefined;
    },

    async respond(caller, id, answer: Answer) {
      const sessionId = (await workspaceOf(id)).current_session_id;
      const request = sessionId
        ? pendingFor(sessionId).find((r) => r.requestId === answer.requestId)
        : undefined;
      if (!request) {
        throw new OperatorError(
          "That request is no longer waiting (it was answered, or its turn ended). Nothing was sent."
        );
      }
      const reply = replyFor(request, answer);
      assertMayWrite(caller);
      // The one answering path: the app's card for it is withdrawn, as when a person answers there.
      answerToolRequest(request.requestId, reply);
    },

    // Same caller, same project, same words while that session is set up or its first turn runs: a repeat.
    async start(caller, { group, message }) {
      const project = await projectNamed(group);
      const key = keyOf(caller, `start:${project.id}`, message);
      const held = flightOf(key);
      if (held) {
        // Its workspace still being made: the same outcome, a failure included.
        if (!held.workspaceId) await held.busy;
        return { ...entryOf(await workspaceOf(held.workspaceId!)), duplicate: true };
      }
      const flight: Flight = { caller, message, busy: null };
      const making = act(caller, workspaces.createWorkspace, {
        repository_id: project.id,
        location: "local",
      });
      flight.busy = making;
      flights.set(key, flight);
      try {
        // Returned as soon as the row exists; its first message is sent when setup ends.
        hold((await making).workspaceId, flight);
      } finally {
        flight.busy = null;
      }
      return entryOf(await run(workspaces.workspace, { workspaceId: flight.workspaceId! }));
    },

    async groups() {
      // Every project on this computer, so one with no session yet is still a place to start.
      return (await run(repos.repos, {})).map((p) => p.name);
    },

    // A reference the list does not hold: one archived is refused as archived, not as a typo.
    async entry(_caller, ref) {
      const archived = await archivedNamed(ref);
      if (archived) {
        throw new OperatorError(
          `${quoted(archived.slug)} in ${quoted(archived.repo_name)} was archived, so nothing was done.`
        );
      }
      return undefined;
    },

    async outcome(_caller, entry) {
      const w = await workspaceOf(entry.id);
      // The chat has messages, but the host's first message was not among them: said once.
      const reason = w.latest_message_sent_at ? unsent.get(w.id) : undefined;
      if (reason) unsent.delete(w.id);
      const lead = reason ? `${reason} ` : "";
      const { files, total_count } = await run(workspaces.diffFiles, { workspaceId: w.id });
      if (files.length === 0) return `${lead}changes: none`;
      const shown = files
        .slice(0, 10)
        .map((f) => `${quoted(f.file)} (+${f.additions} -${f.deletions})`);
      const more = (total_count ?? files.length) - shown.length;
      return `${lead}changes: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
    },

    changed: nextChange,
  };
  return host;
}

function activityOf(w: Workspace): number | undefined {
  return epochMs(w.latest_message_sent_at) ?? epochMs(w.updated_at);
}
