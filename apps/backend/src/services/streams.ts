// backend/src/services/streams.ts
// Events, delivered to the connections that asked for them.
//
// A service publishes an event under a stream and a scope
// (`publish(api.sessionEvents, { sessionId }, envelope)`). A connection
// subscribes to a stream, narrowed by any of its scope's keys, and receives the
// events that match. Nothing is broadcast: a connection that did not subscribe
// receives nothing.
//
// A resumable stream numbers its kept events per scope and remembers the most
// recent ones. A subscriber that says which number it saw last receives what
// it missed, or a reset when that is no longer held (it then reads the
// resource again, as it would on first load).

import { scopeMatches, type AnyStream, type EventOf, type ScopeOf } from "@shared/api/stream";
import type { QEventFrame, QResetFrame } from "@shared/types/query-protocol";
import { subscriptionKey } from "@deus/runtime-client";
import { ValidationError } from "../lib/errors";
import { getConnection } from "./ws.service";

/** Kept events remembered per scope of a resumable stream. */
const KEPT_PER_SCOPE = 512;
/** Scopes remembered per resumable stream; the least recently published is dropped first. */
const SCOPES_PER_STREAM = 64;

interface Subscription {
  id: string;
  connectionId: string;
  stream: string;
  filter: Record<string, unknown>;
}

interface Log {
  /** Seq of the newest kept event, 0 before the first. */
  latest: number;
  /** `restart`: this event restates everything before it, so a replay may begin with it. */
  kept: { seq: number; data: unknown; restart?: true }[];
}

const subscriptions = new Map<string, Subscription>();
/** stream name → scope key → log. Insertion order is recency of publishing. */
const logs = new Map<string, Map<string, Log>>();

const subscriptionId = (connectionId: string, id: string) => `${connectionId}\n${id}`;

function send(connectionId: string, frame: QEventFrame | QResetFrame): void {
  try {
    getConnection(connectionId)?.ws.send(JSON.stringify(frame));
  } catch {
    // The connection is closing; its subscriptions go with it.
  }
}

function logOf(stream: string, scopeKey: string, create: boolean): Log | undefined {
  let byScope = logs.get(stream);
  if (!byScope) {
    if (!create) return undefined;
    logs.set(stream, (byScope = new Map()));
  }
  let log = byScope.get(scopeKey);
  if (!log && create) {
    log = { latest: 0, kept: [] };
    if (byScope.size >= SCOPES_PER_STREAM) byScope.delete(byScope.keys().next().value!);
  }
  if (log && create) {
    // Re-insert: the most recently published scope is the last to be dropped.
    byScope.delete(scopeKey);
    byScope.set(scopeKey, log);
  }
  return log;
}

export interface PublishOptions {
  /**
   * Resumable streams only. The event's own number in its scope, when the
   * source already numbers its events (the engine does); the next number
   * otherwise.
   */
  seq?: number;
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
    const log = logOf(stream.name, subscriptionKey(scope), true)!;
    if (options.keep === false) {
      seq = log.latest;
    } else {
      seq = options.seq ?? log.latest + 1;
      // A source that starts numbering again (a restarted engine) starts a new log.
      if (options.restart || seq <= log.latest) log.kept = [];
      log.latest = seq;
      log.kept.push(options.restart ? { seq, data, restart: true } : { seq, data });
      if (log.kept.length > KEPT_PER_SCOPE) log.kept.shift();
    }
  }
  const scopeRecord = scope as Record<string, unknown>;
  for (const sub of subscriptions.values()) {
    if (sub.stream !== stream.name || !scopeMatches(sub.filter, scopeRecord)) continue;
    send(sub.connectionId, {
      type: "q:event",
      id: sub.id,
      event: stream.name,
      data,
      ...(seq !== undefined ? { seq } : {}),
    });
  }
}

/**
 * Subscribe a connection. `after` is the last seq the subscriber saw: it is
 * sent what the stream kept since, or a reset when the stream cannot say.
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
  subscriptions.set(subscriptionId(connectionId, id), {
    id,
    connectionId,
    stream: stream.name,
    filter,
  });
  if (after === undefined || !stream.resumable) return;

  // Resuming needs the whole scope: a number only means something within one.
  const complete = stream.scope.safeParse(filter);
  if (!complete.success) {
    throw new ValidationError(`${stream.name} can only be resumed with its whole scope`);
  }
  const log = logOf(stream.name, subscriptionKey(complete.data), false);
  if (!log) {
    // Nothing published since this process started. A subscriber that saw
    // events before then saw another log: it must read again.
    if (after > 0) send(connectionId, { type: "q:reset", id, seq: 0 });
    return;
  }
  if (after === log.latest) return;
  const oldest = log.kept[0];
  // Unbroken from where the subscriber stopped, or from an event that restates the rest.
  const covered = oldest !== undefined && (after + 1 >= oldest.seq || oldest.restart === true);
  if (after > log.latest || !covered) {
    send(connectionId, { type: "q:reset", id, seq: log.latest });
    return;
  }
  for (const event of log.kept) {
    if (event.seq > after) {
      send(connectionId, {
        type: "q:event",
        id,
        event: stream.name,
        data: event.data,
        seq: event.seq,
      });
    }
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

/** Whether anyone is listening to a stream under this scope. */
export function hasListeners<S extends AnyStream>(stream: S, scope: ScopeOf<S>): boolean {
  const scopeRecord = scope as Record<string, unknown>;
  for (const sub of subscriptions.values()) {
    if (sub.stream === stream.name && scopeMatches(sub.filter, scopeRecord)) return true;
  }
  return false;
}

/** Tests only. */
export function _reset(): void {
  subscriptions.clear();
  logs.clear();
}
