// backend/src/services/integrations/checks.ts
// Check: reach an app's server the way a turn will, and list its tools
// ("Ready · 24 tools"). What the server listed is kept on the app's row; its
// page reads the list on demand.

import { getErrorMessage } from "@shared/lib/errors";
import { cloudAccountConnected } from "./auth/cloud-accounts";
import { findApp } from "./catalog";
import { credentialsFor } from "./credentials";
import { integrationsChanged, markNeedsReauth } from "./events";
import { probeServer } from "./probe";
import { directServer } from "./runtime";
import { getConnection, getInstallation, recordAppCheck } from "./store";

const checksInFlight = new Map<string, Promise<void>>();

/**
 * Reach an app's server with its account and list its tools. A server that
 * refuses the account twice, the second time with a fresh credential, marks
 * it for a new sign-in.
 */
export function checkApp(appId: string): Promise<void> {
  const inFlight = checksInFlight.get(appId);
  if (inFlight) return inFlight;
  const run = runCheck(appId)
    .catch((error) => console.warn(`[Integrations] Checking ${appId} failed:`, error))
    .finally(() => {
      if (checksInFlight.get(appId) === run) checksInFlight.delete(appId);
    });
  checksInFlight.set(appId, run);
  return run;
}

async function runCheck(appId: string): Promise<void> {
  const app = findApp(appId);
  const row = getInstallation("app", appId);
  if (!app || !row) return;
  const at = new Date().toISOString();

  for (const fresh of [false, true]) {
    const connection = row.connectionId ? getConnection(row.connectionId) : null;
    const credentials = await credentialsFor(app, connection, { fresh });
    if (!credentials.ok) {
      if (credentials.reauth && connection?.status === "active") {
        markNeedsReauth(connection.id, credentials.reason);
      }
      recordAppCheck(appId, { error: credentials.reason, at });
      break;
    }
    const held = connection?.kind === "managed" ? connection : null;
    if (held) {
      // A broker's server lists its tools whether or not the account behind
      // them still stands (revoked at the vendor, expired): ask Deus Cloud.
      // If Deus Cloud cannot be asked (the Deus session expired, no network),
      // that is not the app's sign-in to redo.
      let connected: boolean;
      try {
        connected = await cloudAccountConnected(held);
      } catch (error) {
        recordAppCheck(appId, { error: getErrorMessage(error), at });
        break;
      }
      if (!connected) {
        const reason = `${app.name} is no longer signed in`;
        markNeedsReauth(held.id, reason);
        recordAppCheck(appId, { error: reason, at });
        break;
      }
    }
    const result = await probeServer(credentials.cloud ?? directServer(app, credentials));
    if (result.ok) {
      recordAppCheck(appId, { tools: result.tools, error: null, at });
      break;
    }
    // Deus Cloud refusing the Deus session says nothing about the app's account.
    if (!result.unauthorized || !connection || held) {
      recordAppCheck(appId, { error: result.error, at });
      break;
    }
    if (fresh) {
      markNeedsReauth(connection.id, "Its server refused the saved sign-in");
      recordAppCheck(appId, { error: result.error, at });
    }
  }
  integrationsChanged();
}

/** @internal Wait for the checks under way (tests). */
export async function settleChecks(): Promise<void> {
  await Promise.allSettled([...checksInFlight.values()]);
}
