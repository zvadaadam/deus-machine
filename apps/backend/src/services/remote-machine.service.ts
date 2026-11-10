// backend/src/services/remote-machine.service.ts
// This computer's registration with Deus Cloud, one per signed-in account.
//
// Deus Cloud lists the account's computers and signs the one-use tickets the
// relay admits (AGNT `apps/deus-cloud/src/routes/machines.ts`). Hosting a
// machine needs both a desktop session and the secret this computer generated
// when it registered, so an account session alone cannot take over its tunnel.
// The secret is kept in the private `relay_machines` setting (never served by
// the settings API) and sent only to Deus Cloud.

import { randomBytes } from "crypto";
import { currentAccountSession, type AccountSession } from "./account-session";
import { getSetting, removeSettings, saveSetting } from "./settings.service";

// The tunnel follows this session; its callers read it from here.
export { currentAccountSession };

interface MachineRecord {
  machineId: string;
  secret: string;
  /** The account removed this computer; kept so a restart does not quietly re-add it. */
  removed?: true;
}

/** The account removed this computer: it stays off until remote access is turned on again. */
export class MachineRemovedError extends Error {
  constructor() {
    super(
      "This computer was removed from your Deus account. Turn remote access on to add it again."
    );
    this.name = "MachineRemovedError";
  }
}

export class CloudRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "CloudRequestError";
  }
}

const RECORDS_SETTING = "relay_machines";
/** The pre-account relay identity: a self-chosen server id and its bearer token. */
const LEGACY_RELAY_SETTINGS = ["relay_server_id", "relay_token"] as const;

/** The relay no longer accepts the pre-account credentials; drop them from disk. */
export function retireLegacyRelayCredentials(): void {
  if (removeSettings(LEGACY_RELAY_SETTINGS)) {
    console.log("[Relay] Removed the pre-account relay credentials");
  }
}
const CLOUD_TIMEOUT_MS = 15_000;

function records(): Record<string, MachineRecord> {
  const stored = getSetting(RECORDS_SETTING) as unknown;
  return stored && typeof stored === "object" ? (stored as Record<string, MachineRecord>) : {};
}

function saveRecord(accountId: string, record: MachineRecord | null): void {
  const next = { ...records() };
  if (record) next[accountId] = record;
  else delete next[accountId];
  saveSetting(RECORDS_SETTING, next);
}

/** The machine id this computer uses for an account, if it registered one. */
export function getMachineId(accountId: string): string | null {
  const record = records()[accountId];
  return record && !record.removed ? record.machineId : null;
}

export function isMachineRemoved(accountId: string): boolean {
  return records()[accountId]?.removed === true;
}

/** The user turned remote access on again: the next dial registers a new machine. */
export function forgetRemovedMachine(accountId: string): void {
  if (isMachineRemoved(accountId)) saveRecord(accountId, null);
}

async function cloud<T>(
  session: AccountSession,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<T> {
  const response = await fetch(`${session.cloudUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(CLOUD_TIMEOUT_MS)]),
  });
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: string; message?: string })
    | null;
  if (!response.ok) {
    throw new CloudRequestError(
      response.status,
      data?.message ?? `Deus Cloud answered ${response.status}`,
      data?.error
    );
  }
  if (!data) throw new CloudRequestError(response.status, "Deus Cloud sent an empty answer");
  return data;
}

async function register(
  session: AccountSession,
  name: string,
  signal: AbortSignal
): Promise<MachineRecord> {
  const secret = randomBytes(32).toString("base64url");
  const { machine } = await cloud<{ machine: { id: string } }>(
    session,
    "/me/machines",
    { name, secret },
    signal
  );
  const record = { machineId: machine.id, secret };
  saveRecord(session.accountId, record);
  return record;
}

/**
 * A ticket to host this computer's tunnel, registering the computer when the
 * account has no record of it yet. A stored machine Deus Cloud no longer knows
 * was removed from the account: that is final until the user turns remote
 * access on again (`forgetRemovedMachine`), so it is marked removed and
 * MachineRemovedError thrown instead of quietly registering a new machine. A
 * secret mismatch means the local record is broken: register again, once.
 */
export async function obtainHostTicket(
  session: AccountSession,
  name: string,
  signal: AbortSignal
): Promise<{ machineId: string; ticket: string }> {
  // Deus Cloud keeps names to 80 characters.
  name = name.trim().slice(0, 80) || "Deus computer";
  let record: MachineRecord | null = records()[session.accountId] ?? null;
  if (record?.removed) throw new MachineRemovedError();
  for (let attempt = 0; ; attempt += 1) {
    const stored = record !== null;
    record ??= await register(session, name, signal);
    try {
      const { ticket } = await cloud<{ ticket: string }>(
        session,
        `/me/machines/${record.machineId}/tickets`,
        { role: "host", secret: record.secret, name },
        signal
      );
      return { machineId: record.machineId, ticket };
    } catch (error) {
      if (!(error instanceof CloudRequestError)) throw error;
      if (error.status === 404 && stored) {
        saveRecord(session.accountId, { ...record, removed: true });
        throw new MachineRemovedError();
      }
      if (error.code !== "MACHINE_SECRET_MISMATCH" || attempt > 0) throw error;
      saveRecord(session.accountId, null);
      record = null;
    }
  }
}
