// backend/src/services/assistants/store.ts
// The `assistants` table: who reached this computer, and what the person allowed.
// Rows belong to one account and one machine id in it (`Host`): an assistant
// allowed under one account is a stranger under another.

import type { Assistant, AssistantAccess } from "@shared/types/assistants";
import { getDatabase } from "../../lib/database";

/** The account this computer serves and its machine id in that account. */
export interface Host {
  accountId: string;
  machineId: string;
}

/** `last_seen_at` is written at most this often per assistant: every call is a contact. */
const SEEN_EVERY_MS = 60_000;
/** An assistant not seen for this long is forgotten, unless it was denied. */
const UNUSED_FOR_MS = 30 * 24 * 60 * 60_000;

interface Row {
  client_id: string;
  name: string;
  host: string | null;
  access: AssistantAccess;
  created_at: number;
  last_seen_at: number;
}

const COLUMNS = "client_id, name, host, access, created_at, last_seen_at";
/** Past its month (`forgetUnused` deletes these): no longer listed. */
const UNUSED = "access != 'denied' AND last_seen_at < ?";
const WHERE_ONE = "client_id = ? AND account_id = ? AND machine_id = ?";

function toAssistant(row: Row): Assistant {
  return {
    clientId: row.client_id,
    name: row.name,
    host: row.host,
    access: row.access,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Newest first, leaving out the ones past their month that are not deleted yet. */
export function listAssistants(host: Host, now = Date.now()): Assistant[] {
  const rows = getDatabase()
    .prepare(
      `SELECT ${COLUMNS} FROM assistants
       WHERE account_id = ? AND machine_id = ? AND NOT (${UNUSED})
       ORDER BY created_at DESC`
    )
    .all(host.accountId, host.machineId, now - UNUSED_FOR_MS) as Row[];
  return rows.map(toAssistant);
}

export function findAssistant(host: Host, clientId: string): Assistant | undefined {
  const row = getDatabase()
    .prepare(`SELECT ${COLUMNS} FROM assistants WHERE ${WHERE_ONE}`)
    .get(clientId, host.accountId, host.machineId) as Row | undefined;
  return row && toAssistant(row);
}

/**
 * An assistant connected. A first contact is remembered as `pending` under
 * `label`; a known one is only marked seen, at most once a minute.
 */
export function recordContact(
  host: Host,
  clientId: string,
  label: { name: string; host: string | null },
  now = Date.now()
): { assistant: Assistant; first: boolean } {
  const db = getDatabase();
  const first =
    db
      .prepare(
        `INSERT OR IGNORE INTO assistants
           (client_id, account_id, machine_id, name, host, access, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(clientId, host.accountId, host.machineId, label.name, label.host, now, now).changes > 0;
  if (!first) {
    db.prepare(
      `UPDATE assistants SET last_seen_at = ? WHERE ${WHERE_ONE} AND last_seen_at <= ?`
    ).run(now, clientId, host.accountId, host.machineId, now - SEEN_EVERY_MS);
  }
  const assistant = findAssistant(host, clientId);
  if (!assistant) throw new Error(`Assistant ${clientId} was not recorded`);
  return { assistant, first };
}

/** Returns whether the assistant exists. (`denied` keeps the row: it is refused, not forgotten.) */
export function saveAccess(host: Host, clientId: string, access: AssistantAccess): boolean {
  return (
    getDatabase()
      .prepare(`UPDATE assistants SET access = ? WHERE ${WHERE_ONE}`)
      .run(access, clientId, host.accountId, host.machineId).changes > 0
  );
}

/** What it is called and where it signs in from. Returns whether either changed. */
export function saveLabel(
  host: Host,
  clientId: string,
  label: { name: string; host: string | null }
): boolean {
  return (
    getDatabase()
      .prepare(
        `UPDATE assistants SET name = ?, host = ?
         WHERE ${WHERE_ONE} AND (name IS NOT ? OR host IS NOT ?)`
      )
      .run(label.name, label.host, clientId, host.accountId, host.machineId, label.name, label.host)
      .changes > 0
  );
}

/**
 * Forget every assistant (any account) not seen for `UNUSED_FOR_MS`; a denied
 * one stays, so it is still refused. A client that registers itself anew at
 * each sign-in leaves no allowed entries behind. Returns how many went.
 */
export function forgetUnused(now = Date.now()): number {
  return getDatabase()
    .prepare(`DELETE FROM assistants WHERE ${UNUSED}`)
    .run(now - UNUSED_FOR_MS).changes;
}

/** Returns whether a row was deleted. */
export function deleteAssistant(host: Host, clientId: string): boolean {
  return (
    getDatabase()
      .prepare(`DELETE FROM assistants WHERE ${WHERE_ONE}`)
      .run(clientId, host.accountId, host.machineId).changes > 0
  );
}
