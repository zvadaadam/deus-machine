// backend/src/services/streams.ts
// Events, delivered to the connections that asked for them.
//
// A service publishes an event under a stream and a scope
// (`publish(api.terminalOutput, { id }, event)`). A connection subscribes to a
// stream, narrowed by any of its scope's keys, and receives the events that
// match. Nothing is broadcast: a connection that did not subscribe receives
// nothing.
//
// A resumable stream numbers its kept events per scope and remembers the most
// recent ones. A subscriber is told where the scope stands when it subscribes.
// One that returns says the last number it received and is sent what it
// missed, or a reset when that is no longer held (it then reads the state
// again, as it did when it first opened it).

import { scopeMatches, type AnyStream, type EventOf, type ScopeOf } from "@shared/api/stream";
import type { QEventFrame, QResetFrame, QSubscribedFrame } from "@shared/types/query-protocol";
import { subscriptionKey } from "@deus/runtime-client";
import { ValidationError } from "../lib/errors";
import { getConnection } from "./ws.service";

/** Kept events remembered per scope of a resumable stream. */
const KEPT_PER_SCOPE = 512;
/** Scopes whose kept events are remembered per resumable stream; the least recently published go first. */
const SCOPES_PER_STREAM = 64;

interface Subscription {
  id: string;
  connectionId: string;
  stream: string;
  filter: Record<string, unknown>;
  /** Names its whole scope on a resumable stream: its events carry their number. */
  numbered: boolean;
}

interface Log {
  /** Number of the newest kept event. */
  latest: number;
  /** `restart`: this event restates everything before it, so a replay may begin with it. */
  kept: { seq: number; data: unknown; restart?: true }[];
}

const subscriptions = new Map<string, Subscription>();
/**
 * stream name → scope key → log. A scope's number is never forgotten, only its
 * kept events: that is what tells "nothing happened here since you left" from
 * "what happened is no longer held".
 */
const logs = new Map<string, Map<string, Log>>();
/** stream name → the scopes that still hold kept events, least recently published first. */
const holding = new Map<string, Set<string>>();
/** stream name → what a subscriber to one scope is sent first (see `openWith`). */
const openings = new Map<string, (scope: Record<string, unknown>) => unknown[]>();

/**
 * Where this process starts numbering. A number therefore never means two
 * events, even across a restart: a subscriber that returns with a number from
 * an earlier process is behind everything this one kept, and is told to read
 * again rather than handed a replay from the wrong log.
 */
let firstSeq = Date.now() * 1000;

const subscriptionId = (connectionId: string, id: string) => `${connectionId}\n${id}`;

function send(connectionId: string, frame: QEventFrame | QResetFrame | QSubscribedFrame): void {
  try {
    getConnection(connectionId)?.ws.send(JSON.stringify(frame));
  } catch {
    // The connection is closing; its subscriptions go with it.
  }
}

/** The log an event is published into, made on first use. */
function logFor(stream: string, scopeKey: string): Log {
  let byScope = logs.get(stream);
  if (!byScope) logs.set(stream, (byScope = new Map()));
  let log = byScope.get(scopeKey);
  if (!log) byScope.set(scopeKey, (log = { latest: firstSeq, kept: [] }));
  return log;
}

/** A scope kept an event: it is the most recent, and the one published longest ago lets its events go. */
function hold(stream: string, scopeKey: string): void {
  let held = holding.get(stream);
  if (!held) holding.set(stream, (held = new Set()));
  held.delete(scopeKey);
  held.add(scopeKey);
  if (held.size <= SCOPES_PER_STREAM) return;
  const oldest = held.values().next().value!;
  held.delete(oldest);
  logFor(stream, oldest).kept = [];
}

export interface PublishOptions {
  /**
   * Resumable streams only. False for an event nobody needs to see twice (a
   * token delta): it is delivered with the last kept number and never replayed.
   */
  keep?: boolean;
  /**
   * Resumable streams only. This event restates everything before it (a
   * snapshot): earlier kept events are forgotten, and a resume from before it
   * starts here.
   */
  restart?: boolean;
}

/** Send an event to every subscription it matches. */
export function publish<S extends AnyStream>(
  stream: S,
  scope: ScopeOf<S>,
  data: EventOf<S>,
  options: PublishOptions = {}
): void {
  let seq: number | undefined;
  if (stream.resumable) {
    const scopeKey = subscriptionKey(scope);
    const log = logFor(stream.name, scopeKey);
    if (options.keep !== false) {
      if (options.restart) log.kept = [];
      log.kept.push({ seq: ++log.latest, data, ...(options.restart ? { restart: true } : {}) });
      if (log.kept.length > KEPT_PER_SCOPE) log.kept.shift();
      hold(stream.name, scopeKey);
    }
    seq = log.latest;
  }
  const scopeRecord = scope as Record<string, unknown>;
  for (const sub of subscriptions.values()) {
    if (sub.stream !== stream.name || !scopeMatches(sub.filter, scopeRecord)) continue;
    send(sub.connectionId, {
      type: "q:event",
      id: sub.id,
      event: stream.name,
      data,
      ...(sub.numbered ? { seq } : {}),
    });
  }
}

/**
 * Say what a resumable stream sends a subscriber to one scope first, after
 * anything it missed: the state its kept events do not restate yet (a reply
 * still being typed). Delivered under the scope's current number, never kept.
 */
export function openWith<S extends AnyStream>(
  stream: S,
  current: (scope: ScopeOf<S>) => EventOf<S>[]
): void {
  openings.set(stream.name, current as (scope: Record<string, unknown>) => unknown[]);
}

/**
 * Subscribe a connection. `after` is the number of the last event the
 * subscriber received: it is sent what the stream kept since, or a reset when
 * the stream cannot say. Either way it is then told where the scope stands,
 * so it has a place to return to even if nothing happens while it listens.
 */
export function subscribe(
  connectionId: string,
  id: string,
  stream: AnyStream,
  rawFilter: unknown,
  after?: number
): void {
  const parsed = stream.scope.partial().safeParse(rawFilter ?? {});
  if (!parsed.success) {
    throw new ValidationError(`${stream.name}: ${parsed.error.issues[0]?.message ?? "bad scope"}`);
  }
  const filter = parsed.data as Record<string, unknown>;
  // A number only means something within one scope.
  const whole = stream.resumable ? stream.scope.safeParse(filter) : undefined;
  const scope = whole?.success ? (whole.data as Record<string, unknown>) : undefined;
  subscriptions.set(subscriptionId(connectionId, id), {
    id,
    connectionId,
    stream: stream.name,
    filter,
    numbered: scope !== undefined,
  });
  const log = scope && logs.get(stream.name)?.get(subscriptionKey(scope));
  // Where the scope stands: the number of its newest kept event.
  const position = scope ? (log?.latest ?? firstSeq) : undefined;

  if (after !== undefined && after !== position) {
    const oldest = log?.kept[0];
    // Unbroken from where the subscriber stopped, or from an event that restates the rest.
    const covered =
      log !== undefined &&
      oldest !== undefined &&
      after < log.latest &&
      (after + 1 >= oldest.seq || oldest.restart === true);
    if (covered) {
      for (const event of log.kept) {
        if (event.seq <= after) continue;
        send(connectionId, {
          type: "q:event",
          id,
          event: stream.name,
          data: event.data,
          seq: event.seq,
        });
      }
    } else {
      send(connectionId, { type: "q:reset", id, ...(scope ? { seq: position } : {}) });
    }
  }
  if (scope) {
    for (const data of openings.get(stream.name)?.(scope) ?? []) {
      send(connectionId, { type: "q:event", id, event: stream.name, data, seq: position });
    }
  }
  send(connectionId, { type: "q:subscribed", id, ...(scope ? { seq: position } : {}) });
}

/**
 * The state under a scope changed in a way its events do not say (rows filled
 * in from elsewhere): the connections following it read again.
 */
export function resetSubscribers<S extends AnyStream>(stream: S, scope: ScopeOf<S>): void {
  const scopeRecord = scope as Record<string, unknown>;
  let position: number | undefined;
  if (stream.resumable) {
    // A follower that is away now returns with an earlier number, and nothing kept leads
    // from there to here: it is told to read again too.
    const log = logFor(stream.name, subscriptionKey(scope));
    log.kept = [];
    position = ++log.latest;
  }
  for (const sub of subscriptions.values()) {
    if (sub.stream !== stream.name || !scopeMatches(sub.filter, scopeRecord)) continue;
    send(sub.connectionId, {
      type: "q:reset",
      id: sub.id,
      ...(sub.numbered ? { seq: position } : {}),
    });
  }
}

export function unsubscribe(connectionId: string, id: string): boolean {
  return subscriptions.delete(subscriptionId(connectionId, id));
}

/** A connection closed: forget what it was listening to. */
export function dropConnection(connectionId: string): void {
  for (const [key, sub] of subscriptions) {
    if (sub.connectionId === connectionId) subscriptions.delete(key);
  }
}

/** Tests only: forget everything, and number from `first` as a new process would. */
export function _reset(first = 0): void {
  subscriptions.clear();
  logs.clear();
  holding.clear();
  openings.clear();
  firstSeq = first;
}
