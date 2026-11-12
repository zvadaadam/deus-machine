/** Sessions: the chats in a workspace, their transcripts, and sending to them. */

import { z } from "zod";
import { AgentHarnessSchema } from "../enums";
import type { PaginatedMessages, Session } from "../types/session";
import { live, out, read, write } from "./op";
import { resumableStream, stream } from "./stream";
import type { CloudSaveFailure } from "../cloud-autosave";
import type { AgentConversationSnapshot } from "../cloud-session-snapshot";
import type { DecodedWireEventEnvelope } from "../protocol-types";
import type { ToolRequestEventData } from "../types/query-protocol";

const sessionId = z.object({ sessionId: z.string().min(1) });
const workspaceId = z.object({ workspaceId: z.string().min(1) });

/** A workspace's chats, oldest first: its tabs. */
export const sessions = live({ name: "sessions", input: workspaceId, output: out<Session[]>() });

/** One chat's facts and status. Null once it has been deleted. */
export const session = live({ name: "session", input: sessionId, output: out<Session | null>() });

/**
 * The latest page of a chat's transcript, or the page before `before` (a
 * message seq). Subscribing does not send a page: it sends the messages
 * written after the subscription began, as deltas.
 */
export const messages = live({
  name: "messages",
  input: sessionId.extend({
    limit: z.number().int().positive().optional(),
    before: z.number().int().positive().optional(),
  }),
  output: out<PaginatedMessages>(),
});

/** Every chat on this computer, hidden ones included. */
export const allSessions = read({ name: "allSessions", output: out<Session[]>() });

/**
 * A short-lived token that lets this client open a cloud chat's own channel
 * to Deus Cloud, without this computer in between.
 */
export const cloudDirectToken = read({
  name: "cloudDirectToken",
  input: sessionId,
  output: out<{
    token: string;
    base_url: string;
    provider_session_id: string;
    /** Seconds. The client asks again before this runs out. */
    expires_in: number;
  }>(),
});

/** Open a new chat in a workspace and make it the workspace's current one. */
export const createSession = write({
  name: "createSession",
  input: workspaceId,
  output: out<Session>(),
});

/**
 * Start a turn. Answers once the agent has admitted it; the prompt and the
 * reply then arrive as the session's events. Refused while a turn is running.
 */
export const sendMessage = write({
  name: "sendMessage",
  input: sessionId.extend({
    content: z.string().min(1),
    model: z.string().min(1),
    agentHarness: AgentHarnessSchema,
    /** The caller's id for this turn: its optimistic bubble and the agent's echo share it. */
    turnId: z.string().min(1).optional(),
    permissionMode: z.string().optional(),
    /** A cloud turn must name one; a local turn uses the model's default without it. */
    thinkingLevel: z.string().optional(),
  }),
  output: out<{ turnId: string }>(),
});

/**
 * Stop the running turn. `unconfirmed` means the stop was sent but the agent
 * has not acknowledged it: the chat stays as it is until its turn really ends.
 */
export const stopSession = write({
  name: "stopSession",
  input: sessionId,
  output: out<{ unconfirmed: boolean }>(),
});

// ---- Streams ----

export type SessionEvent =
  /**
   * One agent event, as the engine sent it. A token delta is delivered but not
   * kept: the part's next event restates what it streamed.
   */
  | { type: "event"; envelope: DecodedWireEventEnvelope }
  /** The whole conversation restated (a cloud chat restored after a reconnect). */
  | { type: "snapshot"; snapshot: AgentConversationSnapshot };

/**
 * A chat's agent events, in order. A client that was away is sent what it
 * missed, or told to read the transcript again when that is no longer held.
 */
export const sessionEvents = resumableStream({
  name: "sessionEvents",
  scope: sessionId,
  event: out<SessionEvent>(),
});

/**
 * A cloud chat's turn ended but its work did not reach the branch. Every
 * client hears it, whichever chats it has open: the warning is about the
 * person's work, not about what is on screen.
 */
export const cloudSaveFailures = stream({
  name: "cloudSaveFailures",
  event: out<CloudSaveFailure>(),
});

export type ToolRequestEvent =
  /** An agent asks a client to do or answer something (approve a plan, show a diff). */
  | { type: "request"; request: ToolRequestEventData }
  /** The agent no longer waits for that answer: drop the prompt. */
  | { type: "cancel"; sessionId: string; requestId: string };

/** What a chat's agent is asking of the people and clients connected to it. */
export const toolRequests = stream({
  name: "toolRequests",
  scope: sessionId,
  event: out<ToolRequestEvent>(),
});
