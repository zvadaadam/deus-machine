// shared/protocol-types.ts
// The canonical agent protocol vocabulary — re-exported verbatim from
// @zvada/agent-server/protocol. Deus has no dialect: the engine's Part /
// ToolState / LifecycleEvent shapes ARE the shapes that cross the wire, land
// in SQLite (`parts.data` is the engine `Part` verbatim) and render in the UI.
//
// Type-only on purpose, and this file exists for exactly one consumer: the
// RENDERER. The package ships readable TypeScript source, so a value import
// would pull zod (and the whole protocol module graph) into the browser
// bundle. The backend and the agent-server have no such constraint and import
// "@zvada/agent-server/protocol" directly — including for runtime behaviour
// (`classifyError`, the zod schemas).
//
// So the list below is not "the vocabulary": it is the subset the frontend
// actually imports, plus the Law-6 decoded shapes both sides need. Law 7 —
// advertise nothing you don't deliver; a re-export with no consumer reads as
// a capability. Need another type? Add it here when you import it, not before.

import type {
  LifecycleEvent,
  MessagePartEvent,
  Part,
  UnknownEvent,
  UnknownPart,
  WireEventEnvelope,
} from "@zvada/agent-server/protocol";

export type {
  // ---- events ----
  LifecycleEvent,
  UnknownEvent,
  MessageStartedEvent,
  MessagePartEvent,
  TurnEndedEvent,
  // ---- parts ----
  Part,
  UnknownPart,
  TextPart,
  ReasoningPart,
  ToolPart,
  ImagePart,
  FilePart,
  SubagentMetadata,
  // ---- tool state ----
  ToolStateCompleted,
  ToolResultContent,
  // ---- input ----
  PartInput,
  ImagePartInput,
  // ---- config ----
  AgentCapabilities,
  // ---- accounting + errors ----
  TokenUsage,
  ErrorCategory,
  // ---- wire ----
  WireEventEnvelope,
} from "@zvada/agent-server/protocol";

/**
 * Law 6 — tolerant of the unknown, strict about the known.
 *
 * The wire decoder preserves an event type this build does not know, and an
 * unknown PART inside a known `message.part`, instead of dropping them: a
 * dropped event is a hole in the transcript AND a fabricated seq gap for every
 * consumer counting envelopes. These aliases are what a consumer of the
 * decoded stream actually receives — `LifecycleEvent` is the strict shape an
 * ADAPTER emits, not the shape a sink reads.
 *
 * Written structurally rather than re-exported so a package bump cannot
 * silently narrow deus's sinks back to the strict union.
 */
export type AnyMessagePartEvent = Omit<MessagePartEvent, "part"> & { part: Part | UnknownPart };

export type AnyLifecycleEvent =
  | Exclude<LifecycleEvent, MessagePartEvent>
  | AnyMessagePartEvent
  | UnknownEvent;

export type AnyWireEventEnvelope = Omit<WireEventEnvelope, "event"> & { event: AnyLifecycleEvent };

/**
 * Narrow a decoded event to the known union.
 *
 * `raw` is the structural discriminator: no known member declares it. Matching
 * on `type` alone is NOT enough — `UnknownEvent.type` is an open `string`, so
 * `{ type: "session.created" }` matches the unknown shape too and every field
 * access after it stops compiling.
 *
 * The one value export here on purpose: it is a two-line predicate with no
 * imports, so it costs the renderer bundle nothing (the reason this file is
 * otherwise type-only is zod, not values).
 */
export function isUnknownLifecycleEvent(event: AnyLifecycleEvent): event is UnknownEvent {
  return "raw" in event;
}

/** The same narrowing for a PART inside a known `message.part`. */
export function isUnknownPart(part: Part | UnknownPart): part is UnknownPart {
  return "raw" in part;
}
