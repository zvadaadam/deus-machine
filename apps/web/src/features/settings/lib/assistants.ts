/**
 * Hosted assistants as the Remote access page shows them: who is waiting comes
 * first, and each request to connect is announced once while the app is open.
 */

import type { Assistant, AssistantAccess, AssistantDecision } from "@shared/types/assistants";

const RANK: Record<AssistantAccess, number> = { pending: 0, read: 1, operate: 1, denied: 2 };

/**
 * Waiting assistants first (newest request on top), then the allowed ones by
 * latest use, then the denied ones, also by latest use.
 */
export function sortAssistants(assistants: readonly Assistant[]): Assistant[] {
  return [...assistants].sort((a, b) => {
    const rank = RANK[a.access] - RANK[b.access];
    if (rank !== 0) return rank;
    if (a.access === "pending") return b.createdAt - a.createdAt;
    return b.lastSeenAt - a.lastSeenAt;
  });
}

/** The access a person allows an assistant: every decision but denying it. */
export type AllowedAccess = Exclude<AssistantDecision, "denied">;

export const ACCESS_CHOICES: {
  value: AllowedAccess;
  label: string;
  description: string;
}[] = [
  { value: "read", label: "Read only", description: "See workspaces, conversations and changes." },
  {
    value: "operate",
    label: "Operate",
    description: "Also start work, send messages, answer and stop agents.",
  },
];

export function accessLabel(access: AssistantAccess): string {
  if (access === "denied") return "Denied";
  return ACCESS_CHOICES.find((choice) => choice.value === access)?.label ?? "Waiting";
}

/** Shortens a long id in the middle, keeping both ends readable: `abcdefgh…uvwxyz`. */
export function shortenMiddle(value: string, max = 20): string {
  if (value.length <= max) return value;
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * What tells an assistant apart, since it picks its own name: where its
 * sign-in returns to, or, until that is known, its client id (shortened).
 * `lead` is the words a waiting one's line puts first ("Signs in through",
 * "Unverified"), so the row and the toast say it alike.
 */
export function assistantOrigin(
  assistant: Pick<Assistant, "clientId" | "host">
): { host: string; lead: string } | { clientId: string; lead: string } {
  return assistant.host
    ? { host: assistant.host, lead: "Signs in through" }
    : { clientId: shortenMiddle(assistant.clientId), lead: "Unverified" };
}

/**
 * A waiting assistant's toast text: where it signs in, in the row's words
 * (its name is its own choice), then what allowing it means.
 */
export function arrivalDescription(assistant: Pick<Assistant, "clientId" | "host">): string {
  const origin = assistantOrigin(assistant);
  const where = "host" in origin ? origin.host : origin.clientId;
  return `${origin.lead} ${where}. Allow it to see your workspaces and work with your agents.`;
}

/**
 * One request to connect: an assistant that was removed and asks again is a
 * new first contact, with a new `createdAt`, so a new request.
 */
export function requestKey(assistant: Pick<Assistant, "clientId" | "createdAt">): string {
  return `${assistant.clientId}:${assistant.createdAt}`;
}

/**
 * Decides which waiting assistants to announce. The first list it sees is what
 * was already waiting when the app opened: those are not announced. After that,
 * each request is announced the first time it is seen waiting, and never again
 * while the app stays open. Denied and allowed assistants are never announced.
 */
export function createArrivalTracker() {
  const seen = new Set<string>();
  let ready = false;
  return (assistants: readonly Assistant[]): Assistant[] => {
    const waiting = assistants.filter((assistant) => assistant.access === "pending");
    const arrived = ready ? waiting.filter((assistant) => !seen.has(requestKey(assistant))) : [];
    for (const assistant of waiting) seen.add(requestKey(assistant));
    ready = true;
    return arrived;
  };
}

export function waitingCount(assistants: readonly Assistant[] | undefined): number {
  return assistants?.filter((assistant) => assistant.access === "pending").length ?? 0;
}

/** What the Add assistant dialog shows. */
export type AddAssistantState = "address" | "loading" | "sign_in" | "turn_on" | "retry";

/**
 * The computer's address whenever it has one, whatever this browser's own
 * session says: a browser on this computer or its network may be signed out
 * while the computer is signed in and its relay connected. Only without an
 * address does the dialog say what is missing.
 */
export function addAssistantState({
  address,
  signedOut,
  remoteAccessOn,
}: {
  /** `relayStatus.assistantUrl`: null when there is none, undefined while it is read. */
  address: string | null | undefined;
  signedOut: boolean;
  remoteAccessOn: boolean;
}): AddAssistantState {
  if (address) return "address";
  if (remoteAccessOn && address === undefined) return "loading";
  if (signedOut) return "sign_in";
  if (!remoteAccessOn) return "turn_on";
  return "retry";
}

/**
 * Watches who waits while the Add assistant dialog is open, to tell when the
 * assistant the person is connecting has arrived. Give it the waiting ids at
 * each change, or `undefined` while the list has not loaded. The first loaded
 * list is the baseline (those were waiting already); it answers true once an
 * id outside the baseline waits. A dialog opened before the list loaded takes
 * its baseline from the first list, so one already waiting does not close it.
 */
export function createDialogArrivalWatch() {
  let baseline: Set<string> | null = null;
  return (waiting: readonly string[] | undefined): boolean => {
    if (!waiting) return false;
    if (!baseline) {
      baseline = new Set(waiting);
      return false;
    }
    return waiting.some((id) => !baseline!.has(id));
  };
}

/** What a screen reader is told about the assistants waiting for approval. */
export function waitingAnnouncement(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? "1 assistant is waiting for your approval."
    : `${count} assistants are waiting for your approval.`;
}
