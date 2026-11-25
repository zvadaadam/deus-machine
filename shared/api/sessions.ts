/** Sessions: the chats in a workspace, their transcripts, and sending to them. */

import { z } from "zod";
import { AgentHarnessSchema } from "../enums";
import type { PaginatedMessages, Session } from "../types/session";
import { live, out, read, write } from "./op";
import { resumableStream, stream } from "./stream";
import type { CloudSaveFailure } from "../cloud-autosave";
import type { AgentConversationSnapshot } from "../cloud-session-snapshot";
import type { DecodedWireEventEnvelope } from "../protocol-types";
import type { Origin } from "@zvada/agent-server/protocol";
import type { ToolRequestEventData } from "../types/query-protocol";

const sessionId = z.object({ sessionId: z.string().min(1) });
const workspaceId = z.object({ workspaceId: z.string().min(1) });

/** A workspace's chats, oldest first: its tabs. */
export const sessions = live({ name: "sessions", input: workspaceId, output: out<Session[]>() });

/** One chat's facts and status. Null once it has been deleted. */
export const session = live({ name: "session", input: sessionId, output: out<Session | null>() });

/**
 * The latest page of a chat's transcript, or the page before `before` (a
 * message seq). What happens to the chat afterwards arrives on `sessionEvents`.
 */
export const messages = read({
  name: "messages",
  input: sessionId.extend({
    limit: z.number().int().positive().optional(),
    before: z.number().int().positive().optional(),
  }),
  output: out<PaginatedMessages>(),
});

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

/** Start a turn, or hold the message for the next turn in a busy local chat. */
export const sendMessage = write({
  name: "sendMessage",
  input: sessionId.extend({
    content: z.string().min(1),
    /** The bare model id (`opus`), not the picker's `claude-code:opus`: the harness is `agentHarness`. */
    model: z.string().min(1),
    agentHarness: AgentHarnessSchema,
    /** The caller's id for this turn: its optimistic bubble and the agent's echo share it. */
    turnId: z.string().min(1).optional(),
    permissionMode: z.string().optional(),
    /** A cloud turn must name one; a local turn uses the model's default without it. */
    thinkingLevel: z.string().optional(),
  }),
  output: out<{ turnId: string; queued?: true }>(),
});

export type QueuedMessages = {
  paused: "stopped" | "failed" | "limit" | null;
  /** The provider's reset time in epoch milliseconds, when known. */
  limit?: { resetsAt?: number; continues: boolean };
  items: {
    id: string;
    text: string;
    images: number;
    state: "sending" | "steering" | "waiting";
    origin?: Origin;
  }[];
};

/** A local chat's sending head, unread steers and waiting messages, held in this process. */
export const queuedMessages = live({
  name: "queuedMessages",
  input: sessionId,
  output: out<QueuedMessages>(),
});

const queuedMessageId = sessionId.extend({ id: z.string().min(1) });

/** Full composer content, available while the row is waiting. */
export const queuedMessage = read({
  name: "queuedMessage",
  input: queuedMessageId,
  output: out<{ content: string | null }>(),
});

const steerTarget = {
  /** The turn this client shows as running. */
  turnId: z.string().min(1).optional(),
};

export const steerMessage = write({
  name: "steerMessage",
  input: sendMessage.input.extend(steerTarget),
  output: out<{ outcome: "steered" | "queued" | "sent" | "unconfirmed" }>(),
});

export const steerQueuedMessage = write({
  name: "steerQueuedMessage",
  input: queuedMessageId.extend(steerTarget),
  output: out<{ outcome: "steered" | "queued" | "gone" | "unconfirmed" }>(),
});

/** Move a waiting row before another waiting row, or to the end with `before: null`. */
export const moveQueuedMessage = write({
  name: "moveQueuedMessage",
  input: queuedMessageId.extend({ before: z.string().min(1).nullable() }),
  output: out<{ moved: boolean }>(),
});

export const removeQueuedMessage = write({
  name: "removeQueuedMessage",
  input: queuedMessageId,
  output: out<{ removed: boolean }>(),
});

export const resumeQueuedMessages = write({
  name: "resumeQueuedMessages",
  input: sessionId,
  output: out<Record<string, never>>(),
});

/** Schedule the local chat for one minute after its reset, continue now if it has reset, or cancel. */
export const continueAfterLimit = write({
  name: "continueAfterLimit",
  input: sessionId.extend({ on: z.boolean() }),
  output: out<Record<string, never>>(),
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
  /** A new subscription opens with the IDs the host still waits on. */
  | { type: "pending"; requestIds: string[] }
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
