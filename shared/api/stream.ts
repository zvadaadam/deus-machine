/**
 * One declaration per stream of events a client can listen to.
 *
 * Nothing is pushed to a client that did not ask for it. A client subscribes
 * to a stream, optionally narrowed by its scope (`{ sessionId }`), and the
 * host sends each event to the subscriptions whose scope it matches. A phone
 * watching one chat therefore receives that chat's events, not every chat's.
 *
 *   scope      the keys an event is published under. A subscription names
 *              some of them (or none, for everything it is allowed to see).
 *   resumable  kept events carry a sequence number per scope; a client that
 *              reconnects passes the last one it saw and receives what it
 *              missed, or is told to read again when that is no longer held.
 */

import { z } from "zod";
import type { Out } from "./op";

export interface Stream<
  Name extends string = string,
  Scope extends z.ZodObject = z.ZodObject,
  Event = unknown,
  Resumable extends boolean = boolean,
> {
  readonly name: Name;
  readonly scope: Scope;
  readonly event: Out<Event>;
  readonly resumable: Resumable;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the variance-free "some stream"
export type AnyStream = Stream<string, z.ZodObject, any, boolean>;
/** What an event is published under: every key of the scope. */
export type ScopeOf<S extends AnyStream> = z.output<S["scope"]>;
/** What a subscriber narrows by: any of the scope's keys. */
export type FilterOf<S extends AnyStream> = Partial<z.input<S["scope"]>>;
export type EventOf<S extends AnyStream> =
  S extends Stream<string, z.ZodObject, infer E, boolean> ? E : never;

const NO_SCOPE = z.object({});
type NoScope = typeof NO_SCOPE;

interface Declaration<Name extends string, Scope extends z.ZodObject, Event> {
  name: Name;
  /** Omit for a stream with one audience (everyone allowed to listen). */
  scope?: Scope;
  event: Out<Event>;
}

export function stream<const Name extends string, Event, Scope extends z.ZodObject = NoScope>(
  def: Declaration<Name, Scope, Event>
): Stream<Name, Scope, Event, false> {
  return {
    name: def.name,
    scope: (def.scope ?? NO_SCOPE) as Scope,
    event: def.event,
    resumable: false,
  };
}

/** A stream whose kept events are numbered per scope and can be resumed. */
export function resumableStream<
  const Name extends string,
  Event,
  Scope extends z.ZodObject = NoScope,
>(def: Declaration<Name, Scope, Event>): Stream<Name, Scope, Event, true> {
  return { ...stream(def), resumable: true };
}

export function isStream(value: unknown): value is AnyStream {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "scope" in value &&
    "event" in value &&
    "resumable" in value
  );
}

/** Does an event published under `scope` reach a subscription that asked for `filter`? */
export function scopeMatches(
  filter: Record<string, unknown>,
  scope: Record<string, unknown>
): boolean {
  for (const key in filter) {
    if (filter[key] !== undefined && filter[key] !== scope[key]) return false;
  }
  return true;
}
