// backend/src/services/integrations/accounts.ts
// An app's account rows: which one the app uses, and what forgetting one
// means. The rules:
//
//  - An app uses one account. A new sign-in replaces it only once it lands,
//    so the old one keeps working until then.
//  - An account never outlives its app: removing an app forgets its account,
//    so no credential stays where no view shows it. Signing out forgets the
//    account and keeps the app.
//  - An account Deus Cloud holds is forgotten there first: its row stays,
//    off its app, until Deus Cloud says the account is gone.

import { cloudAccountId, disconnectCloudAccount, forgetCloudAttempts } from "./auth/cloud-accounts";
import { forgetOAuth } from "./auth/mcp-oauth";
import { integrationsChanged } from "./events";
import {
  deleteConnection,
  getConnection,
  getInstallation,
  listConnections,
  updateConnection,
  upsertInstallation,
  type ConnectionRow,
} from "./store";

/**
 * Make `connectionId` the account an app uses, and forget the ones it
 * replaces. Installs the app if it is not (a sign-in that lands after its
 * app was removed puts it back).
 */
export function attachConnection(appId: string, connectionId: string): void {
  // Connecting an account is the user's own act: the app is theirs from here.
  upsertInstallation({ kind: "app", itemId: appId, connectionId, explicit: true });
  const attached = getConnection(connectionId) ?? undefined;
  for (const old of listConnections(appId)) {
    if (old.id !== connectionId) forgetConnection(old, attached);
  }
  integrationsChanged();
}

/**
 * Forget one account: here, and in Deus Cloud when it holds it. Deus Cloud
 * keeps one connection per Deus account and app, so a row that `replacedBy`
 * stands for the same one is dropped here only, and so is a row another Deus
 * account left (it stays that account's).
 */
export function forgetConnection(connection: ConnectionRow, replacedBy?: ConnectionRow): void {
  forgetOAuth(connection.id);
  if (connection.kind === "managed") {
    forgetCloudAttempts(connection.id);
    const sameCloudAccount =
      replacedBy?.kind === "managed" && replacedBy.deusAccountId === connection.deusAccountId;
    const signedIn = cloudAccountId();
    if (!sameCloudAccount && (signedIn === null || signedIn === connection.deusAccountId)) {
      // The row leaves its app and waits as `removing` until Deus Cloud has
      // disconnected the account: now when its Deus account is signed in,
      // else when it next is (cloud-apps.ts). A request that fails is asked
      // again then, so the account does not outlive the app.
      const install = getInstallation("app", connection.appId);
      if (install?.connectionId === connection.id) {
        upsertInstallation({ kind: "app", itemId: connection.appId, connectionId: null });
      }
      updateConnection(connection.id, { status: "removing" });
      if (signedIn) void finishRemoval(connection);
      return;
    }
  }
  deleteConnection(connection.id);
}

/** Removals under way, by row: a second request for one shares it. */
const removals = new Map<string, Promise<void>>();

/**
 * Disconnect a `removing` row's account in Deus Cloud; the row goes once
 * that is confirmed. One request per row at a time, so whoever needs the
 * account gone first (a new sign-in for the same app) can wait for this one.
 */
export function finishRemoval(row: ConnectionRow): Promise<void> {
  const under = removals.get(row.id);
  if (under) return under;
  const removal = disconnectCloudAccount(row)
    .then((gone) => {
      if (gone) deleteConnection(row.id);
    })
    .finally(() => removals.delete(row.id));
  removals.set(row.id, removal);
  return removal;
}

/** Forget every account of an app. */
export function forgetAccounts(appId: string): void {
  for (const connection of listConnections(appId)) forgetConnection(connection);
}
