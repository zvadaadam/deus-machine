import { agentOrigin, inputToText, type Origin } from "@zvada/agent-server/protocol";
import type * as api from "@shared/api/sessions";
import type { OutputOf, ParsedInputOf } from "@shared/api/op";
import { knownHarness } from "@shared/harnesses";
import { uuidv7 } from "@shared/lib/uuid";
import { encodeOrigin, getTurnsForMessages, sameOrigin, type SessionRow } from "../../db";
import { getDatabase } from "../../lib/database";
import {
  ChatBusyError,
  ConflictError,
  DifferentTurnMessageError,
  NotFoundError,
} from "../../lib/errors";
import { invalidate, onInvalidate } from "../query-engine";
import { getSetting } from "../settings.service";
import { toEngineInput } from "./run-config";
import type { TurnEnd } from "./event-handler";
import { provideTurnWatcher, steerTurn, type InterruptionCause, type StopAsked } from "./service";
import { holdingTurn, lastTurn } from "./chat-turn";
import { continuedSettings } from "./turn-settings";
import {
  previousSend,
  requireSameHarness,
  retryReadSteer,
  sendMessage,
  withdrawSteerRetry,
} from "./turns";

type Input = ParsedInputOf<typeof api.sendMessage>;
type Message = Input & { turnId: string };
type LocalChat = Pick<SessionRow, "status" | "agent_harness" | "message_count" | "error_category">;
type Attempt = { turnId: string; state: "sending" | "busy" | "returned" };
type SteerReceipt = "acknowledged" | "read" | "queued" | "refused" | "unconfirmed";
type Placement = "front" | "in_place";
type Steer = {
  id: string;
  turnId: string;
  unread: Placement;
  answer: ReturnType<typeof Promise.withResolvers<SteerReceipt>>;
  receipt?: "read" | "queued";
};
type Item = {
  message: Message;
  delivery: "queued" | "standalone";
  origin?: Origin;
  text: string;
  images: number;
  attempt?: Attempt;
  /** The turn named by a fresh steer, including one kept without reaching the wire. */
  target?: string;
  steer?: Steer;
  recoveredSteer?: Pick<Steer, "turnId" | "id">;
};

type AffectedTurn = { turnId?: string; outstanding: boolean };
type Pause =
  | { reason: "resumed"; turnId: string; scope: "failure" | "turn" }
  | ({ reason: "stopped"; by?: Origin } & AffectedTurn)
  | ({ reason: "failed" } & AffectedTurn)
  | { reason: "limit"; turnId: string; limit: NonNullable<api.QueuedMessages["limit"]> }
  | null;
interface Queue {
  sessionId: string;
  items: Item[];
  pause: Pause;
}

function hold(q: Queue) {
  return q.pause?.reason === "resumed" ? null : q.pause;
}

type PauseEvent =
  | ({ type: "stop" } & StopAsked)
  | { type: "interrupted"; turnId?: string; gone: boolean; cause: InterruptionCause }
  | ({ type: "end"; turnId: string; cancelled: boolean; missingEcho: boolean } & Pick<
      TurnEnd,
      "held" | "status" | "limit"
    >)
  | { type: "resume"; by?: Origin }
  | { type: "schedule"; on: boolean }
  | { type: "clear_limit" | "empty" };

/**
 * A Stop replaces any limit and holds waiting rows, including on an idle chat. It follows the
 * live turn, or the pending start if none is live. An empty Stop or failure clears when that turn ends,
 * its start is refused (including busy), or Deus gives it up. With no turn, an empty hold clears at once.
 * The person's Stop takes priority. The turn itself credits the first Stop that took effect.
 * A cancellation from a card, harness or replay keeps its turn's stopper or a standing
 * person-only hold. Otherwise it replaces any earlier failure or agent Stop with a person-only hold.
 * A failure or missing start echo holds for anyone. An interruption can replace a limit or
 * another turn's Resume. A standing Stop or failure survives non-cancelled ends, limits included.
 * An unrelated replayed end changes nothing unless it returns a head missing its echo.
 * The person can resume any hold. Agents can resume failures, agent Stops and usage limits
 * after a reported reset. A limit can hold an empty queue. A plain send can still start an idle chat.
 * Resume covers its own turn's end and failure. Its usage limit still applies. A resumed Stop
 * or the person's Resume also covers that turn's cancellation. An agent resuming a live failure
 * waits for it to settle. The person's later Resume takes effect immediately.
 */
function transition(
  q: Queue,
  event: PauseEvent
): "open" | "person_only" | "before_reset" | undefined {
  const prior = q.pause;
  switch (event.type) {
    case "resume": {
      if (!prior) return "open";
      const agent = agentOrigin(event.by);
      if (prior.reason === "resumed") {
        if (agent || prior.scope === "turn") return "open";
        prior.scope = "turn";
        return;
      }
      if (agent) {
        if (prior.reason === "stopped" && !agentOrigin(prior.by)) return "person_only";
        if (prior.reason === "limit") {
          if (prior.limit.resetsAt === undefined) return "person_only";
          if (prior.limit.resetsAt > Date.now()) return "before_reset";
        }
      }
      q.pause =
        prior.reason !== "limit" && prior.outstanding && prior.turnId
          ? {
              reason: "resumed",
              turnId: prior.turnId,
              scope: agent && prior.reason === "failed" ? "failure" : "turn",
            }
          : null;
      return;
    }
    case "empty":
      if ((prior?.reason === "stopped" || prior?.reason === "failed") && !prior.outstanding)
        q.pause = null;
      return;
    case "clear_limit":
      if (prior?.reason === "limit") q.pause = null;
      return;
    case "schedule":
      if (prior?.reason === "limit") prior.limit.continues = event.on;
      return;
  }
  const { turnId } = event;
  const sameTurn = turnId !== undefined && prior?.turnId === turnId;
  if (event.type === "end" && !event.held && !event.missingEcho && !sameTurn) return;
  const outstanding =
    turnId !== undefined &&
    ((event.type === "stop" && event.endedAt === undefined) ||
      (event.type === "interrupted" && !event.gone));
  const cancelled =
    event.type === "end" ? event.cancelled : event.type === "stop" || event.cause === "cancelled";
  const limited = event.type === "end" && event.limit;
  const resumed = sameTurn && prior.reason === "resumed" && (!cancelled || prior.scope === "turn");
  if (event.type !== "stop" && resumed && !limited) {
    if (!outstanding) q.pause = null;
  } else if (cancelled) {
    const by = event.type === "stop" ? event.by : undefined;
    const keep =
      prior?.reason === "stopped" && by?.kind !== "person" && (sameTurn || !agentOrigin(prior.by));
    q.pause = { reason: "stopped", by: keep ? prior.by : by, turnId, outstanding };
  } else if (prior?.reason === "stopped" || (prior?.reason === "failed" && event.type === "end")) {
    if (sameTurn && !outstanding) prior.outstanding = false;
  } else if (limited) {
    const continues =
      limited.resetsAt !== undefined && getSetting("continue_after_usage_limit") === true;
    q.pause = { reason: "limit", turnId: event.turnId, limit: { ...limited, continues } };
  } else if (
    event.type === "interrupted" ||
    (event.type === "end" && (event.status === "error" || event.missingEcho))
  ) {
    q.pause = { reason: "failed", turnId, outstanding };
  } else if (prior?.reason === "resumed") q.pause = null;
}

const MAX_QUEUED_MESSAGES = 20;
const MAX_AGENT_MESSAGES = 5;

export class QueueLimitError extends ConflictError {
  constructor(readonly limit: "agents" | "total") {
    super(
      limit === "agents"
        ? `This chat already has ${MAX_AGENT_MESSAGES} messages from agents waiting. Wait for the chat to take one.`
        : `This chat already has ${MAX_QUEUED_MESSAGES} messages waiting. Remove one, or wait for the agent to take them.`
    );
    this.name = "QueueLimitError";
  }
}

const queues = new Map<string, Queue>();
let unwatch: (() => void) | undefined;
const MINUTE = 60_000;
let clock: NodeJS.Timeout | undefined;

const OPEN_LOCAL = `FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
  WHERE w.kind = 'worktree' AND w.state != 'archived' AND s.is_hidden = 0`;

function localChat(id: string) {
  const sql = `SELECT s.status, s.agent_harness, s.message_count, s.error_category ${OPEN_LOCAL} AND s.id = ?`;
  return getDatabase().prepare<[string], LocalChat>(sql).get(id);
}

function notify(sessionIds: string[]) {
  watchResets();
  if (!queues.size) {
    unwatch?.();
    unwatch = undefined;
  }
  invalidate(["queuedMessages"], { sessionIds });
}

function changed(q: Queue, event?: PauseEvent) {
  const refusal = event && transition(q, event);
  if (refusal) return refusal;
  if (!q.items.length) {
    transition(q, { type: "empty" });
    if (!q.pause) queues.delete(q.sessionId);
  }
  notify([q.sessionId]);
}

function queueFor(sessionId: string): Queue {
  const existing = queues.get(sessionId);
  if (existing) return existing;
  const q: Queue = { sessionId, items: [], pause: null };
  queues.set(sessionId, q);
  // Archive, hide and delete publish a changed list. A turn's scoped updates
  // cannot remove a chat. Check all held queues in one read on list changes.
  unwatch ??= onInvalidate((resources, ctx) => {
    if (!(resources.includes("workspaces") || resources.includes("sessions"))) return;
    if (ctx?.sessionIds?.length) {
      for (const id of ctx.sessionIds) {
        const held = queues.get(id);
        if (
          held?.pause?.reason === "limit" &&
          (holdingTurn(id) || localChat(id)?.error_category !== "usage_limit")
        ) {
          changed(held, { type: "clear_limit" });
        }
      }
      return;
    }
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

function checkQueueHarness(id: string, chat: LocalChat, harness: Input["agentHarness"]) {
  // The first turn binds the harness before its user echo increments the message count.
  if (chat.message_count > 0 || holdingTurn(id)) requireSameHarness(chat.agent_harness, harness);
}

function newQueueItem(
  q: Queue,
  message: Message,
  origin: Origin | undefined,
  delivery: Item["delivery"]
): Item {
  const sender = agentOrigin(origin);
  if (sender && q.items.filter((item) => item.origin).length >= MAX_AGENT_MESSAGES)
    throw new QueueLimitError("agents");
  if (q.items.length >= MAX_QUEUED_MESSAGES) throw new QueueLimitError("total");
  const input = toEngineInput(message.content);
  return {
    message,
    delivery,
    origin: sender,
    text: inputToText(input),
    images: typeof input === "string" ? 0 : input.filter((p) => p.type === "image").length,
  };
}

export function queuedMessages(sessionId: string): api.QueuedMessages {
  const q = queues.get(sessionId);
  if (!q) return { paused: null, items: [] };
  const row = (item: Item) => {
    const { message, text, images, origin } = item;
    return {
      id: message.turnId,
      text,
      images,
      state: stateOf(item),
      ...(origin && { origin }),
    };
  };
  const pause = hold(q);
  return {
    paused: pause?.reason ?? null,
    ...(pause?.reason === "stopped" && pause.by && { stoppedBy: pause.by }),
    ...(pause?.reason === "limit" && { limit: pause.limit }),
    items: q.items.map(row),
  };
}

function stateOf(item: Item): api.QueuedMessages["items"][number]["state"] {
  if (item.attempt?.state === "sending") return "sending";
  return item.steer ? "steering" : "waiting";
}

function waitingRow(q: Queue | undefined, id: string) {
  return q?.items.find((item) => item.message.turnId === id && stateOf(item) === "waiting");
}

async function drain(q: Queue | undefined) {
  if (!q) return;
  const head = q.items[0];
  const canStart = !q.pause || (q.pause.reason === "resumed" && q.pause.scope === "turn");
  if (!canStart || !head || stateOf(head) !== "waiting") return;
  const chat = localChat(q.sessionId);
  if (!chat) {
    queues.delete(q.sessionId);
    notify([q.sessionId]);
    return;
  }
  if (holdingTurn(q.sessionId)) return;
  const last = lastTurn(q.sessionId);
  const previous = head.attempt;
  let turnId = head.message.turnId;
  if (previous) turnId = previous.state === "busy" ? previous.turnId : uuidv7();
  // A strict send can report an interruption before it returns its admission promise.
  head.attempt = { turnId, state: "sending" };
  const admission = sendMessage({ ...head.message, turnId }, head.origin);
  changed(q);
  try {
    await admission;
    return { item: head, turnId };
  } catch (error) {
    if (holdingTurn(q.sessionId)?.turnId === turnId) return;
    const state = error instanceof ChatBusyError ? "busy" : "returned";
    if (queues.get(q.sessionId) !== q || !recoverAttempt(q, turnId, state)) return;
    changed(
      q,
      state === "returned"
        ? { type: "interrupted", turnId, gone: true, cause: "failure" }
        : undefined
    );
    // The competing turn may already have ended while this attempt held the head.
    if (state === "busy" && lastTurn(q.sessionId) !== last) void drain(q);
  }
}

function alreadyQueued({ sessionId, turnId, content }: Message, origin?: Origin) {
  const q = queues.get(sessionId);
  const held = q?.items.find((item) => item.message.turnId === turnId);
  if (
    held &&
    (held.message.content !== content || encodeOrigin(held.origin) !== encodeOrigin(origin))
  )
    throw new DifferentTurnMessageError();
  return held;
}

function positionOf(sessionId: string, turnId: string) {
  return (queues.get(sessionId)?.items.findIndex((row) => row.message.turnId === turnId) ?? -1) + 1;
}

function append(message: Message, origin: Origin | undefined, chat: LocalChat, start = true) {
  checkQueueHarness(message.sessionId, chat, message.agentHarness);
  const q = queueFor(message.sessionId);
  const sender = agentOrigin(origin);
  // Once the matching row has run, retrying a lost answer can queue it again.
  const duplicate =
    sender &&
    q.items.find(
      (item) =>
        stateOf(item) === "waiting" &&
        sameOrigin(item.origin, sender) &&
        item.message.content === message.content
    );
  if (duplicate) return q.items.indexOf(duplicate) + 1;
  q.items.push(newQueueItem(q, message, origin, "queued"));
  const position = q.items.length;
  changed(q);
  if (start) void drain(q);
  return position;
}

/** The operator commits a row at its access check. Only the drain starts it. */
export async function enqueueMessage(message: Message, origin: Origin) {
  const { sessionId, turnId } = message;
  if (alreadyQueued(message, origin)) return { position: positionOf(sessionId, turnId) };
  const previous = previousSend(message, turnId, origin);
  if (previous) return previous.then(() => ({}));
  const chat = localChat(sessionId);
  if (!chat) throw new NotFoundError("That chat is gone.");
  return { position: append(message, origin, chat) };
}

export async function sendOrQueue(input: Input) {
  const { sessionId } = input;
  let chat = localChat(sessionId);
  if (!chat) return sendMessage(input);
  const message = { ...input, turnId: input.turnId ?? uuidv7() };
  const queued = { turnId: message.turnId, queued: true as const };
  if (alreadyQueued(message)) return queued;
  const last = lastTurn(sessionId);
  const admission = holdingTurn(sessionId)
    ? previousSend(message, message.turnId)
    : sendMessage(message);
  if (admission) {
    try {
      return await admission;
    } catch (error) {
      if (!(error instanceof ChatBusyError)) throw error;
      chat = localChat(sessionId);
      if (!chat) throw error;
      if (alreadyQueued(message)) return queued;
    }
  }
  append(message, undefined, chat, !admission || lastTurn(sessionId) !== last);
  return queued;
}

type SteerResult = OutputOf<typeof api.steerMessage>;

function canSteer(q: Queue, chat: LocalChat, turnId: string | undefined): turnId is string {
  // A hold covers waiting rows. A fresh steer can enter a different running turn.
  const pause = q.pause;
  const turn = holdingTurn(q.sessionId);
  return (
    turnId !== undefined &&
    turnId === turn?.turnId &&
    turn.phase !== "preparing" &&
    chat.status === "working" &&
    !(pause?.reason === "stopped" && pause.turnId === turnId)
  );
}

function waitingOnCard(chat: LocalChat, sessionId: string, turnId?: string) {
  if (turnId !== undefined && turnId !== holdingTurn(sessionId)?.turnId) return;
  if (chat.status === "needs_response") return "question";
  if (chat.status === "needs_plan_response") return "plan";
}

/** Keep the sending head and earlier fresh steers ahead of a front-of-queue fallback. */
function putFirst(q: Queue, items: Item[]) {
  const rest = q.items.filter((row) => !items.includes(row));
  const first = rest.findIndex(
    (row) =>
      row.attempt?.state !== "sending" &&
      !(row.delivery === "standalone" && stateOf(row) === "steering")
  );
  rest.splice(first < 0 ? rest.length : first, 0, ...items);
  q.items = rest;
}

/** A receipt belongs to its named turn. The row stays in its slot while the wire answers. */
function steerInto(
  q: Queue,
  item: Item,
  chat: LocalChat,
  turnId: string,
  id: string,
  unread: Placement
) {
  const answer = Promise.withResolvers<SteerReceipt>();
  const steer: Steer = { id, turnId, unread, answer };
  item.steer = steer;
  changed(q);
  void admit().then(answer.resolve, answer.reject);
  return answer.promise;

  async function admit(): Promise<SteerReceipt> {
    const result = await steerTurn(chat.agent_harness, {
      sessionId: q.sessionId,
      turnId,
      steerId: id,
      input: toEngineInput(item.message.content),
      ...(item.origin && { origin: item.origin }),
    }).catch((error: unknown) => {
      if (error instanceof DifferentTurnMessageError && !steer.receipt) {
        delete item.steer;
        if (item.delivery === "standalone") q.items.splice(q.items.indexOf(item), 1);
        changed(q);
        throw error;
      }
    });
    if (steer.receipt) return steer.receipt;
    if (queues.get(q.sessionId) !== q) return "queued";
    if (!result) return "unconfirmed";
    if (result.outcome === "steered") return "acknowledged";
    delete item.steer;
    changed(q);
    return "refused";
  }
}

function freshOutcome(receipt: SteerReceipt): SteerResult {
  if (receipt === "unconfirmed") return { outcome: receipt };
  return { outcome: receipt === "acknowledged" || receipt === "read" ? "steered" : "queued" };
}

export async function steerMessage(
  { turnId, ...input }: ParsedInputOf<typeof api.steerMessage>,
  origin?: Origin,
  steerId?: string
): Promise<SteerResult> {
  const { sessionId } = input;
  const chat = localChat(sessionId);
  const message = { ...input, turnId: steerId ?? uuidv7() };
  if (steerId !== undefined) {
    const held = alreadyQueued(message, origin);
    if (held) {
      if (held.target !== undefined && held.target !== turnId)
        throw new DifferentTurnMessageError();
      const pending = held.steer;
      return freshOutcome(
        pending?.id === steerId ? (pending.receipt ?? (await pending.answer.promise)) : "queued"
      );
    }
    const sent = previousSend(message, steerId, origin);
    if (sent) {
      await sent;
      return { outcome: "queued" };
    }
    const read = retryReadSteer({ ...input, turnId }, steerId, origin);
    if (read) {
      await read;
      return { outcome: "steered" };
    }
    // A removed row leaves no id to match, so a retry can send it again. Once the host answers,
    // an RPC timeout at the caller does not make the package retry.
  }
  if (!chat) {
    await sendMessage(steerId === undefined ? input : message, origin);
    return { outcome: "sent" };
  }
  checkQueueHarness(sessionId, chat, input.agentHarness);
  const q = queueFor(sessionId);
  const item = newQueueItem(q, message, origin, "standalone");
  item.target = turnId;
  if (waitingOnCard(chat, sessionId, turnId)) {
    q.items.push(item);
    changed(q);
    return { outcome: "queued" };
  }
  putFirst(q, [item]);
  if (canSteer(q, chat, turnId)) {
    const receipt = await steerInto(q, item, chat, turnId, message.turnId, "front");
    if (receipt !== "refused") return freshOutcome(receipt);
  } else changed(q);
  return { outcome: (await drain(q))?.item === item ? "sent" : "queued" };
}

export async function steerQueuedMessage(
  sessionId: string,
  id: string,
  turnId: string | undefined,
  fallback: Placement
) {
  const q = queues.get(sessionId);
  const item = q?.items.find((row) => row.message.turnId === id);
  if (!q || !item || stateOf(item) === "sending") return "gone";
  if (item.steer) return item.steer.answer.promise;
  const ownTurn = item.delivery === "standalone";
  const chat = localChat(sessionId);
  if (!chat) return "gone";
  let waiting: "queued" | "own_turn" | "refused" = ownTurn ? "own_turn" : "queued";
  const card = waitingOnCard(chat, sessionId, turnId);
  if (card) return ownTurn ? "own_turn" : card;
  if (!ownTurn && !hold(q) && canSteer(q, chat, turnId)) {
    const receipt = await steerInto(q, item, chat, turnId, uuidv7(), fallback);
    if (receipt !== "refused") return receipt;
    waiting = "refused";
  }
  // The window arrow puts an untaken row first. An agent’s send_now keeps its place.
  if (fallback === "front" && waitingRow(q, id) === item) {
    putFirst(q, [item]);
    changed(q);
  }
  return (await drain(q))?.item === item ? "sent" : waiting;
}

export function queuedMessage(sessionId: string, id: string) {
  const item = waitingRow(queues.get(sessionId), id);
  return { content: item?.message.content ?? null };
}

export function moveQueuedMessage(sessionId: string, id: string, before: string | null) {
  const q = queues.get(sessionId);
  const item = waitingRow(q, id);
  const next = before === null ? undefined : waitingRow(q, before);
  if (!q || !item || (before !== null && !next)) return { moved: false };
  const from = q.items.indexOf(item);
  if (item === next || q.items[from + 1] === next) return { moved: false };
  q.items.splice(from, 1);
  q.items.splice(next ? q.items.indexOf(next) : q.items.length, 0, item);
  changed(q);
  return { moved: true };
}

export function removeQueuedMessage(sessionId: string, id: string) {
  const q = queues.get(sessionId);
  const item = waitingRow(q, id);
  if (!q || !item) return { removed: false };
  q.items.splice(q.items.indexOf(item), 1);
  changed(q);
  return { removed: true };
}

export async function resumeQueuedMessages(sessionId: string, by?: Origin) {
  const q = queues.get(sessionId);
  if (!q) return { outcome: "open" } as const;
  const refusal = changed(q, { type: "resume", by });
  if (refusal) return { outcome: refusal };
  return { outcome: "resumed", turnId: (await drain(q))?.turnId } as const;
}

export function continueAfterLimit(sessionId: string, on: boolean) {
  const q = queues.get(sessionId);
  if (q?.pause?.reason !== "limit" || q.pause.limit.resetsAt === undefined)
    throw new ConflictError("This chat has no reported reset time.");
  if (on && q.pause.limit.resetsAt <= Date.now())
    return continueLimited(q, q.pause.turnId).then(() => ({}));
  changed(q, { type: "schedule", on });
  return {};
}

function continueAt(q: Queue) {
  return q.pause?.reason === "limit" && q.pause.limit.continues
    ? (q.pause.limit.resetsAt ?? Infinity) + MINUTE
    : Infinity;
}

function watchResets() {
  clearTimeout(clock);
  const due = Math.min(...Array.from(queues.values(), continueAt));
  clock = Number.isFinite(due)
    ? setTimeout(checkResets, Math.min(MINUTE, Math.max(0, due - Date.now()))).unref()
    : undefined;
}

function checkResets() {
  const now = Date.now();
  for (const q of queues.values()) {
    if (q.pause?.reason === "limit" && continueAt(q) <= now)
      void continueLimited(q, q.pause.turnId).catch((error) =>
        console.warn("[Queue] Could not continue the chat:", error)
      );
  }
  watchResets();
}

async function continueLimited(q: Queue, turnId: string) {
  changed(q, { type: "clear_limit" });
  const id = q.sessionId;
  const chat = localChat(id);
  if (chat?.status !== "error" || chat.error_category !== "usage_limit" || holdingTurn(id)) return;
  const db = getDatabase();
  const recent = db
    .prepare<[string], { turn_id: string }>(
      `SELECT turn_id FROM turns WHERE session_id = ?
       ORDER BY COALESCE(started_at, ended_at) DESC, turn_id DESC LIMIT 50`
    )
    .all(id);
  if (recent[0]?.turn_id !== turnId) return;
  if (q.items.length) return drain(q);
  const harness = knownHarness(chat.agent_harness);
  if (!harness) return;
  const turns = getTurnsForMessages(db, id, recent);
  await sendMessage({
    sessionId: id,
    content: "Continue.",
    ...continuedSettings(harness, turns),
    permissionMode: turns.at(-1)?.execution?.permissionMode,
  });
}

function settleSteer(steer: Steer, receipt: "read" | "queued") {
  steer.receipt = receipt;
  steer.answer.resolve(receipt);
}

function userEcho(sessionId: string, turnId: string, steerId?: string) {
  const q = queues.get(sessionId);
  if (!q) return;
  const index = q.items.findIndex((item) => {
    if (steerId === undefined) return item.attempt?.turnId === turnId;
    const steer = item.steer ?? item.recoveredSteer;
    return steer?.id === steerId && steer.turnId === turnId;
  });
  if (index < 0) return;
  const [item] = q.items.splice(index, 1);
  if (steerId !== undefined && item?.steer) settleSteer(item.steer, "read");
  if (steerId !== undefined && item?.attempt?.state === "sending") {
    void withdrawSteerRetry(sessionId, item.attempt.turnId).then((withdrawn) => {
      if (withdrawn) void drain(q);
    });
  }
  changed(q);
}

function recoverAttempt(q: Queue, turnId: string, state: "busy" | "returned" = "returned") {
  const head = q.items[0];
  if (head?.attempt?.turnId !== turnId) return false;
  // A busy reply keeps its retry id even if Stop has already returned the head.
  if (head.attempt.state !== "sending" && state !== "busy") return false;
  head.attempt = { turnId, state };
  return true;
}

function recoverSteers(q: Queue, turnId: string) {
  // A read echo lost in a replay gap can come back as a held row.
  const kept: string[] = [];
  const front: Item[] = [];
  for (const item of q.items) {
    const steer = item.steer;
    if (!steer || steer.turnId !== turnId) continue;
    settleSteer(steer, "queued");
    item.recoveredSteer = { turnId, id: steer.id };
    delete item.steer;
    item.delivery = "standalone";
    kept.push(steer.id);
    if (steer.unread === "front") front.push(item);
  }
  if (front.length) putFirst(q, front);
  return kept;
}

function queueToPause(id: string, keepEmpty: boolean) {
  return queues.get(id) ?? (keepEmpty && localChat(id) ? queueFor(id) : undefined);
}

/** A live turn can still echo. Once it is gone, its unread steers can be resumed as turns. */
function interrupted(
  sessionId: string,
  turnId: string | undefined,
  gone: boolean,
  cause: InterruptionCause
) {
  const q = queueToPause(sessionId, cause === "cancelled");
  if (!q) return;
  const kept = gone && turnId !== undefined ? recoverSteers(q, turnId) : undefined;
  if (gone && turnId !== undefined) recoverAttempt(q, turnId);
  changed(q, { type: "interrupted", turnId, gone, cause });
  if (gone) void drain(q);
  return kept;
}

function turnEnded({ event: { sessionId, turnId, stopReason }, status, held, limit }: TurnEnd) {
  const cancelled = stopReason === "cancelled";
  const q = queueToPause(sessionId, !!limit);
  if (!q) return;
  recoverSteers(q, turnId);
  const missingEcho = recoverAttempt(q, turnId);
  changed(q, { type: "end", turnId, cancelled, held, status, limit, missingEcho });
  if (status) void drain(q);
}

provideTurnWatcher({
  turnEnded,
  startCleared: (id) => void drain(queues.get(id)),
  userEcho,
  stopAsked(id, stop) {
    const q = queueToPause(id, true);
    if (q) changed(q, { type: "stop", ...stop });
  },
  interrupted,
});
