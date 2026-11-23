import { inputToText, steerMessageId, type TurnEndedEvent } from "@zvada/agent-server/protocol";
import type * as api from "@shared/api/sessions";
import type { OutputOf, ParsedInputOf } from "@shared/api/op";
import { ACTIVE_TURN_STATUSES } from "@shared/enums";
import { uuidv7 } from "@shared/lib/uuid";
import type { SessionRow } from "../../db";
import { getDatabase } from "../../lib/database";
import { ChatBusyError } from "../../lib/errors";
import { invalidate, onInvalidate } from "../query-engine";
import { toEngineInput } from "./run-config";
import { liveTurnId, steerTurn } from "./service";
import { differentTurnMessage, knownTurn, requireSameHarness, sendMessage } from "./turns";

type Input = ParsedInputOf<typeof api.sendMessage>;
type Message = Input & { turnId: string };
type LocalChat = Pick<SessionRow, "status" | "agent_harness" | "message_count">;
type Item = { message: Message; text: string; images: number };
type Steer = { item: Item; turnId: string; echoed: boolean };

interface Queue {
  sessionId: string;
  waiting: Item[];
  /** Keyed by the message id the engine will echo. Insertion order is delivery order. */
  steers: Map<string, Steer>;
  paused: api.QueuedMessages["paused"];
  starting?: { head: Item; admission: ReturnType<typeof sendMessage> };
}

const queues = new Map<string, Queue>();
let unwatch: (() => void) | undefined;

const OPEN_LOCAL = `FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
  WHERE w.kind = 'worktree' AND w.state != 'archived' AND s.is_hidden = 0`;

function localChat(id: string) {
  const sql = `SELECT s.status, s.agent_harness, s.message_count ${OPEN_LOCAL} AND s.id = ?`;
  return getDatabase().prepare<[string], LocalChat>(sql).get(id);
}

function notify(sessionIds: string[]) {
  if (!queues.size) {
    unwatch?.();
    unwatch = undefined;
  }
  invalidate(["queuedMessages"], { sessionIds });
}

function changed(q: Queue) {
  if (!q.waiting.length && !q.steers.size && !q.starting) queues.delete(q.sessionId);
  notify([q.sessionId]);
}

function queueFor(sessionId: string): Queue {
  const existing = queues.get(sessionId);
  if (existing) return existing;
  const q: Queue = { sessionId, waiting: [], steers: new Map(), paused: null };
  queues.set(sessionId, q);
  // Archive, hide and delete publish a changed list. A turn's scoped updates
  // cannot remove a chat. Check all held queues in one read on list changes.
  unwatch ??= onInvalidate((resources, ctx) => {
    if (
      ctx?.sessionIds?.length ||
      !(resources.includes("workspaces") || resources.includes("sessions"))
    )
      return;
    const gone = getDatabase()
      .prepare<[string], { id: string }>(
        `SELECT value AS id FROM json_each(?) WHERE NOT EXISTS (SELECT 1 ${OPEN_LOCAL} AND s.id = value)`
      )
      .all(JSON.stringify([...queues.keys()]));
    if (!gone.length) return;
    for (const { id } of gone) queues.delete(id);
    notify(gone.map(({ id }) => id));
  });
  return q;
}

function withId(input: Input): Message {
  return { ...input, turnId: input.turnId ?? uuidv7() };
}

function itemFor(message: Message, chat: LocalChat): Item {
  // The first turn binds the harness before its user echo increments the message count.
  if (chat.message_count > 0 || ACTIVE_TURN_STATUSES.includes(chat.status))
    requireSameHarness(chat.agent_harness, message.agentHarness);
  const input = toEngineInput(message.content);
  return {
    message,
    text: inputToText(input),
    images: typeof input === "string" ? 0 : input.filter((p) => p.type === "image").length,
  };
}

export function queuedMessages(sessionId: string): api.QueuedMessages {
  const q = queues.get(sessionId);
  if (!q) return { paused: null, items: [] };
  const row = ({ message, text, images }: Item, steering: boolean) => ({
    id: message.turnId,
    text,
    images,
    steering,
  });
  return {
    paused: q.paused,
    items: [
      ...Array.from(q.steers.values(), ({ item }) => row(item, true)),
      ...q.waiting.map((item) => row(item, false)),
    ],
  };
}

/** Take just one head. Its end, which can arrive before its admission reply, takes the next. */
async function drain(q: Queue): Promise<Item | undefined> {
  if (q.paused || q.starting || !q.waiting.length) return;
  const chat = localChat(q.sessionId);
  if (!chat) {
    queues.delete(q.sessionId);
    notify([q.sessionId]);
    return;
  }
  if (ACTIVE_TURN_STATUSES.includes(chat.status)) return;
  const head = q.waiting.shift()!;
  const starting = { head, admission: sendMessage(head.message) };
  q.starting = starting;
  changed(q);
  try {
    await starting.admission;
  } catch (error) {
    if (queues.get(q.sessionId) !== q || q.starting !== starting) return;
    q.starting = undefined;
    q.waiting.unshift(head);
    const busy = error instanceof ChatBusyError;
    if (!busy) q.paused ??= "failed";
    changed(q);
    // If the competing turn already ended, its drain saw our pending start.
    if (busy) void drain(q);
    return;
  }
  if (queues.get(q.sessionId) === q && q.starting === starting) {
    q.starting = undefined;
    changed(q);
  }
  return head;
}

function pendingSteer(q: Queue | undefined, rowId: string) {
  if (!q) return;
  for (const { item } of q.steers.values()) if (item.message.turnId === rowId) return item;
}

function alreadyQueued({ sessionId, turnId, content }: Message) {
  const q = queues.get(sessionId);
  const head = q?.starting?.head;
  const held =
    head?.message.turnId === turnId
      ? head
      : (q?.waiting.find((item) => item.message.turnId === turnId) ?? pendingSteer(q, turnId));
  if (held && held.message.content !== content) throw differentTurnMessage();
  return !!held;
}

export async function sendOrQueue(input: Input) {
  const { sessionId } = input;
  let chat = localChat(sessionId);
  if (!chat) return sendMessage(input);
  const message = withId(input);
  const queued = { turnId: message.turnId, queued: true as const };
  if (alreadyQueued(message)) return queued;
  if (!ACTIVE_TURN_STATUSES.includes(chat.status) || knownTurn(sessionId, message.turnId)) {
    try {
      return await sendMessage(message);
    } catch (error) {
      if (!(error instanceof ChatBusyError)) throw error;
      chat = localChat(sessionId);
      if (!chat) throw error;
      if (alreadyQueued(message)) return queued;
    }
  }
  const item = itemFor(message, chat);
  const q = queueFor(sessionId);
  q.waiting.push(item);
  changed(q);
  if (!ACTIVE_TURN_STATUSES.includes(chat.status)) void drain(q);
  return queued;
}

type SteerResult = OutputOf<typeof api.steerMessage>;

async function steer(q: Queue, item: Item, chat: LocalChat): Promise<SteerResult["outcome"]> {
  if (chat.status === "needs_response" || chat.status === "needs_plan_response") {
    if (!q.waiting.includes(item)) {
      q.waiting.push(item);
      changed(q);
    }
    return "queued";
  }
  const index = q.waiting.indexOf(item);
  if (index >= 0) q.waiting.splice(index, 1);
  const turnId = chat.status === "working" && liveTurnId(q.sessionId);
  if (turnId) {
    const pending: Steer = { turnId, item, echoed: false };
    const steerId = uuidv7();
    const echoId = steerMessageId(steerId);
    q.steers.set(echoId, pending);
    changed(q);
    const result = await steerTurn(chat.agent_harness, {
      sessionId: q.sessionId,
      turnId,
      steerId,
      input: toEngineInput(item.message.content),
    }).catch(() => undefined);
    // The echo or turn end can beat the RPC, even an RPC reporting acceptance.
    if (q.steers.get(echoId) !== pending || queues.get(q.sessionId) !== q)
      return pending.echoed ? "steered" : "queued";
    // A timed-out call may still echo. Only a definite refusal frees the message.
    if (result?.outcome !== "no_active_turn" && result?.outcome !== "unsupported") return "steered";
    q.steers.delete(echoId);
  }
  q.waiting.unshift(item);
  changed(q);
  return (await drain(q)) === item ? "sent" : "queued";
}

export async function steerMessage(input: Input): Promise<SteerResult> {
  const { sessionId } = input;
  const chat = localChat(sessionId);
  if (!chat) {
    await sendMessage(input);
    return { outcome: "sent" };
  }
  const item = itemFor(withId(input), chat);
  return { outcome: await steer(queueFor(sessionId), item, chat) };
}

export async function steerQueuedMessage(
  sessionId: string,
  id: string
): Promise<OutputOf<typeof api.steerQueuedMessage>> {
  const q = queues.get(sessionId);
  if (pendingSteer(q, id)) return { outcome: "steered" };
  const item = q?.waiting.find((i) => i.message.turnId === id);
  const chat = item && localChat(sessionId);
  if (!q || !item || !chat) return { outcome: "gone" };
  const outcome = await steer(q, item, chat);
  return { outcome: outcome === "sent" ? "gone" : outcome };
}

export function removeQueuedMessage(sessionId: string, id: string) {
  const q = queues.get(sessionId);
  const index = q?.waiting.findIndex((item) => item.message.turnId === id) ?? -1;
  if (!q || index === -1) return { content: null };
  const [item] = q.waiting.splice(index, 1);
  changed(q);
  return { content: item!.message.content };
}

export async function resumeQueuedMessages(sessionId: string) {
  const q = queues.get(sessionId);
  if (q?.paused) {
    q.paused = null;
    changed(q);
    await drain(q);
  }
  return {};
}

export function steerEcho(sessionId: string, turnId: string, messageId: string) {
  const q = queues.get(sessionId);
  const steer = q?.steers.get(messageId);
  if (!q || steer?.turnId !== turnId) return;
  steer.echoed = true;
  q.steers.delete(messageId);
  changed(q);
}

function recoverSteers(q: Queue, turnId?: string) {
  const unread: Item[] = [];
  for (const [id, steer] of q.steers) {
    if (turnId && steer.turnId !== turnId) continue;
    q.steers.delete(id);
    unread.push(steer.item);
  }
  if (unread.length) q.waiting = unread.concat(q.waiting);
  return unread.length > 0;
}

export function stopQueue(sessionId: string) {
  const q = queues.get(sessionId);
  if (!q) return;
  q.paused = "stopped";
  changed(q);
  return q.starting?.admission;
}

/** A live turn can still echo. Once it is gone, its unread steers can be resumed as turns. */
export function interruptQueue(sessionId: string, activeTurnId?: string) {
  const q = queues.get(sessionId);
  if (!q) return;
  if (!activeTurnId) recoverSteers(q);
  q.paused ??= "failed";
  changed(q);
}

export function turnEnded(ended: TurnEndedEvent, status?: "idle" | "error") {
  const q = queues.get(ended.sessionId);
  if (!q) return;
  // Includes the engine's undeliveredSteers and calls still awaiting a verdict.
  const recovered = recoverSteers(q, ended.turnId);
  // A replayed end can return its own steers but cannot stop or advance its successor.
  if (!status) {
    if (recovered) changed(q);
    return;
  }
  if (q.starting?.head.message.turnId === ended.turnId) q.starting = undefined;
  if (ended.stopReason === "cancelled") q.paused = "stopped";
  else if (status === "error") q.paused ??= "failed";
  changed(q);
  void drain(q);
}
