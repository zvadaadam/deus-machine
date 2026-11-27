// A coordinator chat hears when a workspace it started finishes, fails, stops or asks.
// Deus holds the news per coordinator chat, one entry per worker (a newer state
// replaces the older), and delivers it as one message when that chat is free: at
// once when it is idle, else at a release. A call that returns having read the
// worker after its news was held (wait, start, send, read) has delivered it.
// A refused delivery keeps its news for the next release. Nothing is persisted.
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
import { holdingTurn, type TurnWatch } from "../agent/chat-turn";
import { enqueueMessage, queuedMessages } from "../agent/queue";
import { continuedPermissionMode, continuedSettings } from "../agent/turn-settings";
import { limitNote, readsDuring } from "../assistants/host";
import { operatorHost } from "../assistants/operator";
import { coordinatorState } from "./tools";

type News = { turnId: string; asked: boolean; at: number };
/** By coordinator chat, then by worker chat. */
const held = new Map<string, Map<string, News>>();
const scheduled = new Set<string>();
const WORDS_LIMIT = 800;

const open = (coordinator: string) => coordinatorState(coordinator) === "ready";

/** The coordinator chat that started this one, if any. */
function starterOf(worker: string): string | undefined {
  const text = getSessionRaw(getDatabase(), worker)?.started_by;
  if (!text) return undefined;
  const origin = JSON.parse(text) as Origin;
  return origin.kind === "session" && open(origin.sessionId) ? origin.sessionId : undefined;
}

function hold(worker: string, turnId: string, asked: boolean, by?: Origin) {
  const coordinator = starterOf(worker);
  if (!coordinator) return;
  const news = held.get(coordinator) ?? new Map<string, News>();
  // Keep arrival order: a newer state moves to the end.
  news.delete(worker);
  // What the coordinator stopped is not news to it.
  if (!(by?.kind === "session" && by.sessionId === coordinator))
    news.set(worker, { turnId, asked, at: performance.now() });
  if (news.size) held.set(coordinator, news);
  else held.delete(coordinator);
  return coordinator;
}

export const turnWatch: TurnWatch = {
  released(sessionId, turnId, ended, by) {
    if (ended) hold(sessionId, turnId, false, by);
    // Any release is when held news goes, a refused delivery's included.
    for (const coordinator of held.keys()) schedule(coordinator);
  },
  asked(sessionId, turnId) {
    const coordinator = hold(sessionId, turnId, true);
    if (coordinator) schedule(coordinator);
  },
};

function schedule(coordinator: string) {
  if (scheduled.has(coordinator)) return;
  scheduled.add(coordinator);
  // After the event that released the turn: the queue settles that end, and decides a limit's hold, first.
  setImmediate(() => {
    scheduled.delete(coordinator);
    flush(coordinator).catch((error) =>
      console.warn("[CoordinatorWake] Kept for the next release:", error)
    );
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
    permissionMode: readPermissionMode(permissionMode) ?? "bypass_permissions",
  };
  const carried = [...news];
  const lines = await describe(caller, carried);
  const done = () => {
    for (const [worker, entry] of carried) if (news.get(worker) === entry) news.delete(worker);
    if (!news.size && held.get(coordinator) === news) held.delete(coordinator);
  };
  if (!lines.length) return done();
  const first = lines[0]!;
  const content = [
    "Deus: news about workspaces you started. Deus wrote this, not the workspace.",
    ...lines.map((line) => line.text),
    lines.length === 1
      ? `read_session ${first.ref} for the rest.`
      : `read_session any of them for the rest, e.g. read_session ${first.ref}.`,
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
  const lines: { worker: string; ref: string; text: string }[] = [];
  for (const [worker, { turnId, asked }] of carried) {
    const entry = all.find((each) => each.id === worker);
    if (!entry || entry.status === "archived") continue;
    const ref = refs(worker)!;
    const view = await host.view(caller, worker, { last: 20 });
    const turn = view.turns.find((each) => each.turnId === turnId);
    let state: string | undefined;
    let error: string | undefined;
    if (asked) {
      const waiting = view.running === turnId ? view.waiting[0] : undefined;
      if (waiting?.kind === "question") state = "is waiting on a question";
      else if (waiting?.kind === "plan") state = "is waiting for plan approval";
    } else {
      const ended = await endOf(caller, entry, turn, turnId, refs);
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
  id: string,
  refs: Refs
) {
  const fact = turn ? undefined : await operatorHost().turn(caller, entry.id, id);
  const outcome = turn?.outcome ?? (fact?.state === "ended" ? fact.outcome : undefined);
  const by = turn?.cancelledBy ?? (fact?.state === "ended" ? fact.cancelledBy : undefined);
  if (outcome === "done") return { state: "finished" };
  if (outcome === "cancelled")
    return { state: `was stopped${by ? ` by ${sender(by, refs)}` : ""}` };
  // A turn refused before it ran leaves no record; its chat keeps the reason.
  if (outcome !== "failed" && entry.status !== "error") return {};
  const error = turn?.error ?? getSessionRaw(getDatabase(), entry.id)?.error_message ?? undefined;
  const queue = queuedMessages(entry.id);
  if (queue.paused === "limit") return { state: limitNote(queue.limit), error };
  return { state: "failed", error };
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

const SEEING = new Set(["wait_for_sessions", "start_session", "send_message", "read_session"]);

/** A coordinator's tools: a call that returns having read a worker after its news was held has delivered it. */
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
      for (const [worker, at] of read) {
        const entry = news.get(worker);
        if (entry && entry.at < at) news.delete(worker);
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
  scheduled.clear();
}
