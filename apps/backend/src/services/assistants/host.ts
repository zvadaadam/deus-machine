// backend/src/services/assistants/host.ts
// This computer as the operator tools' host (`@zvada/agent-server/operator`,
// LLP 0019): what a session is here, how one is read, and how a turn is
// started, stopped and answered. The tools, their words, waits, rules and
// limits are the package's.
//
// A session is one chat (a `sessions` row) of one of this computer's own
// workspaces, numbered in its workspace from 1 by creation. A cloud workspace
// is never listed. A workspace being set up is its first chat under the id
// minted with it (`first_session_id`), `setting_up`. Who started each is kept
// (`started_by`, the engine's origin; none is the person).
//
// What stays the host's: the first task. `start` takes the first message;
// a new workspace's is held here and sent as the turn the package minted
// once its first chat is ready (30 minutes at most), and a stop while it waits drops it.
// The checks the package makes are preflight: this host refuses again at its
// commit, in one synchronous step (`Refused`), a start into an archived
// workspace or by an archived starter, a fourth workspace agents started
// being set up at once, and an archive whose members are being set up,
// still active, or started chats not archived. Only a chat an agent or an
// assistant started is archived on its own (hidden: `is_hidden`), never a
// person's, never a workspace's last; archiving a workspace is the app's.
//
// Every mutation re-reads what it depends on (the caller's access, the
// starter and target not archived, the setup count, archive eligibility and
// lineage, the target's state) in the same synchronous step as its write,
// with no await between: one helper per mutation (`mayStart`, `mayTouch`,
// `mayArchive`). A held call can outlive the person's decision, and another
// caller can change what the package's preflight read. A session's own calls
// act as this computer.

import {
  OperatorError,
  Refused,
  callHint,
  refuse,
  refOf,
  type Answer,
  type CancelOutcome,
  type Caller as OperatorCaller,
  type Entry,
  type ModelEntry,
  type OperatorHost,
  type SessionStatus,
  type SessionView,
  type StartInput,
  type TurnEnded,
  type TurnFact,
  type ViewTurn,
} from "@zvada/agent-server/operator";
import type { Origin } from "@zvada/agent-server/protocol";
import type { AnyOp, InputOf, OutputOf } from "@shared/api/op";
import * as sessions from "@shared/api/sessions";
import { uuidv7 } from "@shared/lib/uuid";
import * as workspaces from "@shared/api/workspaces";
import { ACTIVE_TURN_STATUSES, type AgentHarness } from "@shared/enums";
import { HARNESSES } from "@shared/harnesses";
import { githubRepoSlug } from "@shared/git-origin";
import { DEFAULT_AGENT_HARNESS, defaultModelId, harnessNamed, pickerModels } from "@shared/models";
import { LOCAL_CALLER, type Caller } from "../../api/registry";
import { archiveWorkspace } from "../workspace-archive.service";
import { createLocalWorkspace } from "../workspace-init.service";
import {
  attachParts,
  encodeOrigin,
  getMessages,
  getSessionRaw,
  hasOlderMessages,
  START_RECOVERABLE,
} from "../../db";
import { getDatabase } from "../../lib/database";
import { AgentServerDisconnectedError, AppError, ChatBusyError } from "../../lib/errors";
import { computeWorkspacePath } from "../../middleware/workspace-loader";
import { liveTurnId } from "../agent/service";
import { answer as answerToolRequest, pendingFor } from "../agent/tool-relay";
import { sendMessage, stopSession } from "../agent/turns";
import { invalidate, onInvalidate, runAsThisComputer as run } from "../query-engine";
import { getServerName } from "../server-name";
import { assertMayWrite, refusalFor, storedAccess } from "./access";
import { operatorModelLists, turnSettings, type TurnSettings } from "./turn-settings";
import { replyFor, waitingOf } from "./waiting";

/** How long a first task waits for its workspace to be ready. */
const SETUP_LIMIT_MS = 30 * 60_000;
/** Workspaces agents started that may be set up at once, on this computer. */
const AGENT_SETUPS = 3;
/** How long a stop waits for its turn to end before it says it is not confirmed. */
const STOP_WAIT_MS = 10_000;

/** A caller of the tools here: an outside caller carrying the app's own, or a session. */
export type Who = OperatorCaller<Caller>;
const PERSON: Origin = { kind: "person" };

/** The app's caller a call acts as: an outside caller's own; a session's acts as this computer. */
const appCaller = (caller: Who): Caller =>
  caller.kind === "external" ? caller.auth : LOCAL_CALLER;

const originOf = (caller: Who): Origin =>
  caller.kind === "session"
    ? { kind: "session", sessionId: caller.sessionId }
    : caller.speaksAs === "person"
      ? PERSON
      : { kind: "assistant", id: caller.id, name: caller.name ?? caller.id };

function readOrigin(text: string | null | undefined): Origin {
  if (!text) return PERSON;
  try {
    return JSON.parse(text) as Origin;
  } catch {
    return PERSON;
  }
}

const sameOrigin = (a: Origin, b: Origin) =>
  a.kind === b.kind &&
  (a.kind === "person" ||
    (a.kind === "session" && a.sessionId === (b as { sessionId?: string }).sessionId) ||
    (a.kind === "assistant" && a.id === (b as { id?: string }).id));

/** SQLite's `datetime('now')` is UTC without a zone. */
function epochMs(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** One chat (or a workspace's first, before its row exists), as the database has it. */
interface Row {
  workspace_id: string;
  slug: string;
  ws_title: string | null;
  state: string;
  error_message: string | null;
  current_session_id: string | null;
  first_session_id: string | null;
  ws_started_by: string | null;
  ws_updated_at: string | null;
  repository_id: string;
  repo_name: string;
  root_path: string | null;
  session_id: string | null;
  s_status: string | null;
  s_title: string | null;
  agent_harness: string | null;
  s_started_by: string | null;
  last_user_message_at: string | null;
  is_hidden: number | null;
  chat: number | null;
  s_error: string | null;
  message_count: number | null;
  s_updated_at: string | null;
}

const ROWS = `
  SELECT w.id AS workspace_id, w.slug, w.title AS ws_title, w.state, w.error_message,
    w.current_session_id, w.first_session_id, w.started_by AS ws_started_by, w.updated_at AS ws_updated_at,
    r.id AS repository_id, r.name AS repo_name, r.root_path,
    s.id AS session_id, s.status AS s_status, s.title AS s_title, s.agent_harness,
    s.started_by AS s_started_by, s.last_user_message_at, s.is_hidden, s.chat,
    s.error_message AS s_error, s.message_count, s.updated_at AS s_updated_at
  FROM workspaces w JOIN repositories r ON r.id = w.repository_id
  LEFT JOIN sessions s ON s.workspace_id = w.id
  WHERE w.kind != 'cloud'`;

/** How a turn ended, from its row: the engine's stop reason, and who stopped it. */
function endedOf(row: { outcome: string | null; cancelled_by: string | null }) {
  const outcome = row.outcome
    ? (JSON.parse(row.outcome) as { stopReason?: string; error?: unknown })
    : {};
  const how: TurnEnded["outcome"] =
    outcome.stopReason === "cancelled"
      ? "cancelled"
      : outcome.stopReason === "error" || outcome.error
        ? "failed"
        : "done";
  return {
    outcome: how,
    ...(how === "cancelled" && row.cancelled_by
      ? { cancelledBy: readOrigin(row.cancelled_by) }
      : {}),
  };
}

/** A first task the host holds for a workspace being set up; `sending` once it is handed to the engine. */
interface Held {
  caller: Who;
  workspaceId: string;
  input: StartInput;
  settings: TurnSettings;
  unwatch: () => void;
  /** When it was held: one held past SETUP_LIMIT_MS is not sent. */
  since: number;
  sending?: Promise<void>;
}

/** A turn's facts, as its row has them. */
interface TurnRow {
  turn_id: string;
  started_at: number | null;
  ended_at: number | null;
  outcome: string | null;
  cancelled_by: string | null;
}

export interface DeusHost extends OperatorHost<Caller> {
  /** Run one of the app's operations for the call's caller; a write's access read again just before it. */
  act<O extends AnyOp>(caller: Who, op: O, input: InputOf<O>): Promise<OutputOf<O>>;
}

/** Return the refusal sentence, which OperatorError exposes only in its rendered message. */
export function refusalSentence(error: OperatorError): string {
  return error.message.split("\n", 1)[0]!.replace(/^refused \([a-z_]+\): /, "");
}

/**
 * The app's own refusals (4xx) in the package's words; anything else as it is,
 * for `onError`. An access refusal at a commit reads as the package's own
 * before it (`authorize`): its sentence, then this computer's.
 */
function appRefusal(error: unknown): unknown {
  if (error instanceof AgentServerDisconnectedError)
    return new OperatorError(
      "unsupported",
      "The agent engine is not running on this computer. Nothing was sent or started. Restart Deus before sending the task again."
    );
  if (!(error instanceof AppError) || error.statusCode >= 500) return error;
  return error.statusCode === 403
    ? refuse.access(error.message)
    : new OperatorError("unsupported", `${error.message} Nothing was done.`);
}

/** Run `work`, its app refusals said as refusals. */
export async function refusing<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw appRefusal(error);
  }
}

/**
 * Where the sessions an outside caller sees are: this computer's own
 * workspaces, never the cloud's. Said in the MCP server's instructions and in
 * `whoami`, since `list_sessions` names no computer.
 */
export const whereSentence = () =>
  `These are the coding agents on the computer ${JSON.stringify(getServerName())} itself: its own workspaces and their chats. Cloud workspaces are not listed here.`;

/** The agents a start may name, as a refusal lists them: `"claude-code" (Claude Code) and …`. */
const AGENT_NAMES = Object.entries(HARNESSES)
  .map(([id, { label }]) => `${JSON.stringify(id)} (${label})`)
  .join(" and ");

/** What a chat the host could not deliver its first task to says, the reason kept safe. */
const NOT_DELIVERED = "Its first task could not be delivered.";

export function createDeusHost(): DeusHost {
  /** First tasks held for workspaces being set up, by the chat's id. */
  const firsts = new Map<string, Held>();

  function act<O extends AnyOp>(caller: Who, op: O, input: InputOf<O>): Promise<OutputOf<O>> {
    if (op.kind === "write") assertMayWrite(appCaller(caller));
    return run(op, input);
  }

  /**
   * The rows, a workspace with neither a chat nor a first chat's id given one
   * now (stored once), so it is listed, retried and removed like any other.
   */
  function rows(where = "", ...args: unknown[]): Row[] {
    const db = getDatabase();
    const query = () =>
      db
        .prepare(`${ROWS} ${where} ORDER BY w.id, COALESCE(s.chat, 1e9), s.id`)
        .all(...args) as Row[];
    const found = query();
    const missing = found.filter((r) => !r.session_id && !r.first_session_id);
    if (!missing.length) return found;
    for (const r of missing)
      db.prepare(
        "UPDATE workspaces SET first_session_id = ? WHERE id = ? AND first_session_id IS NULL"
      ).run(uuidv7(), r.workspace_id);
    return query();
  }

  /** Each chat's last ended turn, in one read. */
  function lastEnded(ids: readonly string[]): Map<string, TurnEnded> {
    const found = getDatabase()
      .prepare(
        `SELECT session_id, turn_id, outcome, cancelled_by, MAX(ended_at) AS ended_at FROM turns
         WHERE ended_at IS NOT NULL AND session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id`
      )
      .all(JSON.stringify(ids)) as {
      session_id: string;
      turn_id: string;
      outcome: string | null;
      cancelled_by: string | null;
    }[];
    return new Map(found.map((t) => [t.session_id, { turnId: t.turn_id, ...endedOf(t) }]));
  }

  function statusOf(row: Row, ended?: TurnEnded): SessionStatus {
    const id = row.session_id;
    if (row.state === "archived" || row.is_hidden) return "archived";
    if (!id) return row.state === "error" ? "error" : "setting_up";
    if (firsts.has(id)) return "setting_up";
    if (pendingFor(id).some((request) => waitingOf(request))) return "needs_input";
    if (ACTIVE_TURN_STATUSES.includes(row.s_status ?? "") || liveTurnId(id)) return "working";
    if (row.s_status === "error") return "error";
    return ended?.outcome === "cancelled" ? "stopped" : "idle";
  }

  /** The entries the rows make: each workspace's chats by their number, its first before its row exists. */
  function entriesOf(found: readonly Row[]): Entry[] {
    const ended = lastEnded(found.flatMap((r) => (r.session_id ? [r.session_id] : [])));
    const counted = new Map<string, number>();
    return found.flatMap((row): Entry[] => {
      const id = row.session_id ?? row.first_session_id;
      if (!id) return [];
      // Its stored number (made in order, never moved); a chat from before numbers counts on.
      const chat = row.chat ?? (counted.get(row.workspace_id) ?? 0) + 1;
      counted.set(row.workspace_id, chat);
      const status = statusOf(row, ended.get(id));
      // The workspace's title and time stand in only for a first chat with no row yet.
      const title = row.session_id ? row.s_title : row.ws_title;
      const activity = Math.max(
        epochMs(row.last_user_message_at) ?? 0,
        epochMs(row.session_id ? row.s_updated_at : row.ws_updated_at) ?? 0
      );
      const root = computeWorkspacePath({ root_path: row.root_path, slug: row.slug });
      // Why: a failed start, or a first task that could not be delivered (no messages yet).
      const error = !row.session_id
        ? row.error_message
        : status === "error" && !row.message_count
          ? row.s_error
          : null;
      return [
        {
          id,
          project: { id: row.repository_id, name: row.repo_name },
          workspace: { id: row.workspace_id, name: row.slug },
          chat,
          current: row.current_session_id ? row.current_session_id === id : chat === 1,
          status,
          startedBy: readOrigin(row.s_started_by ?? (row.session_id ? null : row.ws_started_by)),
          ...(row.agent_harness ? { harness: row.agent_harness as AgentHarness } : {}),
          ...(title ? { title } : {}),
          ...(activity ? { lastActivityAt: activity } : {}),
          ...(status === "error" && error ? { error } : {}),
          ...(root ? { root } : {}),
        },
      ];
    });
  }

  /** Every entry, archived ones too (names resolve over them). */
  const everything = () => entriesOf(rows());
  const entryById = (id: string) =>
    entriesOf(
      rows(
        "AND w.id = (SELECT workspace_id FROM sessions WHERE id = ? UNION SELECT id FROM workspaces WHERE first_session_id = ?)",
        id,
        id
      )
    ).find((e) => e.id === id);

  /** Workspaces agents started that are being set up now. */
  const agentSetups = () =>
    (
      getDatabase()
        .prepare(
          `SELECT COUNT(*) AS n FROM workspaces WHERE kind != 'cloud'
           AND (state = 'initializing' OR setup_status = 'running')
           AND json_extract(started_by, '$.kind') = 'session'`
        )
        .get() as { n: number }
    ).n;

  // ---- the commit checks: each re-reads, synchronously, right before its write ----

  /**
   * A start may be made now: the caller still allowed, a starting chat not
   * archived, an agent's new workspace under the cap, a chat's workspace ready.
   */
  function mayStart(caller: Who, input: StartInput) {
    assertMayWrite(appCaller(caller));
    if (caller.kind === "session" && entryById(caller.sessionId)?.status === "archived")
      throw new Refused({ code: "archived", sessions: [caller.sessionId] });
    if (input.workspace) {
      const w = getDatabase()
        .prepare("SELECT state, first_session_id FROM workspaces WHERE id = ?")
        .get(input.workspace.id) as { state: string; first_session_id: string | null } | undefined;
      const named = w?.first_session_id ? [w.first_session_id] : [];
      if (!w || w.state === "archived") throw new Refused({ code: "archived", sessions: named });
      if (w.state !== "ready")
        throw new Refused({ code: "busy", sessions: named, state: "setting_up" });
    } else if (input.origin.kind === "session" && agentSetups() >= AGENT_SETUPS) {
      throw new Refused({ code: "limit_setting_up", retryAfter: 30 });
    }
  }

  /** A chat may be sent to, stopped or answered now: the caller allowed, the chat and its workspace not archived. */
  function mayTouch(caller: Who, sessionId: string) {
    assertMayWrite(appCaller(caller));
    const found = getDatabase()
      .prepare(
        "SELECT s.is_hidden, w.state, w.kind FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?"
      )
      .get(sessionId) as { is_hidden: number; state: string; kind: string } | undefined;
    if (!found || found.kind === "cloud")
      throw new OperatorError("not_found", "That session is gone. Nothing was done.");
    if (found.is_hidden || found.state === "archived")
      throw new Refused({ code: "archived", sessions: [sessionId] });
  }

  /** A busy refusal lets the operator stop the caller's turns. Check everything a stop cannot change first. */
  function mayArchive(caller: Who, members: readonly Entry[], all: readonly Entry[]) {
    assertMayWrite(appCaller(caller));
    const starting = members.find((m) => m.status === "setting_up");
    if (starting) throw new Refused({ code: "busy", sessions: [starting.id], state: "setting_up" });
    const active = members.filter((m) => m.status === "working" || m.status === "needs_input");
    const origin = originOf(caller);
    const others = active.filter((m) => !sameOrigin(m.startedBy, origin));
    if (others.length)
      throw new Refused({
        code: "not_yours",
        sessions: others.map((m) => m.id),
        state: others[0]!.status,
      });

    const ids = new Set(members.map((m) => m.id));
    const children = all.filter(
      (e) =>
        e.status !== "archived" && e.startedBy.kind === "session" && ids.has(e.startedBy.sessionId)
    );
    if (children.length)
      throw new Refused({ code: "has_children", sessions: children.map((c) => c.id) });
    // The operator words the refusal for the first named member and checks each turn before stopping it.
    if (active.length)
      throw new Refused({
        code: "busy",
        sessions: active.map((m) => m.id),
        state: active[0]!.status,
      });
  }

  // ---- the first task ---------------------------------------------------------------

  /**
   * Send a chat's first task as the turn the package minted, with its title;
   * one that cannot be delivered leaves the chat in error, with a safe reason
   * its entry and view show.
   */
  async function sendFirst(
    caller: Who,
    sessionId: string,
    input: StartInput,
    settings: TurnSettings
  ) {
    try {
      mayTouch(caller, sessionId);
      if (input.title) {
        // The chat takes it; its workspace only when this is its first chat (a side chat
        // started in a person's workspace does not rename it).
        const db = getDatabase();
        db.prepare("UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL").run(
          input.title,
          sessionId
        );
        db.prepare(
          "UPDATE workspaces SET title = ? WHERE first_session_id = ? AND title IS NULL"
        ).run(input.title, sessionId);
      }
      await sendMessage(
        { sessionId, content: input.message, turnId: input.turnId, ...settings },
        input.origin
      );
    } catch (error) {
      const said = appRefusal(error);
      undelivered(sessionId, said instanceof OperatorError ? refusalSentence(said) : "");
      throw said;
    }
  }

  /** The chat's first task was not delivered: its error says so, and why. */
  function undelivered(sessionId: string, why: string) {
    getDatabase()
      .prepare(
        "UPDATE sessions SET status = 'error', error_message = ? WHERE id = ? AND message_count = 0"
      )
      .run(`${NOT_DELIVERED}${why ? ` ${why}` : ""}`, sessionId);
    invalidate(["workspaces", "sessions", "session"], { sessionIds: [sessionId] });
  }

  function drop(sessionId: string) {
    firsts.get(sessionId)?.unwatch();
    firsts.delete(sessionId);
  }

  /**
   * Hold the first task until its chat is ready. A failed, archived or over-age
   * start drops it. During engine admission a stop waits and uses the minted id.
   */
  function hold(sessionId: string, held: Omit<Held, "unwatch" | "since">) {
    const stop = onInvalidate((resources) => {
      if (resources.includes("workspaces")) look();
    });
    const entry: Held = { ...held, since: Date.now(), unwatch: stop };
    firsts.set(sessionId, entry);
    function look() {
      if (firsts.get(sessionId) !== entry || entry.sending) return;
      const w = getDatabase()
        .prepare("SELECT state, current_session_id FROM workspaces WHERE id = ?")
        .get(held.workspaceId) as { state: string; current_session_id: string | null } | undefined;
      if (!w || w.state === "archived" || w.state === "error") drop(sessionId);
      else if (w.state === "ready" && w.current_session_id === sessionId) {
        if (Date.now() - entry.since > SETUP_LIMIT_MS) {
          drop(sessionId);
          undelivered(sessionId, "Setup took longer than 30 minutes.");
          return;
        }
        entry.unwatch();
        entry.sending = sendFirst(held.caller, sessionId, held.input, held.settings)
          .catch(() => {})
          .finally(() => {
            firsts.delete(sessionId);
            // Told after the hold is gone, so a wait that reads again sees the outcome.
            invalidate(["sessions"], { sessionIds: [sessionId] });
          });
        invalidate(["sessions"], { sessionIds: [sessionId] });
      }
    }
    look();
  }

  /** The chat's turn ended or not, read again at each change, for a stop to confirm. */
  async function ended(sessionId: string, turnId: string): Promise<boolean> {
    if (liveTurnId(sessionId) !== turnId) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), STOP_WAIT_MS);
      const stop = onInvalidate(() => {
        if (liveTurnId(sessionId) !== turnId) finish(true);
      });
      function finish(done: boolean) {
        clearTimeout(timer);
        stop();
        resolve(done);
      }
    });
  }

  /** Stop this turn, by whoever asks, and confirm its end. */
  async function stopTurn(caller: Who, sessionId: string, turnId: string): Promise<CancelOutcome> {
    if (liveTurnId(sessionId) !== turnId) return "not_running";
    mayTouch(caller, sessionId);
    // Named like a send's sender, so every reader sees who stopped it, not an id.
    let by = originOf(caller);
    if (by.kind === "session") {
      const all = everything();
      const own = all.find((e) => e.id === (by as { sessionId: string }).sessionId);
      if (own) by = { ...by, name: refOf(own, all) };
    }
    const { unconfirmed } = await stopSession({ sessionId }, by);
    if (unconfirmed) return "unconfirmed";
    return (await ended(sessionId, turnId)) ? "stopped" : "unconfirmed";
  }

  // ---- reading turns ------------------------------------------------------------------

  /** A chat's turns: those of the page's messages, plus any that ended since `endedAfter` or have no message. */
  function turnsOf(sessionId: string, ids: readonly string[], endedAfter: number | null) {
    // `endedAfter` is the turn end order (`end_seq`) the reader's cursor saw.
    return getDatabase()
      .prepare(
        `SELECT turn_id, started_at, ended_at, outcome, cancelled_by FROM turns t WHERE session_id = ? AND (
           turn_id IN (SELECT value FROM json_each(?))
           OR (? IS NOT NULL AND end_seq > ?)
           OR (? IS NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id)))
         ORDER BY COALESCE(started_at, ended_at), turn_id`
      )
      .all(sessionId, JSON.stringify(ids), endedAfter, endedAfter ?? 0, endedAfter) as TurnRow[];
  }

  const host: DeusHost = {
    act,

    async list(_caller, filter) {
      const all = everything();
      return filter.includeArchived ? all : all.filter((e) => e.status !== "archived");
    },

    // Every project, one only in the cloud too: a start there says how to put it here.
    async projects() {
      return getDatabase()
        .prepare("SELECT id, name FROM repositories ORDER BY sort_order")
        .all() as { id: string; name: string }[];
    },

    async view(_caller, sessionId, options): Promise<SessionView> {
      const entry = entryById(sessionId);
      if (!entry) throw new OperatorError("not_found", "That session is gone. Nothing was read.");
      const db = getDatabase();
      if (!getSessionRaw(db, sessionId)) return { status: entry.status, turns: [], waiting: [] };
      // The cursor is where the read ended: the last message of a turn that has ended (a
      // turn still running is read again, whole, next time), and the last turn end it saw.
      const after = options.after === undefined ? undefined : /^(\d+)\.(\d+)$/.exec(options.after);
      if (options.after !== undefined && !after)
        throw new OperatorError("stale_cursor", "That cursor is not this host's.");
      const rows = after
        ? getMessages(db, sessionId, { after: Number(after[1]), limit: 500 })
        : getMessages(db, sessionId, { limit: options.last ?? 20 });
      const messages = attachParts(db, rows);
      const ids = [...new Set(rows.flatMap((m) => (m.turn_id ? [m.turn_id] : [])))];
      const known = turnsOf(sessionId, ids, after ? Number(after[2]) : null);
      // A page's turn with no row yet (its facts not written) still shows its messages.
      const facts: TurnRow[] = [
        ...known,
        ...ids
          .filter((id) => !known.some((t) => t.turn_id === id))
          .map((turn_id) => ({
            turn_id,
            started_at: null,
            ended_at: null,
            outcome: null,
            cancelled_by: null,
          })),
      ];
      const running = liveTurnId(sessionId);
      const turns: ViewTurn[] = facts.map((fact) => {
        const how = fact.turn_id === running || !fact.ended_at ? undefined : endedOf(fact);
        const failed = fact.outcome
          ? (JSON.parse(fact.outcome) as { error?: { message?: string } })
          : {};
        return {
          turnId: fact.turn_id,
          outcome: how?.outcome ?? "running",
          ...(how?.cancelledBy ? { cancelledBy: how.cancelledBy } : {}),
          ...(how?.outcome === "failed" && failed.error?.message
            ? { error: failed.error.message }
            : {}),
          messages: messages
            .filter((m) => m.turn_id === fact.turn_id)
            .map((m) => ({
              role: m.role,
              parts: m.parts ?? [],
              ...(m.parent_tool_call_id ? { nested: true } : {}),
              ...(m.origin && m.origin.kind !== "person" ? { origin: m.origin } : {}),
            })),
        };
      });
      const last = lastEnded([sessionId]).get(sessionId);
      const read = rows.at(-1)?.seq ?? (after ? Number(after[1]) : 0);
      // Not past the first message of a turn that has not ended: its messages still change.
      const open = (
        db
          .prepare(
            `SELECT MIN(m.seq) AS seq FROM messages m
             LEFT JOIN turns t ON t.session_id = m.session_id AND t.turn_id = m.turn_id
             WHERE m.session_id = ? AND m.turn_id IS NOT NULL AND t.ended_at IS NULL`
          )
          .get(sessionId) as { seq: number | null }
      ).seq;
      const seq = open !== null ? Math.min(read, open - 1) : read;
      const endMark = (
        db.prepare("SELECT MAX(end_seq) AS n FROM turns WHERE session_id = ?").get(sessionId) as {
          n: number | null;
        }
      ).n;
      return {
        status: entry.status,
        turns,
        waiting: pendingFor(sessionId).flatMap((request) => waitingOf(request) ?? []),
        cursor: `${seq}.${endMark ?? 0}` as never,
        ...(running ? { running } : {}),
        ...(last ? { lastEnded: last } : {}),
        // A read with a cursor continues from it: what precedes the page was read already.
        ...(!after && rows.length && hasOlderMessages(db, sessionId, rows[0]!.seq)
          ? { older: true }
          : {}),
      };
    },

    async turn(_caller, sessionId, turnId): Promise<TurnFact> {
      if (liveTurnId(sessionId) === turnId) return { state: "running" };
      const row = getDatabase()
        .prepare(
          "SELECT ended_at, outcome, cancelled_by FROM turns WHERE session_id = ? AND turn_id = ?"
        )
        .get(sessionId, turnId) as
        | { ended_at: number | null; outcome: string | null; cancelled_by: string | null }
        | undefined;
      return row?.ended_at ? { state: "ended", ...endedOf(row) } : { state: "unknown" };
    },

    send: (caller, sessionId, { turnId, message, origin }) =>
      refusing(async () => {
        const session = getSessionRaw(getDatabase(), sessionId);
        if (!session)
          throw new OperatorError("not_found", "That session is gone. Nothing was sent.");
        if (firsts.has(sessionId))
          throw new Refused({ code: "busy", sessions: [sessionId], state: "setting_up" });
        // As the chat's composer would continue it: its latest turn's model and thinking.
        const { turns } = await run(sessions.messages, { sessionId, limit: 50 });
        const settings = await turnSettings(session.agent_harness, turns, session.workspace_id);
        mayTouch(caller, sessionId);
        try {
          await sendMessage({ sessionId, content: message, turnId, ...settings }, origin);
        } catch (error) {
          // Busy: the engine admits one turn per chat.
          if (error instanceof ChatBusyError)
            throw new Refused({ code: "busy", sessions: [sessionId] });
          throw error;
        }
      }),

    start: (caller, input) =>
      refusing(async () => {
        const db = getDatabase();
        const repo = db
          .prepare("SELECT root_path, git_origin_url FROM repositories WHERE id = ?")
          .get(input.project.id) as
          | { root_path: string | null; git_origin_url: string | null }
          | undefined;
        if (!repo?.root_path) {
          const origin = repo?.git_origin_url;
          const repository = origin ? (githubRepoSlug(origin) ?? origin) : undefined;
          throw new OperatorError(
            "unsupported",
            `${JSON.stringify(input.project.name)} is a cloud project: it has no folder on this computer, so no session can start here. Nothing was started; add_project puts it on this computer.`,
            repository ? { next: callHint("add_project", { repository }) } : {}
          );
        }
        // The agent, model and thinking level before anything is made.
        // By its id or as people say it ("Claude", "claude code", "Codex").
        const harness =
          input.harness === undefined ? DEFAULT_AGENT_HARNESS : harnessNamed(input.harness);
        if (!harness)
          throw new OperatorError(
            "invalid_input",
            `start_session: agent: ${JSON.stringify(input.harness)} does not run here; the agents are ${AGENT_NAMES}. Nothing was started.`
          );
        const settings = await turnSettings(harness, [], input.workspace?.id, input);
        if (input.workspace) {
          const workspaceId = input.workspace.id;
          const sessionId = uuidv7();
          // The commit: checked and inserted in one synchronous step.
          mayStart(caller, input);
          db.transaction(() => {
            db.prepare(
              "INSERT INTO sessions (id, workspace_id, status, agent_harness, started_by, updated_at) VALUES (?, ?, 'idle', ?, ?, datetime('now'))"
            ).run(sessionId, workspaceId, harness, encodeOrigin(input.origin));
            db.prepare("UPDATE workspaces SET current_session_id = ? WHERE id = ?").run(
              sessionId,
              workspaceId
            );
          })();
          invalidate(["workspaces", "sessions"]);
          // Made: a first task that cannot be delivered is the chat's error, not a refusal.
          await sendFirst(caller, sessionId, input, settings).catch(() => {});
          return entryById(sessionId)!;
        }
        mayStart(caller, input);
        const { workspaceId, firstSessionId } = await createLocalWorkspace(
          { repository_id: input.project.id },
          { startedBy: input.origin, admit: () => mayStart(caller, input) }
        );
        hold(firstSessionId, { caller, workspaceId, input, settings });
        return entryById(firstSessionId)!;
      }),

    cancel: (caller, sessionId, turnId): Promise<CancelOutcome> =>
      refusing(async () => {
        if (turnId) return stopTurn(caller, sessionId, turnId);
        const held = firsts.get(sessionId);
        if (!held) return "not_running";
        if (held.sending) {
          // Being handed to the engine: wait for its admission, then stop it by its minted id.
          await held.sending;
          return stopTurn(caller, sessionId, held.input.turnId);
        }
        assertMayWrite(appCaller(caller));
        drop(sessionId);
        return "first_task_dropped";
      }),

    respond: (caller, sessionId, answer: Answer) =>
      refusing(() => {
        const request = pendingFor(sessionId).find((r) => r.requestId === answer.requestId);
        if (!request) return { accepted: false };
        const reply = replyFor(request, answer);
        mayTouch(caller, sessionId);
        // The one answering path: the app's card for it is withdrawn, as when a person answers there.
        return { accepted: answerToolRequest(request.requestId, reply) };
      }),

    archive: (caller, target) =>
      refusing(async () => {
        const db = getDatabase();
        if (target.kind === "workspace") {
          const members = () =>
            everything().filter((e) => e.workspace.id === target.id && e.status !== "archived");
          const w = db
            .prepare<[string], { git_branch: string | null; start_recoverable: 0 | 1 }>(
              `SELECT git_branch, ${START_RECOVERABLE("workspaces")} AS start_recoverable
               FROM workspaces WHERE id = ?`
            )
            .get(target.id);
          if (!w)
            throw new OperatorError("not_found", "That workspace is gone. Nothing was archived.");
          // A recoverable start has no chat or computer to keep.
          if (w.start_recoverable) {
            mayArchive(caller, members(), everything());
            await act(caller, workspaces.deleteWorkspace, { workspaceId: target.id });
            return { note: "Its start had failed, so it was removed." };
          }
          // Eligibility read again inside the app's queue, right before the update.
          await archiveWorkspace(
            target.id,
            () => mayArchive(caller, members(), everything()),
            originOf(caller)
          );
          return {
            note: `Its branch${w.git_branch ? ` ${JSON.stringify(w.git_branch)}` : ""} and changes are kept.`,
          };
        }
        const all = everything();
        const entry = all.find((e) => e.id === target.id);
        if (!entry || entry.status === "archived") return {};
        // The person's chats are the person's to close; one an agent or an assistant started may go.
        if (entry.startedBy.kind === "person")
          throw new Refused({
            code: "unsupported",
            detail:
              "A chat the person started is closed by the person in Deus; archive its workspace instead if that is what was asked.",
          });
        const visible = all.filter(
          (e) => e.workspace.id === entry.workspace.id && e.status !== "archived"
        );
        if (visible.length <= 1)
          throw new Refused({
            code: "unsupported",
            detail: "It is its workspace's last chat; archive the workspace instead.",
          });
        mayArchive(caller, [entry], all);
        db.transaction(() => {
          db.prepare("UPDATE sessions SET is_hidden = 1 WHERE id = ?").run(entry.id);
          // The workspace's current chat becomes its newest visible one, by its number.
          db.prepare(
            `UPDATE workspaces SET current_session_id = (
               SELECT id FROM sessions WHERE workspace_id = ? AND is_hidden = 0 ORDER BY chat DESC, id DESC LIMIT 1)
             WHERE id = ? AND current_session_id = ?`
          ).run(entry.workspace.id, entry.workspace.id, entry.id);
        })();
        // The chat's own record too: a "Sent from" chip already drawn stops being a link.
        invalidate(["workspaces", "sessions"]);
        invalidate(["session"], { sessionIds: [entry.id] });
        return { note: "The chat is put away; its workspace stays." };
      }),

    async models() {
      const lists = await operatorModelLists();
      return lists.flatMap((list) =>
        pickerModels(lists, list.harness).map(
          (m): ModelEntry => ({
            harness: m.harness,
            id: m.id,
            label: m.label,
            thinkingLevels: m.thinking.levels,
            ...(m.thinking.default ? { defaultThinkingLevel: m.thinking.default } : {}),
            ...(m.id === defaultModelId(lists, list.harness) ? { default: true } : {}),
            ...(list.harness === DEFAULT_AGENT_HARNESS ? { defaultHarness: true } : {}),
          })
        )
      );
    },

    authorize(caller, { effect, tool }) {
      const { assistant } = caller.auth;
      if (!assistant) return undefined;
      // Feedback to the Deus team changes nothing here: an assistant allowed to read may send it.
      const wanted = effect === "read" || tool === "send_feedback" ? "read" : "operate";
      // What its connection was admitted with, and what is stored now: the lower one holds.
      const refusal =
        refusalFor(assistant.access, wanted) ?? refusalFor(storedAccess(assistant), wanted);
      return refusal ? { code: "access", detail: refusal } : undefined;
    },

    // An outside caller is told which computer it reaches, which the list does not say.
    async describe(caller) {
      if (caller.kind !== "external") return undefined;
      const assistant = caller.auth.assistant;
      const access = assistant ? `access: ${storedAccess(assistant) ?? "none"}. ` : "";
      return `${access}${whereSentence()}`;
    },

    async outcome(caller, entry) {
      try {
        const { files, total_count } = await act(caller, workspaces.diffFiles, {
          workspaceId: entry.workspace.id,
        });
        if (files.length === 0) return "changes: none";
        const shown = files
          .slice(0, 10)
          .map((f) => `${JSON.stringify(f.file)} (+${f.additions} -${f.deletions})`);
        const more = (total_count ?? files.length) - shown.length;
        return `changes: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
      } catch (error) {
        if (error instanceof AppError && error.statusCode < 500) return error.message;
        throw error;
      }
    },

    onChange(listener) {
      return onInvalidate((resources, ctx) => {
        if (!resources.some((r) => r === "workspaces" || r === "sessions" || r === "session"))
          return;
        listener(ctx?.sessionIds?.length ? ctx.sessionIds : everything().map((e) => e.id));
      });
    },

    policy: {
      startedBy: async (sessionId) =>
        everything().filter(
          (e) =>
            e.status !== "archived" &&
            e.startedBy.kind === "session" &&
            e.startedBy.sessionId === sessionId
        ),
      lineage: async (sessionId) => {
        const all = new Map(everything().map((e) => [e.id, e]));
        const chain: Origin[] = [];
        for (let at = all.get(sessionId); at && chain.length < 10; ) {
          chain.push(at.startedBy);
          at = at.startedBy.kind === "session" ? all.get(at.startedBy.sessionId) : undefined;
        }
        return chain;
      },
      inWorkspace: async (workspaceId) =>
        everything().filter((e) => e.workspace.id === workspaceId && e.status !== "archived"),
    },
  };
  return host;
}
