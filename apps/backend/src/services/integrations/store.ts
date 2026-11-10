// backend/src/services/integrations/store.ts
// The two product tables behind Apps, Plugins and Skills:
// extension_installations (what is installed, account-wide on this computer)
// and integration_connections (which account or key an app uses). Secrets go
// through the vault; nothing here returns them to a caller outside the
// integrations service.

import { randomUUID } from "crypto";
import { getDatabase } from "../../lib/database";
import type {
  AppTool,
  ConnectionKind,
  ConnectionStatus,
  ConnectionView,
  InstallKind,
  ItemSource,
} from "@shared/integrations/types";
import { open, seal } from "./vault";

export interface InstallationRow {
  kind: InstallKind;
  itemId: string;
  source: ItemSource;
  definition: unknown;
  enabled: boolean;
  /** The user installed it directly, not only through a plugin. */
  explicit: boolean;
  connectionId: string | null;
  /** Skills: the commit on disk. */
  installedRef: string | null;
  /** Skills: installing | ready | error. */
  status: string | null;
  /** A skill's failed install, or what an app's last check could not do. */
  error: string | null;
  /** Apps: how many tools the server listed at its last check (the list is read on demand). */
  toolCount: number | null;
  checkedAt: string | null;
}

interface RawInstallation {
  kind: InstallKind;
  item_id: string;
  definition: string | null;
  enabled: number;
  explicit: number;
  connection_id: string | null;
  installed_ref: string | null;
  status: string | null;
  error: string | null;
  tool_count: number | null;
  checked_at: string | null;
}

/** Everything but the tool list itself, which only an app's page reads. */
const INSTALLATION_COLUMNS = `kind, item_id, definition, enabled, explicit, connection_id,
  installed_ref, status, error, checked_at,
  CASE WHEN tools IS NULL THEN NULL ELSE json_array_length(tools) END AS tool_count`;

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toInstallation(row: RawInstallation): InstallationRow {
  return {
    kind: row.kind,
    itemId: row.item_id,
    // The user's own item is the one that carries its definition.
    source: row.definition ? "custom" : "catalog",
    definition: parseJson(row.definition, null),
    enabled: row.enabled === 1,
    explicit: row.explicit === 1,
    connectionId: row.connection_id,
    installedRef: row.installed_ref,
    status: row.status,
    error: row.error,
    toolCount: row.tool_count,
    checkedAt: row.checked_at,
  };
}

export function listInstallations(kind?: InstallKind): InstallationRow[] {
  const db = getDatabase();
  const rows = (
    kind
      ? db
          .prepare(
            `SELECT ${INSTALLATION_COLUMNS} FROM extension_installations
             WHERE kind = ? ORDER BY created_at, item_id`
          )
          .all(kind)
      : db
          .prepare(
            `SELECT ${INSTALLATION_COLUMNS} FROM extension_installations ORDER BY created_at, item_id`
          )
          .all()
  ) as RawInstallation[];
  return rows.map(toInstallation);
}

export function getInstallation(kind: InstallKind, itemId: string): InstallationRow | null {
  const row = getDatabase()
    .prepare(
      `SELECT ${INSTALLATION_COLUMNS} FROM extension_installations WHERE kind = ? AND item_id = ?`
    )
    .get(kind, itemId) as RawInstallation | undefined;
  return row ? toInstallation(row) : null;
}

export interface InstallationWrite {
  kind: InstallKind;
  itemId: string;
  /** The user's own app or skill; a catalog item has none. */
  definition?: unknown;
  enabled?: boolean;
  explicit?: boolean;
  connectionId?: string | null;
  installedRef?: string | null;
  status?: string | null;
  error?: string | null;
}

const WRITE_COLUMNS: Array<[keyof InstallationWrite, string, (value: unknown) => unknown]> = [
  ["definition", "definition", (v) => (v == null ? null : JSON.stringify(v))],
  ["enabled", "enabled", (v) => (v ? 1 : 0)],
  ["explicit", "explicit", (v) => (v ? 1 : 0)],
  ["connectionId", "connection_id", (v) => v],
  ["installedRef", "installed_ref", (v) => v],
  ["status", "status", (v) => v],
  ["error", "error", (v) => v],
];

/**
 * Insert an installation, or update the fields given on the one that exists.
 * A field left undefined keeps its value (its default on insert).
 */
export function upsertInstallation(write: InstallationWrite): InstallationRow {
  const given = WRITE_COLUMNS.filter(([key]) => write[key] !== undefined);
  const columns = ["kind", "item_id", ...given.map(([, column]) => column)];
  const values = [write.kind, write.itemId, ...given.map(([key, , encode]) => encode(write[key]))];
  const update = given.length
    ? `DO UPDATE SET ${given.map(([, column]) => `${column} = excluded.${column}`).join(", ")}`
    : "DO NOTHING";
  getDatabase()
    .prepare(
      `INSERT INTO extension_installations (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT(kind, item_id) ${update}`
    )
    .run(...values);
  return getInstallation(write.kind, write.itemId)!;
}

export function deleteInstallation(kind: InstallKind, itemId: string): boolean {
  return (
    getDatabase()
      .prepare("DELETE FROM extension_installations WHERE kind = ? AND item_id = ?")
      .run(kind, itemId).changes > 0
  );
}

/** Record what an app's server answered at a check: its tools, or why it could not. */
export function recordAppCheck(
  appId: string,
  result: { tools?: AppTool[]; error: string | null; at: string }
): void {
  const db = getDatabase();
  if (result.tools) {
    db.prepare(
      `UPDATE extension_installations SET tools = ?, error = ?, checked_at = ?
       WHERE kind = 'app' AND item_id = ?`
    ).run(JSON.stringify(result.tools), result.error, result.at, appId);
  } else {
    // A failed check keeps the tools last seen: the server is down, not changed.
    db.prepare(
      `UPDATE extension_installations SET error = ?, checked_at = ?
       WHERE kind = 'app' AND item_id = ?`
    ).run(result.error, result.at, appId);
  }
}

/** The tools an app's server listed at its last check (the app's page reads them). */
export function readAppTools(appId: string): AppTool[] {
  const row = getDatabase()
    .prepare("SELECT tools FROM extension_installations WHERE kind = 'app' AND item_id = ?")
    .get(appId) as { tools: string | null } | undefined;
  const parsed = parseJson<unknown[]>(row?.tools ?? null, []);
  return Array.isArray(parsed)
    ? parsed.filter((tool): tool is AppTool => typeof (tool as AppTool)?.name === "string")
    : [];
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface ConnectionRow {
  id: string;
  appId: string;
  kind: ConnectionKind;
  /** The Deus account whose cloud holds this connection; null when this computer holds it. */
  deusAccountId: string | null;
  label: string | null;
  status: ConnectionStatus;
  lastError: string | null;
}

interface RawConnection {
  id: string;
  app_id: string;
  kind: ConnectionKind;
  deus_account_id: string | null;
  label: string | null;
  status: ConnectionStatus;
  last_error: string | null;
}

const CONNECTION_COLUMNS = "id, app_id, kind, deus_account_id, label, status, last_error";

function toConnection(row: RawConnection): ConnectionRow {
  return {
    id: row.id,
    appId: row.app_id,
    kind: row.kind,
    deusAccountId: row.deus_account_id,
    label: row.label,
    status: row.status,
    lastError: row.last_error,
  };
}

export function toConnectionView(row: ConnectionRow): ConnectionView {
  return { kind: row.kind, label: row.label, status: row.status, lastError: row.lastError };
}

export function listConnections(appId?: string): ConnectionRow[] {
  const db = getDatabase();
  const rows = (
    appId
      ? db
          .prepare(
            `SELECT ${CONNECTION_COLUMNS} FROM integration_connections
             WHERE app_id = ? ORDER BY created_at, id`
          )
          .all(appId)
      : db
          .prepare(
            `SELECT ${CONNECTION_COLUMNS} FROM integration_connections ORDER BY created_at, id`
          )
          .all()
  ) as RawConnection[];
  return rows.map(toConnection);
}

export function getConnection(id: string): ConnectionRow | null {
  const row = getDatabase()
    .prepare(`SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE id = ?`)
    .get(id) as RawConnection | undefined;
  return row ? toConnection(row) : null;
}

export function createConnection(input: {
  appId: string;
  kind: ConnectionKind;
  /** Required for `managed`, and only for it. */
  deusAccountId?: string | null;
  label?: string | null;
  status?: ConnectionStatus;
  credential?: unknown;
}): ConnectionRow {
  const id = randomUUID();
  getDatabase()
    .prepare(
      `INSERT INTO integration_connections
         (id, app_id, kind, deus_account_id, label, status, credential)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.appId,
      input.kind,
      input.deusAccountId ?? null,
      input.label ?? null,
      input.status ?? "pending",
      input.credential === undefined ? null : seal(input.credential)
    );
  return getConnection(id)!;
}

export interface ConnectionUpdate {
  label?: string | null;
  status?: ConnectionStatus;
  lastError?: string | null;
}

/** Update a connection; returns false when it no longer exists. */
export function updateConnection(id: string, update: ConnectionUpdate): boolean {
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (update.label !== undefined) add("label", update.label);
  if (update.status !== undefined) add("status", update.status);
  if (update.lastError !== undefined) add("last_error", update.lastError);
  if (sets.length === 0) return getConnection(id) !== null;
  return (
    getDatabase()
      .prepare(`UPDATE integration_connections SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id).changes > 0
  );
}

/** The connection's sealed credential, opened. Backend-internal only. */
export function readCredential<T>(id: string): T | null {
  const row = getDatabase()
    .prepare("SELECT credential FROM integration_connections WHERE id = ?")
    .get(id) as { credential: string | null } | undefined;
  return open<T>(row?.credential);
}

/** Seal a credential onto a connection; false when the connection is gone (nothing is written). */
export function writeCredential(id: string, credential: unknown): boolean {
  return (
    getDatabase()
      .prepare("UPDATE integration_connections SET credential = ? WHERE id = ?")
      .run(credential === null ? null : seal(credential), id).changes > 0
  );
}

export function deleteConnection(id: string): boolean {
  return (
    getDatabase().prepare("DELETE FROM integration_connections WHERE id = ?").run(id).changes > 0
  );
}
