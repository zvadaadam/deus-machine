import { echoMessageId, inputToText, steerMessageId } from "@zvada/agent-server/protocol";
import type * as api from "@shared/api/sessions";
import type { OutputOf, ParsedInputOf } from "@shared/api/op";
import { ACTIVE_TURN_STATUSES } from "@shared/enums";
import { uuidv7 } from "@shared/lib/uuid";
import type { SessionRow } from "../../db";
import { getDatabase } from "../../lib/database";
import { ChatBusyError, ConflictError } from "../../lib/errors";
import { invalidate, onInvalidate } from "../query-engine";
import { toEngineInput } from "./run-config";
import type { TurnEnd } from "./event-handler";
import { liveTurnId, provideTurnWatcher, steerTurn } from "./service";
import { differentTurnMessage, knownTurn, requireSameHarness, sendMessage } from "./turns";

type Input = ParsedInputOf<typeof api.sendMessage>;
type Message = Input & { turnId: string };
type LocalChat = Pick<SessionRow, "status" | "agent_harness" | "message_count">;
type Attempt = {
  turnId: string;
  state: "sending" | "busy" | "returned";
  admission?: ReturnType<typeof sendMessage>;
};
type Item = { message: Message; text: string; images: number; attempt?: Attempt };
type Steer = { item: Item; turnId: string; echoed: boolean };

interface Queue {
  sessionId: string;
  items: Item[];
  /** Keyed by the message id the engine will echo. Insertion order is delivery order. */
  steers: Map<string, Steer>;
  paused: api.QueuedMessages["paused"];
}

const MAX_QUEUED_MESSAGES = 20;
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
  if (!q.items.length && !q.steers.size) queues.delete(q.sessionId);
  notify([q.sessionId]);
}

function queueForNewMessage(sessionId: string): Queue {
  const existing = queues.get(sessionId);
  if (existing) {
    const held = existing.items.length + existing.steers.size;
    if (held >= MAX_QUEUED_MESSAGES)
      throw new ConflictError(
        `This chat already has ${MAX_QUEUED_MESSAGES} messages waiting. Remove one, or wait for the agent to take them.`
      );
    return existing;
  }
  const q: Queue = { sessionId, items: [], steers: new Map(), paused: null };
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

function checkQueueHarness(chat: LocalChat, harness: Input["agentHarness"]) {
  // The first turn binds the harness before its user echo increments the message count.
  if (chat.message_count > 0 || ACTIVE_TURN_STATUSES.includes(chat.status))
    requireSameHarness(chat.agent_harness, harness);
}

function itemFor(message: Message): Item {
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
  const row = (
    { message, text, images }: Item,
    state: api.QueuedMessages["items"][number]["state"]
  ) => ({
    id: message.turnId,
    text,
    images,
    state,
  });
  const head = sending(q);
  return {
    paused: q.paused,
    items: [
      ...(head ? [row(head, "sending")] : []),
      ...Array.from(q.steers.values(), ({ item }) => row(item, "steering")),
      ...q.items.filter((item) => item !== head).map((item) => row(item, "waiting")),
    ],
  };
}

function sending(q: Queue) {
  return q.items.find((item) => item.attempt?.state === "sending");
}

function waitingRow(q: Queue | undefined, id: string) {
  return q?.items.find((item) => item.message.turnId === id && item.attempt?.state !== "sending");
}

async function drain(q: Queue): Promise<Item | undefined> {
  if (q.paused || !q.items.length || sending(q)) return;
  const chat = localChat(q.sessionId);
  if (!chat) {
    queues.delete(q.sessionId);
    notify([q.sessionId]);
    return;
  }
  if (ACTIVE_TURN_STATUSES.includes(chat.status)) return;
  const head = q.items[0]!;
  const previous = head.attempt;
  let turnId = head.message.turnId;
  if (previous) turnId = previous.state === "busy" ? previous.turnId : uuidv7();
  const attempt: Attempt = { turnId, state: "sending" };
  // A strict send can report an interruption before it returns its admission promise.
  head.attempt = attempt;
  attempt.admission = sendMessage({ ...head.message, turnId });
  changed(q);
  try {
    await attempt.admission;
    attempt.admission = undefined;
    return head;
  } catch (error) {
    const state = error instanceof ChatBusyError ? "busy" : "returned";
    if (queues.get(q.sessionId) !== q || !recoverAttempt(q, turnId, state)) return;
    changed(q);
    // The competing turn may already have ended while this attempt held the head.
    if (state === "busy") void drain(q);
  }
}

function pendingSteer(q: Queue | undefined, rowId: string) {
  if (!q) return;
  for (const { item } of q.steers.values()) if (item.message.turnId === rowId) return item;
}

function alreadyQueued({ sessionId, turnId, content }: Message) {
  const q = queues.get(sessionId);
  const held = q?.items.find((item) => item.message.turnId === turnId) ?? pendingSteer(q, turnId);
  if (held && held.message.content !== content) throw differentTurnMessage();
  return !!held;
}

export async function sendOrQueue(input: Input) {
  const { sessionId } = input;
  let chat = localChat(sessionId);
  if (!chat) return sendMessage(input);
  const message = { ...input, turnId: input.turnId ?? uuidv7() };
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
  checkQueueHarness(chat, message.agentHarness);
  const q = queueForNewMessage(sessionId);
  q.items.push(itemFor(message));
  changed(q);
  if (!ACTIVE_TURN_STATUSES.includes(chat.status)) void drain(q);
  return queued;
}

type SteerResult = OutputOf<typeof api.steerMessage>;

async function steer(q: Queue, item: Item, chat: LocalChat): Promise<SteerResult["outcome"]> {
  if (chat.status === "needs_response" || chat.status === "needs_plan_response") {
    if (!q.items.includes(item)) {
      q.items.push(item);
      changed(q);
    }
    return "queued";
  }
  const index = q.items.indexOf(item);
  if (index >= 0) q.items.splice(index, 1);
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
  q.items.unshift(item);
  changed(q);
  return (await drain(q)) === item ? "sent" : "queued";
}

export async function steerMessage(
  input: ParsedInputOf<typeof api.steerMessage>
): Promise<SteerResult> {
  const { sessionId } = input;
  const chat = localChat(sessionId);
  if (!chat) {
    await sendMessage(input);
    return { outcome: "sent" };
  }
  checkQueueHarness(chat, input.agentHarness);
  const q = queueForNewMessage(sessionId);
  const item = itemFor({ ...input, turnId: uuidv7() });
  return { outcome: await steer(q, item, chat) };
}

export async function steerQueuedMessage(
  sessionId: string,
  id: string
): Promise<OutputOf<typeof api.steerQueuedMessage>> {
  const q = queues.get(sessionId);
  if (pendingSteer(q, id)) return { outcome: "steered" };
  const item = waitingRow(q, id);
  const chat = item && localChat(sessionId);
  if (!q || !item || !chat) return { outcome: "gone" };
  const outcome = await steer(q, item, chat);
  return { outcome: outcome === "sent" ? "gone" : outcome };
}

export function queuedMessage(sessionId: string, id: string) {
  const item = waitingRow(queues.get(sessionId), id);
  return { content: item?.message.content ?? null };
}

export function removeQueuedMessage(sessionId: string, id: string) {
  const q = queues.get(sessionId);
  const item = waitingRow(q, id);
  if (!q || !item) return { removed: false };
  q.items.splice(q.items.indexOf(item), 1);
  changed(q);
  return { removed: true };
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

function userEcho(sessionId: string, turnId: string, messageId: string) {
  const q = queues.get(sessionId);
  if (!q) return;
  if (messageId === echoMessageId(turnId)) {
    const index = q.items.findIndex((item) => item.attempt?.turnId === turnId);
    if (index < 0) return;
    q.items.splice(index, 1);
  } else {
    const steer = q.steers.get(messageId);
    if (steer?.turnId !== turnId) return;
    steer.echoed = true;
    q.steers.delete(messageId);
  }
  changed(q);
}

function recoverAttempt(q: Queue, turnId: string, state: "busy" | "returned" = "returned") {
  const head = sending(q);
  if (!head || head.attempt?.turnId !== turnId) return false;
  head.attempt = { turnId, state };
  q.items.splice(q.items.indexOf(head), 1);
  q.items.unshift(head);
  if (state === "returned") q.paused ??= "failed";
  return true;
}

function recoverSteers(q: Queue, turnId: string) {
  const unread: Item[] = [];
  for (const [id, steer] of q.steers) {
    if (steer.turnId !== turnId) continue;
    q.steers.delete(id);
    unread.push(steer.item);
  }
  if (unread.length) q.items = unread.concat(q.items);
  return unread.length > 0;
}

function stopQueue(sessionId: string) {
  const q = queues.get(sessionId);
  if (!q) return;
  q.paused = "stopped";
  changed(q);
  return sending(q)?.attempt?.admission;
}

/** A live turn can still echo. Once it is gone, its unread steers can be resumed as turns. */
function interruptQueue(sessionId: string, turnId: string | undefined, gone: boolean) {
  const q = queues.get(sessionId);
  if (!q) return;
  if (gone && turnId !== undefined) {
    recoverSteers(q, turnId);
    recoverAttempt(q, turnId);
  }
  q.paused ??= "failed";
  changed(q);
}

function turnEnded({ event: ended, status }: TurnEnd) {
  const q = queues.get(ended.sessionId);
  if (!q) return;
  // Includes the engine's undeliveredSteers and calls still awaiting a verdict.
  const recovered = recoverSteers(q, ended.turnId);
  const wasSending = recoverAttempt(q, ended.turnId);
  // A replayed end can return its own steers but cannot stop or advance its successor.
  if (!status) {
    if (recovered || wasSending) changed(q);
    return;
  }
  if (ended.stopReason === "cancelled") q.paused = "stopped";
  else if (status === "error") q.paused ??= "failed";
  changed(q);
  void drain(q);
}

provideTurnWatcher({ turnEnded, userEcho, stopAsked: stopQueue, interrupted: interruptQueue });
