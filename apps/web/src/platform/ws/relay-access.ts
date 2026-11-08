/**
 * Relay access for a browser: the Deus account it is signed in to, and the
 * one-use Deus Cloud tickets the relay admits. The relay serves a computer
 * only to its own account, and that computer still checks its own device
 * grant; this module provides the account half.
 */
import { RELAY_PROTOCOL } from "@shared/types/relay";
import { resolveDeusCloudUrl } from "@/features/session/cloud/webCloudDirectConfig";
import { CLOUD_SESSION_KEY, type RelayAccount } from "./cloud-session";
import { notifyAuthChange } from "./device-auth";

export { readRelayAccount, type RelayAccount } from "./cloud-session";

/** expired: sign in again · not_found/refused: final for this computer · unavailable: retry. */
export type RelayTicketFailure = "expired" | "not_found" | "refused" | "unavailable";

export class RelayTicketError extends Error {
  constructor(
    readonly kind: RelayTicketFailure,
    message: string
  ) {
    super(message);
    this.name = "RelayTicketError";
  }
}

const unavailable = new Set<string>();
const availabilityListeners = new Set<() => void>();
const availabilityKey = (accountId: string, machineId: string) =>
  JSON.stringify([accountId, machineId]);

/** Deus Cloud says this account has no such computer: stop dialing and say so. */
export function markMachineUnavailable(accountId: string, machineId: string): void {
  const key = availabilityKey(accountId, machineId);
  if (unavailable.has(key)) return;
  unavailable.add(key);
  for (const listener of availabilityListeners) listener();
}

export function isMachineUnavailable(accountId: string, machineId: string): boolean {
  return unavailable.has(availabilityKey(accountId, machineId));
}

/** Try the computer again, e.g. after the user asked to. */
export function clearMachineUnavailable(accountId: string, machineId: string): void {
  if (!unavailable.delete(availabilityKey(accountId, machineId))) return;
  for (const listener of availabilityListeners) listener();
}

export function onMachineAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener);
  return () => {
    availabilityListeners.delete(listener);
  };
}

/** Drop a session Deus Cloud refused, unless another sign-in already replaced it. */
export function expireRelayAccount(account: RelayAccount): void {
  try {
    if (sessionStorage.getItem(CLOUD_SESSION_KEY) !== account.bearer) return;
    sessionStorage.removeItem(CLOUD_SESSION_KEY);
  } catch {
    return;
  }
  notifyAuthChange();
}

async function cloud<T>(
  account: RelayAccount,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${resolveDeusCloudUrl()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${account.bearer}`, "content-type": "application/json" },
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    });
  } catch {
    throw new RelayTicketError("unavailable", "Deus Cloud is unreachable. Check your connection.");
  }
  const data = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
  if (response.status === 401) {
    throw new RelayTicketError("expired", "Your Deus session expired. Sign in again.");
  }
  if (response.status === 404) {
    throw new RelayTicketError("not_found", "This computer is not connected to your account.");
  }
  if (response.status === 400 || response.status === 403) {
    throw new RelayTicketError("refused", data?.message ?? "Deus Cloud refused this request.");
  }
  if (!response.ok || !data) {
    throw new RelayTicketError("unavailable", data?.message ?? "Deus Cloud is unavailable.");
  }
  return data;
}

/** A one-use ticket to open one socket to this computer through the relay. */
export async function fetchRelayTicket(
  account: RelayAccount,
  machineId: string,
  signal?: AbortSignal
): Promise<string> {
  const { ticket } = await cloud<{ ticket: string }>(
    account,
    `/me/machines/${encodeURIComponent(machineId)}/tickets`,
    { method: "POST", body: JSON.stringify({ role: "client" }) },
    signal
  );
  return ticket;
}

/** A short, comparable form of a machine id, shown beside its name ("0123 4567"). */
export function machineFingerprint(machineId: string): string {
  return `${machineId.slice(0, 4)} ${machineId.slice(4, 8)}`;
}

/** The WebSocket subprotocols that carry a ticket; the relay echoes the first. */
export function relayProtocols(ticket: string): string[] {
  return [RELAY_PROTOCOL, ticket];
}

export interface RemoteMachine {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
}

/** The computers this account registered for remote access. */
export async function listMachines(account: RelayAccount): Promise<RemoteMachine[]> {
  return (await cloud<{ items: RemoteMachine[] }>(account, "/me/machines")).items;
}

export async function removeMachine(account: RelayAccount, machineId: string): Promise<void> {
  await cloud(account, `/me/machines/${encodeURIComponent(machineId)}`, { method: "DELETE" });
}
