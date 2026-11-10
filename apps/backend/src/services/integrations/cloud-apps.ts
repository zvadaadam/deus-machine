// backend/src/services/integrations/cloud-apps.ts
// Apps connected through the person's Deus account: starting a sign-in in
// Deus Cloud, finishing it when the browser returns, and keeping this
// computer's rows in line with the account that is signed in. The client
// that talks to Deus Cloud is auth/cloud-accounts.ts; this is what the app
// does with its answers.

import { getErrorMessage } from "@shared/lib/errors";
import type { CatalogApp, ConnectAppResult } from "@shared/integrations/types";
import { attachConnection, finishRemoval } from "./accounts";
import { signInReturnUrl } from "./auth/callback";
import {
  cloudAccountConnected,
  cloudAccountId,
  cloudAttempt,
  cloudDirectoryVersion,
  forgetCloudAttempts,
  newCloudAttempt,
  readCloudAccounts,
  startCloudSignIn,
} from "./auth/cloud-accounts";
import { findApp } from "./catalog";
import { checkApp } from "./checks";
import { integrationsChanged, markNeedsReauth } from "./events";
import { signInRoute, type SignInRoute } from "./sign-in-route";
import {
  createConnection,
  deleteConnection,
  getConnection,
  getInstallation,
  listConnections,
  updateConnection,
  type ConnectionRow,
} from "./store";

/**
 * Connect through Deus Cloud: the broker's hosted sign-in page, which
 * returns to an address only this attempt knows. An account Deus Cloud
 * already has (connected on another computer, or in a tab that never came
 * back) connects at once.
 */
export async function connectThroughCloud(
  app: CatalogApp,
  route: Extract<SignInRoute, { via: "cloud" }>
): Promise<ConnectAppResult> {
  const accountId = cloudAccountId();
  if (!accountId) throw new Error(`Sign in to your Deus account to connect ${app.name}`);
  const existing = cloudRow(app.id, accountId);
  const row =
    existing ?? createConnection({ appId: app.id, kind: "managed", deusAccountId: accountId });
  try {
    const started = await startCloudSignIn({
      appId: app.id,
      route: route.broker,
      callbackUrl: `${signInReturnUrl()}/${newCloudAttempt(row.id)}`,
    });
    if (started.status === "connected") {
      cloudAccountLanded(row);
      return { status: "connected" };
    }
    integrationsChanged();
    return { status: "redirect", url: started.url };
  } catch (error) {
    forgetCloudAttempts(row.id);
    // A row that was already there (asking to sign in again) stays as it was.
    if (!existing) deleteConnection(row.id);
    throw new Error(`${app.name} did not start a sign-in: ${getErrorMessage(error)}`);
  }
}

/**
 * This computer's row for an app's connection in one Deus account. There is
 * at most one, as there is one connection per account and app in Deus Cloud:
 * a new sign-in, a second click and a sign-in again all reuse it.
 */
function cloudRow(appId: string, accountId: string): ConnectionRow | null {
  return (
    listConnections(appId).find(
      (c) => c.kind === "managed" && c.deusAccountId === accountId && c.status !== "removing"
    ) ?? null
  );
}

function cloudAccountLanded(connection: ConnectionRow): void {
  forgetCloudAttempts(connection.id);
  updateConnection(connection.id, { status: "active", lastError: null });
  attachConnection(connection.appId, connection.id);
  void checkApp(connection.appId);
}

/** A sign-in page can send the browser back a moment before the account reads as connected. */
const SETTLE_TRIES = 4;
let settleWaitMs = 1_500;

/**
 * The broker's sign-in page sent the browser back. Whether the account is
 * connected is Deus Cloud's answer (it asks the broker), never the page's.
 * Returns the app's name.
 */
export async function completeCloudCallback(attempt: string): Promise<string> {
  const connectionId = cloudAttempt(attempt);
  const connection = connectionId ? getConnection(connectionId) : null;
  const app = connection ? findApp(connection.appId) : null;
  if (!connection || !app) throw new Error("This sign-in link has expired. Start again from Deus.");
  if (connection.status === "active") return app.name;

  let connected = false;
  try {
    for (let tries = 1; !connected && tries <= SETTLE_TRIES; tries++) {
      if (tries > 1) await new Promise((resolve) => setTimeout(resolve, settleWaitMs));
      connected = await cloudAccountConnected(connection);
    }
  } catch (error) {
    updateConnection(connection.id, { lastError: getErrorMessage(error) });
    integrationsChanged();
    throw error;
  }
  if (!connected) {
    updateConnection(connection.id, { lastError: "The sign-in was not finished" });
    integrationsChanged();
    throw new Error("The sign-in was not finished. Start again from Deus.");
  }
  cloudAccountLanded(connection);
  return app.name;
}

/**
 * Bring this computer's rows in line with the signed-in Deus account: call
 * it when the account changes, and at startup. Rows another account left are
 * dropped here (they stay that account's in Deus Cloud); an installed app
 * the account already connected elsewhere is ready with no sign-in; one
 * disconnected elsewhere asks to connect again. Never throws.
 */
export function reconcileCloudAccounts(): Promise<void> {
  reconciling = (reconciling ?? Promise.resolve())
    .then(runReconcile)
    .catch((error) => console.warn("[Integrations] Could not read Deus Cloud accounts:", error));
  return reconciling;
}

let reconciling: Promise<void> | null = null;
/** The Deus account the last pass saw, to push only when what clients read changed. */
let reconciledAccount: string | null = null;

async function runReconcile(): Promise<void> {
  const accountId = cloudAccountId();
  const held = () => listConnections().filter((c) => c.kind === "managed");
  let changed = accountId !== reconciledAccount;
  reconciledAccount = accountId;
  if (accountId) {
    for (const other of held()) {
      // What another account removed while signed out waits for that account.
      if (other.deusAccountId === accountId || other.status === "removing") continue;
      forgetCloudAttempts(other.id);
      deleteConnection(other.id);
      changed = true;
    }
  }
  // Signed out, the rows wait: signing back in to the same account brings them back.
  if (changed) integrationsChanged();
  // What the person removed while signed out, or while Deus Cloud could not
  // be reached, is disconnected now: before the list is read, so an account
  // on its way out is not taken for one connected elsewhere.
  const owed = () => held().filter((c) => c.status === "removing" && c.deusAccountId === accountId);
  await Promise.all(owed().map(finishRemoval));
  const served = cloudDirectoryVersion();
  const cloud = await readCloudAccounts();
  if (cloudDirectoryVersion() !== served) integrationsChanged();
  if (!cloud) return;

  const connected = new Map(
    cloud.connections.filter((c) => c.status === "active").map((c) => [c.appId, c])
  );
  // The list is a moment old (a sign-in may have just landed, a disconnect
  // may be on its way): each difference is asked again before it is acted on.
  const stillConnected = (appId: string) =>
    cloudAccountConnected({ appId, deusAccountId: cloud.accountId }).catch(() => null);
  for (const row of held()) {
    if (row.deusAccountId !== cloud.accountId || row.status !== "active") continue;
    if (connected.has(row.appId)) continue;
    // Disconnected on another computer, or gone at the broker.
    if ((await stillConnected(row.appId)) !== false) continue;
    if (getConnection(row.id)?.status !== "active") continue;
    markNeedsReauth(row.id, `${findApp(row.appId)?.name ?? "This app"} is no longer signed in`);
  }
  for (const [appId, theirs] of connected) {
    const app = findApp(appId);
    const waiting = () => {
      const install = getInstallation("app", appId);
      if (!install) return false;
      const mine = install.connectionId ? getConnection(install.connectionId) : null;
      return mine?.status !== "active";
    };
    if (!app || app.broker?.toolkit !== theirs.toolkit || !waiting()) continue;
    // Still owed a disconnect that did not go through: not adopted back.
    if (owed().some((c) => c.appId === appId)) continue;
    if (signInRoute(app).via !== "cloud") continue;
    if ((await stillConnected(appId)) !== true || !waiting()) continue;
    if (cloudAccountId() !== cloud.accountId) return;
    cloudAccountLanded(
      cloudRow(appId, cloud.accountId) ??
        createConnection({ appId, kind: "managed", deusAccountId: cloud.accountId })
    );
  }
}

/** @internal Wait for the pass under way (tests). */
export async function settleCloudAccounts(): Promise<void> {
  await reconciling;
}

/** @internal */
export function __setCallbackSettleForTests(waitMs: number): void {
  settleWaitMs = waitMs;
}
