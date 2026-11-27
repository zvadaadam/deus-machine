// A coordinator chat hears when a workspace it started finishes, fails, stops or asks.
// Deus holds the news per coordinator chat, one entry per worker (a newer state
// replaces the older), and delivers it as one message when that chat is free: at
// once when it is idle, else at a release. A call that returns having shown the
// held state (wait, start, send, read) has delivered it. A refused delivery keeps
// its news for the next release; a hidden or archived coordinator's is dropped.
// Nothing is persisted.
import type { HostToolSource } from "@zvada/agent-server/core";
import {
  quote,
  quoted,
  refOf,
  type Entry,
  type SessionCaller,
  type ViewMessage,
  type ViewTurn,
} from "@zvada/agent-server/operator";
import type { Origin } from "@zvada/agent-server/protocol";
import { readPermissionMode } from "@shared/protocol";
import { uuidv7 } from "@shared/lib/uuid";
import { getSessionRaw } from "../../db";
import { getDatabase } from "../../lib/database";
import { holdingTurn, type Released, type TurnWatch } from "../agent/chat-turn";
import { enqueueMessage, limitHoldOf } from "../agent/queue";
import { continuedPermissionMode, continuedSettings } from "../agent/turn-settings";
import { onInvalidate } from "../query-engine";
import { limitNote, readsDuring, type Shown } from "../assistants/host";
import { operatorHost } from "../assistants/operator";
import { coordinatorState } from "./coordinator";

type News = { turnId: string; asked: boolean; requestId?: string } & Omit<Released, "ended">;
/** By coordinator chat, then by worker chat. */
const held = new Map<string, Map<string, News>>();
const scheduled = new Set<string>();
const flushing = new Set<string>();
const again = new Set<string>();
const WORDS_LIMIT = 800;

const open = (coordinator: string) => coordinatorState(coordinator) === "ready";

/** The coordinator chat that started this one, if any. */
function starterOf(worker: string): string | undefined {
  const text = getSessionRaw(getDatabase(), worker)?.started_by;
  if (!text) return undefined;
  const origin = JSON.parse(text) as Origin;
  return origin.kind === "session" && open(origin.sessionId) ? origin.sessionId : undefined;
}

function hold(worker: string, entry: News, stoppedBy?: Origin) {
  const coordinator = starterOf(worker);
  if (!coordinator) return;
  const news = held.get(coordinator) ?? new Map<string, News>();
  // Keep arrival order: a newer state moves to the end.
  news.delete(worker);
  // What the coordinator stopped is not news to it.
  if (!(stoppedBy?.kind === "session" && stoppedBy.sessionId === coordinator))
    news.set(worker, entry);
  if (news.size) {
    held.set(coordinator, news);
    watchClosing();
  } else held.delete(coordinator);
  return coordinator;
}

let unwatch: (() => void) | undefined;
/** Hiding or archiving a coordinator drops its news, so a restore never revives it. */
function watchClosing() {
  // Archive, hide and delete publish a changed list; a turn's scoped updates cannot close a chat.
  unwatch ??= onInvalidate((resources, ctx) => {
    if (ctx?.sessionIds?.length) return;
    if (!resources.includes("workspaces") && !resources.includes("sessions")) return;
    for (const coordinator of [...held.keys()]) if (!open(coordinator)) held.delete(coordinator);
    if (!held.size) {
      unwatch?.();
      unwatch = undefined;
    }
  });
}

export const turnWatch: TurnWatch = {
  released(sessionId, turnId, { ended, ...facts }) {
    if (ended) {
      // A failure keeps its reason: the chat's stored error, read now, when the end carried none.
      const stored = facts.failed && !facts.error && getSessionRaw(getDatabase(), sessionId);
      const error = facts.error ?? (stored ? (stored.error_message ?? undefined) : undefined);
      hold(sessionId, { turnId, asked: false, ...facts, ...(error && { error }) }, facts.stoppedBy);
    }
    // Any release is when held news goes, a refused delivery's included.
    for (const coordinator of held.keys()) schedule(coordinator);
  },
  asked(sessionId, turnId, requestId) {
    const coordinator = hold(sessionId, { turnId, asked: true, requestId });
    if (coordinator) schedule(coordinator);
  },
};

function schedule(coordinator: string) {
  if (scheduled.has(coordinator)) return;
  scheduled.add(coordinator);
  // After the event that released the turn: the queue settles that end, and decides a limit's hold, first.
  setImmediate(() => {
    scheduled.delete(coordinator);
    // One flush at a time: a release during one only runs it again after, when its message holds the chat.
    if (flushing.has(coordinator)) return void again.add(coordinator);
    flushing.add(coordinator);
    flush(coordinator)
      .catch((error) => console.warn("[CoordinatorWake] Kept for the next release:", error))
      .finally(() => {
        flushing.delete(coordinator);
        if (again.delete(coordinator)) schedule(coordinator);
      });
  });
}

async function flush(coordinator: string) {
  const news = held.get(coordinator);
  if (!news) return;
  if (!open(coordinator)) return void held.delete(coordinator);
  if (holdingTurn(coordinator)) return;
  const turnId = uuidv7();
  const permissionMode = continuedPermissionMode(coordinator);
  const settings = continuedSettings(coordinator);
  // The read is the coordinator chat's own, made for the turn it is about to take.
  const caller: SessionCaller = {
    kind: "session",
    sessionId: coordinator,
    turnId,
    harness: settings.agentHarness,
    // These reads only read: with no recorded mode, the least that can.
    permissionMode: readPermissionMode(permissionMode) ?? "plan",
  };
  const carried = [...news];
  const lines = await describe(caller, carried);
  const done = () => {
    for (const [worker, entry] of carried) if (news.get(worker) === entry) news.delete(worker);
    if (!news.size && held.get(coordinator) === news) held.delete(coordinator);
  };
  if (!lines.length) return done();
  const first = lines[0]!;
  const named = lines.find((line) => line.ref)?.ref;
  const content = [
    "Deus: news about workspaces you started. Deus wrote this, not the workspace.",
    ...lines.map((line) => line.text),
    ...(!named
      ? []
      : lines.length === 1
        ? [`read_session ${named} for the rest.`]
        : [`read_session any of them for the rest, e.g. read_session ${named}.`]),
  ].join("\n");
  // An agent's message: it joins a standing hold, and counts against the agents' five.
  await enqueueMessage(
    { sessionId: coordinator, turnId, content, ...settings, permissionMode },
    { kind: "session", sessionId: first.worker }
  );
  done();
}

/** Each worker's line, read through the session tools' own reader as the coordinator. */
async function describe(caller: SessionCaller, carried: [string, News][]) {
  const host = operatorHost();
  const all = await host.list(caller, { includeArchived: true });
  const refs = (id: string) => {
    const entry = all.find((each) => each.id === id);
    return entry ? quoted(refOf(entry, all)) : undefined;
  };
  const lines: { worker: string; ref?: string; text: string }[] = [];
  for (const [worker, news] of carried) {
    const { turnId, asked } = news;
    const entry = all.find((each) => each.id === worker);
    // An end is always news, even of a chat removed since; a question that cannot be answered is not.
    if (!entry) {
      if (!asked) {
        let text = `A workspace you started (its project was removed) ${factsState(news, refs)}.`;
        if (news.error) text += `\n  Error:\n${quote(clip(news.error))}`;
        lines.push({ worker, text });
      }
      continue;
    }
    if (asked && entry.status === "archived") continue;
    const ref = refs(worker)!;
    const view = await host.view(caller, worker, { last: 20 });
    const turn = view.turns.find((each) => each.turnId === turnId);
    let state: string | undefined;
    let error: string | undefined;
    if (asked) {
      const waiting =
        view.running === turnId
          ? view.waiting.find((each) => each.request.requestId === news.requestId)
          : undefined;
      if (waiting?.kind === "question") state = "is waiting on a question";
      else if (waiting?.kind === "plan") state = "is waiting for plan approval";
    } else {
      const ended = await endOf(caller, entry, turn, news, refs);
      state = ended.state;
      error = ended.error;
    }
    if (!state) continue;
    const after = turn && startedBy(turn, caller.sessionId, refs);
    let text = `${ref} ${state}${after ? ` (in a turn started by a message from ${after})` : ""}.`;
    if (error) text += `\n  Error:\n${quote(clip(error))}`;
    const words = !asked && turn && closingWords(turn.messages);
    if (words) text += `\n  Closing words:\n${quote(clip(words))}`;
    lines.push({ worker, ref, text });
  }
  return lines;
}

async function endOf(
  caller: SessionCaller,
  entry: Entry,
  turn: ViewTurn | undefined,
  news: News,
  refs: Refs
) {
  const { turnId, stoppedBy, limit, error } = news;
  // The limit as the end reported it; continuation only while the queue still holds for that turn.
  if (limit)
    return {
      state: limitNote(limitHoldOf(entry.id, turnId) ?? { resetsAt: limit.resetsAt }),
      error: error ?? turn?.error,
    };
  const fact = turn ? undefined : await operatorHost().turn(caller, entry.id, turnId);
  const outcome = turn?.outcome ?? (fact?.state === "ended" ? fact.outcome : undefined);
  const by =
    turn?.cancelledBy ?? (fact?.state === "ended" ? fact.cancelledBy : undefined) ?? stoppedBy;
  // A recovery's failure stays with the stop that its cancel recorded.
  if (outcome === "cancelled")
    return { state: `was stopped${by ? ` by ${sender(by, refs)}` : ""}`, error };
  // The release's own failure (a refusal, a lost turn, an incomplete transcript) outranks a done.
  if (error) return { state: "failed", error };
  if (outcome === "done") return { state: "finished" };
  if (outcome === "failed") return { state: "failed", error: turn?.error };
  // No record of how it ended (a Stop before it ran, a snapshot's end): say what is known, never nothing.
  return { state: factsState(news, refs), error };
}

/** What the release itself said, for a turn with no record or a chat that is gone. */
function factsState({ limit, stoppedBy, failed, error, finished }: News, refs: Refs) {
  if (limit) return limitNote({ resetsAt: limit.resetsAt });
  if (stoppedBy) return `was stopped by ${sender(stoppedBy, refs)}`;
  if (failed || error) return "failed";
  return finished ? "finished" : "ended its turn";
}

type Refs = (id: string) => string | undefined;

function sender(origin: ViewMessage["origin"], refs: Refs) {
  if (!origin || origin.kind === "person") return "the person";
  if (origin.kind === "assistant") return `the assistant ${quoted(String(origin.name))}`;
  if (origin.kind === "session") return refs(String(origin.sessionId)) ?? "a chat that is gone";
  return "another sender";
}

/** Who sent the message that started the turn, when not this coordinator. */
function startedBy(turn: ViewTurn, coordinator: string, refs: Refs) {
  const message = turn.messages.find((each) => each.role === "user");
  if (!message) return undefined;
  const { origin } = message;
  return origin?.kind === "session" && origin.sessionId === coordinator
    ? undefined
    : sender(origin, refs);
}

/**
 * The turn's last top-level reply since its last user message: the words a wait
 * returns as "agent said". A copy of the package's private `lastReply`
 * (`@zvada/agent-server/src/operator/render.ts`), over the same reader's page.
 */
function closingWords(messages: readonly ViewMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") break;
    if (message.nested) continue;
    const text = message.parts
      .flatMap((part) => (part.type === "text" && "text" in part && part.text ? [part.text] : []))
      .join("\n\n");
    if (text.trim()) return text.trim();
  }
}

const clip = (text: string) =>
  text.length > WORDS_LIMIT ? text.slice(0, WORDS_LIMIT - 1) + "…" : text;

// read_session is not among them: its page need not show the end, and an extra wake costs little.
const SEEING = new Set(["wait_for_sessions", "start_session", "send_message"]);

/** Whether a read showed this news: the turn ended and nothing newer runs, or the turn still waits. */
const showed = ({ turnId, asked, requestId }: News, read: Shown) =>
  asked
    ? read.running === turnId && !!requestId && read.waiting.includes(requestId)
    : !read.running && read.ended === turnId;

/** A coordinator's tools: a call that returns having shown a worker's held state has delivered it. */
export function withSeenNews(source: HostToolSource): HostToolSource {
  return {
    ...source,
    async call(name, args, caller, signal) {
      if (!SEEING.has(name)) return source.call(name, args, caller, signal);
      const { result, read } = await readsDuring(signal, () =>
        source.call(name, args, caller, signal)
      );
      const news = held.get(caller.sessionId);
      if (!news || result.isError || signal.aborted) return result;
      // Only the call's last read of a worker is what its answer shows.
      for (const [worker, reads] of read) {
        const entry = news.get(worker);
        const last = reads.at(-1);
        if (entry && last && showed(entry, last)) news.delete(worker);
      }
      if (!news.size) held.delete(caller.sessionId);
      return result;
    },
  };
}

/** Tests only. */
export function _heldNews(coordinator: string) {
  return [...(held.get(coordinator)?.keys() ?? [])];
}
export function _resetWake() {
  held.clear();
  unwatch?.();
  unwatch = undefined;
  scheduled.clear();
  flushing.clear();
  again.clear();
}
