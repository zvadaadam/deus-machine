// backend/src/services/assistants/sentences.ts
// The sentences assistants are told that more than one layer says: the query
// engine, the registry, the relay and the assistants service. Plain strings,
// no imports, so a core module can say them without pulling in a service.

/** This assistant's access does not allow it yet. */
export const NOT_ALLOWED_YET =
  "This assistant is signed in but not allowed on this computer yet. Ask the person to open Deus on the computer (Settings, Remote access, Assistants) and allow it, then try again.";
/** This assistant may only read. */
export const READ_ONLY =
  "This assistant may only read on this computer. Nothing was done. The person can allow more in Deus: Settings, Remote access, Assistants.";
/** The person denied this assistant. */
export const DENIED = "This assistant was denied on this computer.";
/**
 * A failure that is not a refusal: an assistant is told only this, never the
 * internal text (the query engine for an operation, ./operator.ts for a tool).
 */
export const ASSISTANT_FAILURE =
  "Something went wrong on the computer. Nothing more is known; try again.";
/** An assistant asked for something other than the operator tools. */
export const ASSISTANT_TOOLS_ONLY = "Assistants can use only the session tools";
/** The sign-in service's keys could not be had: not the assistant's fault. */
export const SIGN_IN_UNCHECKED = "This computer could not check the sign-in right now. Try again.";
