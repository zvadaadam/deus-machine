import { chatHasStarted } from "@shared/session";
import { agentOrigin, inputToText, type Origin } from "@zvada/agent-server/protocol";
import type * as api from "@shared/api/sessions";
import type { ParsedInputOf } from "@shared/api/op";
import { knownHarness } from "@shared/harnesses";
import { uuidv7 } from "@shared/lib/uuid";
import { encodeOrigin, recentTurns, sameOrigin, type SessionRow } from "../../db";
import { getDatabase } from "../../lib/database";
import {
  AppError,
  ChatBusyError,
  ConflictError,
  DifferentTurnMessageError,
  NotFoundError,
} from "../../lib/errors";
import { invalidate, onInvalidate } from "../query-engine";
import { getSetting } from "../settings.service";
import { toEngineInput } from "./run-config";
import { steerTurn } from "./service";
import { holdingTurn, competingEnd, type TurnNotice } from "./chat-turn";
import { continuedPermissionMode, continuedSettings } from "./turn-settings";
import {
  type LocalSend,
  previousSend,
  requireSameHarness,
  requireChatRoute,
  retryReadSteer,
  sendMessage,
  withdrawSteerRetry,
} from "./turns";

type Input = ParsedInputOf<typeof api.sendMessage>;
type Message = LocalSend & { turnId: string };
type LocalChat = Pick<
  SessionRow,
  | "status"
  | "agent_harness"
  | "message_count"
  | "last_user_message_at"
  | "gateway_revision"
  | "error_category"
>;
type SteerReceipt = "acknowledged" | "read" | "queued" | "refused" | "unconfirmed";
type Placement = "front" | "in_place";
type Row = {
  message: Message;
  origin?: Origin;
  text: string;
  images: number;
  state: api.QueuedMessages["items"][number]["state"];
  held: boolean;
  reason?: string;
  ownTurn: boolean;
  sentAs?: { turnId: string; reuse: boolean };
  steer?: {
    id: string;
    turnId: string;
    live?: {
      unread: Placement;
      answer: ReturnType<typeof Promise.withResolvers<SteerReceipt>>;
    };
  };
};

type Hold =
  | { reason: "stopped"; by?: Origin }
  | { reason: "failed" }
  | { reason: "limit"; turnId: string; limit: NonNullable<api.QueuedMessages["limit"]> };
interface Queue {
  sessionId: string;
  items: Row[];
  hold?: Hold;
  answered?: string;
  busyOn?: string;
}

/**
 * Stop marks every row present, as does an interruption or the holder's failed or cancelled end.
 * Only the end of the turn holding the chat can hold the queue, unless another end returns a row still waiting for its echo.
 * After a Stop or interruption, the turn takes no more steers and only its usage limit marks rows again.
 * A cancellation credits its first Stop, and one without a stopper leaves held rows for the person.
 * All marked rows share one hold, with the person's Stop taking priority and the first agent Stop replacing a failure or limit.
 * Only a limit can hold an empty queue, and a turn that was stopped or interrupted waits for the person's Continue at a usage limit.
 * A person's send follows the last unheld row or leads the waiting rows if all are held, while an agent or assistant joins a standing hold.
 * A fresh steer may enter another turn, and an agent’s fallback row joins the hold.
 * A held row may move but cannot steer into a turn or block an unheld row.
 * With no reset time only a person may retry the limit, with the waiting head or “Continue.”
 * Resume and clearing a limit both release every marked row, and agents may resume failures, agent Stops and limits after a reported reset.
 */
function markRows(q: Queue, turnId?: string) {
  if (turnId !== undefined) q.answered = turnId;
  for (const row of q.items) row.held = true;
}

function recordStop(q: Queue, by?: Origin) {
  const prior = q.hold;
  if (prior?.reason !== "stopped" || by?.kind === "person" || (!by && agentOrigin(prior.by)))
    q.hold = { reason: "stopped", by };
}

function interrupt(
  q: Queue,
  turnId: string | undefined,
  cause: "cancelled" | "failure",
  by?: Origin
) {
  if (!turnId || q.answered !== turnId) {
    markRows(q, turnId);
    if (cause === "failure") q.hold ??= { reason: "failed" };
  }
  if (cause === "cancelled") recordStop(q, by);
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
  const sql = `SELECT s.status, s.agent_harness, s.message_count, s.last_user_message_at,
    s.gateway_revision, s.error_category ${OPEN_LOCAL} AND s.id = ?`;
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

function changed(q: Queue) {
  if (queues.get(q.sessionId) !== q) return;
  if (q.hold?.reason !== "limit" && !q.items.some((row) => row.held)) {
    delete q.hold;
    if (!q.items.length && (!q.answered || q.answered !== holdingTurn(q.sessionId)?.turnId))
      queues.delete(q.sessionId);
  }
  notify([q.sessionId]);
}

function clearHold(q: Queue) {
  delete q.hold;
  for (const row of q.items) row.held = false;
  changed(q);
}

function queueFor(sessionId: string): Queue {
  const existing = queues.get(sessionId);
  if (existing) return existing;
  const q: Queue = { sessionId, items: [] };
  queues.set(sessionId, q);
  // Archive, hide and delete publish a changed list. A turn's scoped updates
  // cannot remove a chat. Check all held queues in one read on list changes.
  unwatch ??= onInvalidate((resources, ctx) => {
    if (!(resources.includes("workspaces") || resources.includes("sessions"))) return;
    if (ctx?.sessionIds?.length) {
      for (const id of ctx.sessionIds) {
        const held = queues.get(id);
        if (
          held?.hold?.reason === "limit" &&
          (holdingTurn(id) || localChat(id)?.error_category !== "usage_limit")
        ) {
          clearHold(held);
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

function checkQueueRoute(chat: LocalChat, input: Input) {
  // The first turn binds the harness before its user echo increments the message count.
  if (chatHasStarted(chat) || holdingTurn(input.sessionId))
    requireSameHarness(chat.agent_harness, input.agentHarness);
  requireChatRoute(input.sessionId, input.gatewayRevision);
}

function newRow(q: Queue, message: Message, origin: Origin | undefined, ownTurn: boolean): Row {
  const sender = agentOrigin(origin);
  if (sender && q.items.filter((item) => item.origin).length >= MAX_AGENT_MESSAGES)
    throw new QueueLimitError("agents");
  if (q.items.length >= MAX_QUEUED_MESSAGES) throw new QueueLimitError("total");
  const input = toEngineInput(message.content);
  return {
    message,
    ownTurn,
    state: "waiting",
    origin: sender,
    held: !!sender && !!q.hold,
    text: inputToText(input),
    images: typeof input === "string" ? 0 : input.filter((p) => p.type === "image").length,
  };
}

/** The usage-limit hold a turn left, while the queue still holds for that turn. */
export function limitHoldOf(sessionId: string, turnId: string) {
  const hold = queues.get(sessionId)?.hold;
  return hold?.reason === "limit" && hold.turnId === turnId ? hold.limit : undefined;
}

export function queuedMessages(sessionId: string): api.QueuedMessages {
  const q = queues.get(sessionId);
  if (!q) return { paused: null, items: [] };
  const { hold } = q;
  const fenced = q.busyOn && q.items.some((row) => row.state === "waiting");
  return {
    paused: hold?.reason ?? (fenced ? "failed" : null),
    ...(hold?.reason === "stopped" && hold.by && { stoppedBy: hold.by }),
    ...(hold?.reason === "limit" && { limit: hold.limit }),
    items: q.items.map(({ message, text, images, state, origin, reason }) => ({
      id: message.turnId,
      text,
      images,
      state,
      ...(reason && { reason }),
      ...(origin && { origin }),
    })),
  };
}

function waitingRow(q: Queue | undefined, id: string) {
  return q?.items.find((item) => item.message.turnId === id && item.state === "waiting");
}

function waitForWinner(q: Queue, { competingTurnId }: ChatBusyError) {
  if (competingEnd(q.sessionId, competingTurnId)) return true;
  q.busyOn = competingTurnId;
  return false;
}

// A busy head waits for the named end, engine-confirmed absence, or Resume.
async function drain(q: Queue | undefined, retryBusy = false) {
  if (!q) return;
  if (retryBusy && q.busyOn) {
    delete q.busyOn;
    changed(q);
  }
  const head = q.items.find((item) => !item.held);
  if (head?.state !== "waiting") return;
  if (q.busyOn && (!q.hold || head.sentAs)) return;
  if (!localChat(q.sessionId)) {
    queues.delete(q.sessionId);
    notify([q.sessionId]);
    return;
  }
  if (holdingTurn(q.sessionId)) return;
  if (head !== q.items[0]) q.items = [head, ...q.items.filter((row) => row !== head)];
  const previous = head.sentAs;
  let turnId = head.message.turnId;
  if (previous) turnId = previous.reuse ? previous.turnId : uuidv7();
  // A strict send can report an interruption before it returns its admission promise.
  head.sentAs = { turnId, reuse: false };
  head.state = "sending";
  delete head.reason;
  const admission = sendMessage({ ...head.message, turnId }, head.origin);
  changed(q);
  try {
    await admission;
    return { item: head, turnId };
  } catch (error) {
    if (holdingTurn(q.sessionId)?.turnId === turnId) return;
    const busy = error instanceof ChatBusyError;
    const reason = busy
      ? undefined
      : error instanceof AppError
        ? error.message
        : "Could not send this queued message.";
    if (queues.get(q.sessionId) !== q || !returnHead(q, turnId, busy, reason)) return;
    if (!busy) interrupt(q, turnId, "failure");
    // The competing turn may already have ended while this attempt held the head.
    const winnerEnded = busy && waitForWinner(q, error);
    changed(q);
    if (winnerEnded) void drain(q);
  }
}

function alreadyQueued({ sessionId, turnId, content }: Message, origin?: Origin) {
  const items = queues.get(sessionId)?.items;
  const index = items?.findIndex((row) => row.message.turnId === turnId) ?? -1;
  const row = items?.[index];
  if (!row) return;
  if (row.message.content !== content || encodeOrigin(row.origin) !== encodeOrigin(origin))
    throw new DifferentTurnMessageError();
  return { row, position: index + 1 };
}

function appendRow(q: Queue, item: Row) {
  if (item.held) return q.items.push(item);
  let at = 0;
  for (const [index, row] of q.items.entries()) {
    if (!row.held || row.state === "sending") at = index + 1;
  }
  q.items.splice(at, 0, item);
  return at + 1;
}

function append(message: Message, origin: Origin | undefined, chat: LocalChat, start = true) {
  checkQueueRoute(chat, message);
  const q = queueFor(message.sessionId);
  const sender = agentOrigin(origin);
  // Once the matching row has run, retrying a lost answer can queue it again.
  const duplicate =
    sender &&
    q.items.find(
      (item) =>
        item.state === "waiting" &&
        sameOrigin(item.origin, sender) &&
        item.message.content === message.content
    );
  if (duplicate) return q.items.indexOf(duplicate) + 1;
  const position = appendRow(q, newRow(q, message, origin, !!message.preserveTurnId));
  changed(q);
  if (start) void drain(q);
  return position;
}

/** The operator commits a row at its access check. Only the drain starts it. */
export async function enqueueMessage(message: Message, origin: Origin) {
  const { sessionId, turnId } = message;
  const queued = alreadyQueued(message, origin);
  if (queued) return { position: queued.position };
  const previous = previousSend(message, turnId, origin);
  if (previous) return previous.then(() => ({}));
  const chat = localChat(sessionId);
  if (!chat) throw new NotFoundError("That chat is gone.");
  return { position: append(message, origin, chat) };
}

export function isSendPending(sessionId: string, turnId: string) {
  return (
    holdingTurn(sessionId)?.turnId === turnId ||
    queues.get(sessionId)?.items.some((item) => item.message.turnId === turnId) === true
  );
}

export async function sendOrQueue(input: LocalSend) {
  const { sessionId } = input;
  let chat = localChat(sessionId);
  if (!chat) return sendMessage(input);
  const message = { ...input, turnId: input.turnId ?? uuidv7() };
  const queued = { turnId: message.turnId, queued: true as const };
  if (alreadyQueued(message)) return queued;
  const queue = queues.get(sessionId);
  const behind = queue?.items.some((item) => !item.held && item.state === "waiting");
  const admission =
    behind || holdingTurn(sessionId) ? previousSend(message, message.turnId) : sendMessage(message);
  let start = !behind;
  if (admission) {
    try {
      return await admission;
    } catch (error) {
      if (!(error instanceof ChatBusyError)) throw error;
      chat = localChat(sessionId);
      if (!chat) throw error;
      if (alreadyQueued(message)) return queued;
      start = waitForWinner(queueFor(sessionId), error);
    }
  }
  append(message, undefined, chat, start);
  return queued;
}

type SteerResult = { outcome: "steered" | "queued" | "sent" | "unconfirmed" };

function canSteer(q: Queue, chat: LocalChat, turnId: string | undefined): turnId is string {
  if (turnId === undefined || q.answered === turnId || chat.status === "error") return false;
  const turn = holdingTurn(q.sessionId);
  return turn?.turnId === turnId && turn.phase !== "preparing";
}

function waitingOnCard(chat: LocalChat, sessionId: string, turnId?: string) {
  const owner = holdingTurn(sessionId);
  if (!owner || (turnId !== undefined && turnId !== owner.turnId)) return;
  if (chat.status === "needs_response") return "question";
  if (chat.status === "needs_plan_response") return "plan";
}

/** Keep the sending head and earlier fresh steers ahead of a front-of-queue fallback. */
function putFirst(q: Queue, items: Row[]) {
  const rest = q.items.filter((row) => !items.includes(row));
  const first = rest.findIndex(
    (row) => row.state !== "sending" && !(row.ownTurn && row.state === "steering")
  );
  rest.splice(first < 0 ? rest.length : first, 0, ...items);
  q.items = rest;
}

/** A receipt belongs to its named turn. The row stays in its slot while the wire answers. */
function steerInto(q: Queue, item: Row, chat: LocalChat, turnId: string, unread: Placement) {
  const id = item.ownTurn ? item.message.turnId : uuidv7();
  const answer = Promise.withResolvers<SteerReceipt>();
  const live = { unread, answer };
  item.steer = { id, turnId, live };
  item.state = "steering";
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
      if (error instanceof DifferentTurnMessageError && item.steer?.live === live) {
        delete item.steer;
        item.state = "waiting";
        if (item.ownTurn) q.items.splice(q.items.indexOf(item), 1);
        changed(q);
        throw error;
      }
    });
    if (item.steer?.live !== live) return answer.promise;
    if (queues.get(q.sessionId) !== q) return "queued";
    if (!result) return "unconfirmed";
    if (result.outcome === "steered") return "acknowledged";
    delete item.steer.live;
    item.state = "waiting";
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
    const held = alreadyQueued(message, origin)?.row;
    if (held) {
      const pending = held.steer;
      if (held.ownTurn && pending && pending.turnId !== turnId)
        throw new DifferentTurnMessageError();
      return freshOutcome(
        pending?.id === steerId && pending.live ? await pending.live.answer.promise : "queued"
      );
    }
    const sent = previousSend(message, steerId, origin);
    if (sent) return sent.then(() => ({ outcome: "queued" }) as const);
    const read = retryReadSteer({ ...input, turnId }, steerId, origin);
    if (read) {
      await read;
      return { outcome: "steered" };
    }
    // Removing a row removes the id a later retry could match. Once the host answers,
    // an RPC timeout at the caller does not make the package retry.
  }
  if (!chat) {
    await sendMessage(steerId === undefined ? input : message, origin);
    return { outcome: "sent" };
  }
  checkQueueRoute(chat, input);
  const q = queueFor(sessionId);
  const item = newRow(q, message, origin, true);
  if (turnId !== undefined) item.steer = { id: message.turnId, turnId };
  if (waitingOnCard(chat, sessionId, turnId)) {
    appendRow(q, item);
    changed(q);
    return { outcome: "queued" };
  }
  putFirst(q, [item]);
  if (canSteer(q, chat, turnId)) {
    const receipt = await steerInto(q, item, chat, turnId, "front");
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
  if (!q || !item || item.state === "sending") return "gone";
  if (item.steer?.live) return item.steer.live.answer.promise;
  const { ownTurn } = item;
  const chat = localChat(sessionId);
  if (!chat) return "gone";
  checkQueueRoute(chat, item.message);
  let waiting: "queued" | "own_turn" | "refused" = ownTurn ? "own_turn" : "queued";
  const card = waitingOnCard(chat, sessionId, turnId);
  if (card) return ownTurn ? "own_turn" : card;
  if (!ownTurn && !item.held && canSteer(q, chat, turnId)) {
    const receipt = await steerInto(q, item, chat, turnId, fallback);
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
  const hold = q?.hold;
  const agent = agentOrigin(by);
  const retry = !!q?.busyOn;
  if (!q || (!hold && !retry)) return { outcome: "open" } as const;
  if (agent && hold?.reason === "stopped" && !agentOrigin(hold.by))
    return { outcome: "person_only" } as const;
  if (agent && hold?.reason === "limit") {
    if (hold.limit.resetsAt === undefined) return { outcome: "person_only" } as const;
    if (hold.limit.resetsAt > Date.now()) return { outcome: "before_reset" } as const;
  }
  if (hold?.reason === "limit" && hold.limit.resetsAt === undefined && !q.items.length)
    return { outcome: "resumed", turnId: (await continueLimited(q, hold.turnId))?.turnId } as const;
  clearHold(q);
  return { outcome: "resumed", turnId: (await drain(q, retry))?.turnId } as const;
}

export function continueAfterLimit(sessionId: string, on: boolean) {
  const q = queues.get(sessionId);
  if (q?.hold?.reason !== "limit" || q.hold.limit.resetsAt === undefined)
    throw new ConflictError("This chat has no reported reset time.");
  if (on && q.hold.limit.resetsAt <= Date.now())
    return continueLimited(q, q.hold.turnId).then(() => ({}));
  q.hold.limit.continues = on;
  changed(q);
  return {};
}

function continueAt(q: Queue) {
  return q.hold?.reason === "limit" && q.hold.limit.continues
    ? (q.hold.limit.resetsAt ?? Infinity) + MINUTE
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
    if (q.hold?.reason === "limit" && continueAt(q) <= now)
      void continueLimited(q, q.hold.turnId).catch((error) =>
        console.warn("[Queue] Could not continue the chat:", error)
      );
  }
  watchResets();
}

async function continueLimited(q: Queue, turnId: string) {
  clearHold(q);
  const id = q.sessionId;
  const chat = localChat(id);
  if (chat?.status !== "error" || chat.error_category !== "usage_limit" || holdingTurn(id)) return;
  if (recentTurns(getDatabase(), id, 1)[0]?.turnId !== turnId) return;
  if (q.items.length) return drain(q);
  if (!knownHarness(chat.agent_harness)) return;
  return sendMessage({
    sessionId: id,
    content: "Continue.",
    ...continuedSettings(id),
    permissionMode: continuedPermissionMode(id),
  });
}

export function userEcho(sessionId: string, turnId: string, steerId?: string) {
  const q = queues.get(sessionId);
  if (!q) return;
  const index = q.items.findIndex(({ sentAs, steer }) =>
    steerId === undefined
      ? sentAs?.turnId === turnId
      : steer?.id === steerId && steer.turnId === turnId
  );
  if (index < 0) return;
  const item = q.items.splice(index, 1)[0]!;
  if (steerId !== undefined) {
    item.steer?.live?.answer.resolve("read");
    delete item.steer;
    if (item.state === "sending" && item.sentAs)
      void withdrawSteerRetry(sessionId, item.sentAs.turnId).then((withdrawn) => {
        if (withdrawn) void drain(q);
      });
  }
  changed(q);
}

function returnHead(q: Queue, turnId: string, reuse = false, reason?: string) {
  const head = q.items.find((item) => item.sentAs?.turnId === turnId);
  if (!head?.sentAs) return false;
  if (reason) {
    head.reason = reason;
    if (head.state === "waiting") changed(q); // Setup already returned this attempt.
  }
  // A busy reply keeps its retry id even if Stop already returned the head.
  if (head.state === "sending") head.state = "waiting";
  else if (!reuse) return false;
  // The sender retries a missing exact receipt. The queue must never run it under a new id.
  if (!reuse && head.message.preserveTurnId) q.items.splice(q.items.indexOf(head), 1);
  head.sentAs.reuse = reuse;
  return true;
}

export function recoverSteers(id: string, turnId: string, missingHead = false) {
  const q = queues.get(id);
  if (!q) return;
  const kept: string[] = [];
  const front: Row[] = [];
  for (const item of q.items) {
    const steer = item.steer;
    if (steer?.turnId !== turnId || !steer.live) continue;
    steer.live.answer.resolve("queued");
    if (steer.live.unread === "front") front.push(item);
    delete steer.live;
    item.state = "waiting";
    item.ownTurn = true;
    kept.push(steer.id);
  }
  if (front.length) putFirst(q, front);
  if (missingHead) returnHead(q, turnId);
  return kept;
}

/** A live turn can still echo. Once it is gone, return its unread steers to the queue. */
export function onTurnNotice(id: string, event: TurnNotice) {
  if (event.type === "engine_idle") return void drain(queues.get(id), true);
  const keepEmpty =
    event.type === "end" ? event.held && event.limit : event.type === "stop" || !event.gone;
  const q = queues.get(id) ?? (keepEmpty && localChat(id) ? queueFor(id) : undefined);
  if (!q) return;
  if (event.type === "stop") {
    markRows(q, event.turnId);
    recordStop(q, event.by);
    changed(q);
    return;
  }
  const gone = event.type === "end" || event.gone;
  const turnId = event.turnId;
  if (gone && turnId) recoverSteers(id, turnId);
  const missingEcho = gone && turnId !== undefined && returnHead(q, turnId);
  if (event.type === "interrupted") interrupt(q, turnId, event.cause, event.by);
  else if (event.held && event.limit) {
    const continues =
      q.answered !== turnId &&
      event.limit.resetsAt !== undefined &&
      getSetting("continue_after_usage_limit") === true;
    markRows(q, turnId);
    q.hold ??= { reason: "limit", turnId: event.turnId, limit: { ...event.limit, continues } };
  } else if (event.held || missingEcho) {
    if (event.cancelled) interrupt(q, turnId, "cancelled", event.by);
    else if (missingEcho || event.outcome?.status === "error") interrupt(q, turnId, "failure");
  }
  changed(q);
  const winnerEnded = event.type === "end" && q.busyOn === event.turnId;
  if (winnerEnded || (event.type === "end" ? event.outcome : gone)) void drain(q, winnerEnded);
}
