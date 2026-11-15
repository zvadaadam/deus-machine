// backend/src/services/assistants/index.ts
// Hosted assistants (ChatGPT, Claude, a CLI agent) that reach this computer
// through the Deus account.
//
// An assistant is not a paired device. Deus Cloud dials this computer through
// the relay for each request and hands over the assistant's own access token;
// this computer verifies it (./token.ts), remembers a first contact as
// `pending`, and the person decides what it may do (`read`, `operate`, or
// `denied`, which keeps it listed and refused). The registry lets an assistant
// ask for the operator tools only (`ASSISTANT_OPERATIONS`); what those tools
// allow is read from its access (./access.ts).

import type { Assistant, AssistantDecision } from "@shared/types/assistants";
import { currentAccountSession } from "../account-session";
import { invalidate } from "../query-engine";
import { closeAssistantConnections, type AssistantAdmission } from "../ws.service";
import { currentHost } from "./access";
import { DENIED } from "./sentences";
import { fallbackName, lookUpLabel, urlHost } from "./label";
import * as store from "./store";
import {
  assistantAddress,
  AssistantRefusedError,
  CLOCK_TOLERANCE_S,
  verifyAssistantToken,
} from "./token";

export { AssistantRefusedError } from "./token";

/** A label lookup that failed or said nothing is tried again on a contact after this long. */
const LABEL_RETRY_MS = 5 * 60_000;

function changed(): void {
  invalidate(["assistants"]);
}

/**
 * Admit an assistant reaching the machine `host` through the relay: verify its
 * token for this computer's address and account, and record the contact.
 * Throws `AssistantRefusedError` with a reason a person can read.
 */
export async function admitAssistant(
  token: string,
  host: store.Host & { cloudUrl: string }
): Promise<AssistantAdmission> {
  const { clientId, exp } = await verifyAssistantToken(token, {
    audience: assistantAddress(host.cloudUrl, host.machineId),
    accountId: host.accountId,
  });
  // One unused for a month is a stranger again (a first contact).
  forgetUnusedAssistants();
  // Denied stays denied: not seen again, not a first contact.
  if (store.findAssistant(host, clientId)?.access === "denied") {
    throw new AssistantRefusedError(DENIED);
  }
  const { assistant, first } = store.recordContact(host, clientId, {
    name: fallbackName(clientId),
    host: urlHost(clientId),
  });
  // An open window shows a first contact at once, so the person can decide.
  if (first) {
    // A stranger again (forgotten, or removed earlier): its label is asked for anew.
    labels.delete(labelKey(host, clientId));
    changed();
  }
  if (wantsLabel(host, clientId)) void labelAssistant(host, clientId);
  return {
    assistant: {
      clientId,
      access: assistant.access,
      host: { accountId: host.accountId, machineId: host.machineId },
    },
    signInEndsAt: (exp + CLOCK_TOLERANCE_S) * 1000,
  };
}

/** Per assistant: when its label was last asked for, and whether Deus Cloud answered. */
const labels = new Map<string, { at: number; known: boolean }>();
const labelKey = (host: store.Host, clientId: string) =>
  `${host.accountId}\0${host.machineId}\0${clientId}`;

function wantsLabel(host: store.Host, clientId: string, now = Date.now()): boolean {
  const asked = labels.get(labelKey(host, clientId));
  return !asked || (!asked.known && now - asked.at >= LABEL_RETRY_MS);
}

/**
 * Ask Deus Cloud what the assistant is called and where it signs in from.
 * Never holds up admission; one that fails or says nothing is asked again on a
 * later contact, at most every few minutes.
 */
async function labelAssistant(host: store.Host, clientId: string): Promise<void> {
  const session = currentAccountSession();
  if (session?.accountId !== host.accountId) return;
  const key = labelKey(host, clientId);
  labels.set(key, { at: Date.now(), known: false });
  const label = await lookUpLabel(session, clientId);
  if (!label) return;
  try {
    const saved = store.saveLabel(host, clientId, {
      name: label.name ?? fallbackName(clientId),
      // A URL-shaped client id names its host itself.
      host: label.host ?? urlHost(clientId),
    });
    // Known once saved: a save that failed is tried again on a later contact.
    labels.set(key, { at: Date.now(), known: true });
    if (saved) changed();
  } catch (error) {
    console.warn("[Assistants] Could not save an assistant's name:", error);
  }
}

/**
 * Forget the assistants that have not connected for a month (a denied one is
 * kept). Done at startup and at admission, never on a timer; the list leaves
 * them out meanwhile (`store.listAssistants`), so none is shown past its month.
 */
export function forgetUnusedAssistants(): void {
  const forgotten = store.forgetUnused();
  if (!forgotten) return;
  console.log(`[Assistants] Forgot ${forgotten} assistant(s) unused for 30 days`);
  changed();
}

/** The assistants that reached this computer under the signed-in account. A pure read. */
export function listAssistants(): Assistant[] {
  const host = currentHost();
  return host ? store.listAssistants(host) : [];
}

/** Returns whether the assistant exists. Its open connections end at once. */
export function setAssistantAccess(clientId: string, access: AssistantDecision): boolean {
  const host = currentHost();
  if (!host || !store.saveAccess(host, clientId, access)) return false;
  closeAssistantConnections(clientId);
  changed();
  return true;
}

/** Returns whether the assistant existed. Its open connections end at once. */
export function removeAssistant(clientId: string): boolean {
  const host = currentHost();
  const removed = host !== null && store.deleteAssistant(host, clientId);
  closeAssistantConnections(clientId);
  if (removed) {
    labels.delete(labelKey(host, clientId));
    changed();
  }
  return removed;
}

/** Tests only: forget which labels were asked for. */
export function _resetLabels(): void {
  labels.clear();
}
