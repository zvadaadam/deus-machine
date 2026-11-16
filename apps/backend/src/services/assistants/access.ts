// backend/src/services/assistants/access.ts
// What an assistant may do on this computer, as stored now, and which of the
// refusals (./sentences.ts) it gets when it may not. A connection carries the access it was admitted with; a
// write reads it again here just before it happens (./host.ts), because a
// held call can outlive the person's change of mind.

import type { AssistantAccess } from "@shared/types/assistants";
import type { AdmittedAssistant, Caller } from "../../api/registry";
import { AppError } from "../../lib/errors";
import { currentAccountSession } from "../account-session";
import { getMachineId } from "../remote-machine.service";
import { DENIED, NOT_ALLOWED_YET, READ_ONLY } from "./sentences";
import * as store from "./store";

/** The account the desktop is signed in to and this computer's machine id in it. */
export function currentHost(): store.Host | null {
  const session = currentAccountSession();
  const machineId = session && getMachineId(session.accountId);
  return session && machineId ? { accountId: session.accountId, machineId } : null;
}

/**
 * The access stored for this assistant now, under the account and machine it
 * was admitted for; null when it is not known (removed), or when this computer
 * now hosts another account (whose approvals are not its).
 */
export function storedAccess(assistant: AdmittedAssistant): AssistantAccess | null {
  const host = currentHost();
  const same =
    host?.accountId === assistant.host.accountId && host.machineId === assistant.host.machineId;
  return (same && store.findAssistant(host, assistant.clientId)?.access) || null;
}

/** The refusal for an assistant whose access does not allow `wanted`, or null when it does. */
export function refusalFor(
  access: AssistantAccess | null,
  wanted: "read" | "operate"
): string | null {
  if (access === "operate" || (access === "read" && wanted === "read")) return null;
  if (access === "denied") return DENIED;
  if (access === "read") return READ_ONLY;
  return NOT_ALLOWED_YET;
}

/**
 * Throws the refusal when `caller` is an assistant no longer allowed to
 * operate. Called just before every write an assistant's call makes.
 */
export function assertMayWrite(caller: Caller): void {
  if (!caller.assistant) return;
  const refusal = refusalFor(storedAccess(caller.assistant), "operate");
  if (refusal) throw new AppError(403, refusal);
}
