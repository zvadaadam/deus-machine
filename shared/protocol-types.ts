// shared/protocol-types.ts
// The canonical agent protocol vocabulary — re-exported verbatim from
// @zvada/agent-server/protocol. Deus has no dialect: the engine's Part /
// ToolState / LifecycleEvent shapes ARE the shapes that cross the wire, land
// in SQLite (`parts.data` is the engine `Part` verbatim) and render in the UI.
//
// This file exists for exactly one consumer: the RENDERER. The package ships
// readable TypeScript source, so importing the protocol BARREL for a value
// pulls zod (and the whole part/event union) into the browser bundle. Type
// imports are erased and cost nothing; the two runtime guards come from
// `@zvada/agent-server/protocol/guards`, the subpath the package keeps
// zod-free for exactly this reason. The backend and the agent-server have no
// such constraint and import "@zvada/agent-server/protocol" directly —
// including for runtime behaviour (`classifyError`, `parseAgentInput`, the
// zod schemas).
//
// So the list below is not "the vocabulary": it is the subset the frontend
// actually imports, plus the Law-6 decoded shapes both sides need. Law 7 —
// advertise nothing you don't deliver; a re-export with no consumer reads as
// a capability. Need another type? Add it here when you import it, not before.
//
// Nothing in this file may RE-DERIVE an engine shape. A structural restatement
// (`Omit<…> & { part: Part | UnknownPart }`) reads as a safety net and is the
// opposite: it silently diverges the day the engine's own shape changes.

import type { DecodedLifecycleEvent, UnknownEvent } from "@zvada/agent-server/protocol";

export type {
  // ---- events ----
  LifecycleEvent,
  UnknownEvent,
  MessageStartedEvent,
  MessagePartEvent,
  TurnEndedEvent,
  // ---- events, decoded the Law-6 way (unknowns preserved, never dropped) ----
  // `Decoded*` is what a SINK receives; the strict `LifecycleEvent` /
  // `WireEventEnvelope` above is what an ADAPTER emits.
  DecodedLifecycleEvent,
  DecodedMessagePartEvent,
  DecodedWireEventEnvelope,
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
  ToolState,
  ToolStateCompleted,
  ToolResultContent,
  // ---- input ----
  AgentInput,
  PartInput,
  ImagePartInput,
  // ---- config ----
  AgentCapabilities,
  // ---- accounting + errors ----
  TokenUsage,
  ErrorCategory,
  // ---- conversation fold ----
  ConversationState,
  ConversationChange,
  ConversationMessage,
  ConversationTurn,
  TimelineEntry,
  // ---- wire ----
  WireEventEnvelope,
} from "@zvada/agent-server/protocol";

/**
 * The union a decoder yields: a known event, or one this build has never heard
 * of. The engine writes it inline everywhere (`DecodedLifecycleEvent |
 * UnknownEvent`) and never names it; deus names it once because it is the
 * parameter type of every sink in the repo.
 */
export type AnyLifecycleEvent = DecodedLifecycleEvent | UnknownEvent;

/**
 * Law 6 — tolerant of the unknown, strict about the known.
 *
 * `isUnknownEvent` narrows a decoded event to the unknown case, `isUnknownPart`
 * does the same for a PART inside a known `message.part`. Matching on `type`
 * alone is NOT enough: `UnknownEvent.type` is an open `string`, so
 * `{ type: "session.created" }` matches the unknown shape too and every field
 * access after it stops compiling.
 *
 * Re-exported (not reimplemented) from the zod-free guards subpath: the engine
 * decides membership against ITS frozen list, so a package that learns a new
 * event type stops calling it unknown here on the same bump.
 */
export { isUnknownEvent, isUnknownPart } from "@zvada/agent-server/protocol/guards";
