// The credential lifecycle shared by every agent subscription (Claude today,
// Codex today, more later). ONE home for the invariants the per-agent modules
// kept drifting apart on — four separate review rounds re-applied the same
// fix twice before this existed:
//
//   connect    — vault write first (local cache), owning org read BEFORE the
//                platform write (a sign-out mid-PUT must not strand a stamp
//                without its org), sync stamped only on success.
//   disconnect — platform copy first; with no device key, refuse to claim a
//                success we cannot deliver when a synced copy exists.
//
// Per-agent modules keep what is genuinely per-agent: validation, terminal
// helpers, file parsing, IPC names.

import {
  deleteCloudCredential,
  foreignToOrg,
  getCloudCredential,
  getCloudCredentialMeta,
  setCloudCredential,
  type CloudCredentialName,
} from "./cloud-credentials";
import { logMainProcess } from "./startup-diagnostics";
import {
  pushCloudCredentialsToBackend,
  syncAgentSecretToPlatform,
  whenCredentialCatchUpSettled,
} from "./deus-cloud-provision";

export interface AgentCredentialSpec {
  /** safeStorage vault entry. */
  vaultName: CloudCredentialName;
  /** Platform secret name (unlinked turn credential). */
  secretName: string;
  /** Disconnect: the platform DELETE failed and the copy would keep working. */
  deleteFailedMessage: string;
  /** Disconnect: synced copy exists but no device key can reach it. */
  signedOutMessage: string;
}

/** Store locally, sync the canonical platform copy, stamp what succeeded. */
/**
 * Store locally + sync to the platform. Returns whether the platform copy
 * landed: callers whose CLOUD behavior depends entirely on the platform copy
 * (codex — turns resolve the secret at the session DO, the local value is
 * never sent per turn) must surface `false` instead of reporting connected.
 * The startup catch-up retries unsynced values on the next launch.
 */
export async function connectAgentCredential(
  spec: AgentCredentialSpec,
  value: string
): Promise<boolean> {
  const orgId = (await getCloudCredentialMeta("agntApiKey").catch(() => null))?.orgId ?? null;
  const prior = await getCloudCredentialMeta(spec.vaultName).catch(() => null);
  if (foreignToOrg(prior, orgId)) {
    // An EXPLICIT save under a new account is deliberate adoption — unlike
    // the background catch-up, it must not be blocked. But overwriting the
    // stamp orphans the other org's platform copy (only that account's
    // session or dashboard can delete it), so the hand-off is logged rather
    // than silent.
    logMainProcess(
      `[deus-cloud] ${spec.vaultName} was synced to org ${prior?.syncedOrgId} — adopting into ${orgId}; the old platform copy needs that account to remove`
    );
  }
  // Reset the stamp WITH the new value: setCloudCredential preserves meta on
  // value-only writes, so a replacement after a failed PUT would inherit the
  // old syncedToPlatform:true and the heal-only catch-up would skip it
  // forever — the platform would keep serving the SUPERSEDED credential.
  // (Trade-off accepted: until the PUT lands, a signed-out disconnect can no
  // longer refuse on the stamp — but the platform copy it protects is the
  // one the user just replaced.)
  await setCloudCredential(spec.vaultName, value, { syncedToPlatform: false });
  const synced = await syncAgentSecretToPlatform(spec.secretName, value);
  if (synced) {
    await setCloudCredential(spec.vaultName, value, {
      syncedToPlatform: true,
      ...(orgId ? { syncedOrgId: orgId } : {}),
    });
  }
  await pushCloudCredentialsToBackend();
  return synced;
}

/**
 * Platform-first disconnect. Returns an error message when the honest answer
 * is "not disconnected", null on success.
 */
export async function disconnectAgentCredential(spec: AgentCredentialSpec): Promise<string | null> {
  // Serialize against the post-login catch-up: its in-flight PUT committing
  // AFTER this delete would silently resurrect the credential.
  await whenCredentialCatchUpSettled();
  const hasDeviceKey = Boolean(await getCloudCredential("agntApiKey").catch(() => null));
  if (hasDeviceKey) {
    if (!(await syncAgentSecretToPlatform(spec.secretName, null))) {
      return spec.deleteFailedMessage;
    }
  } else if ((await getCloudCredentialMeta(spec.vaultName).catch(() => null))?.syncedToPlatform) {
    return spec.signedOutMessage;
  }
  await deleteCloudCredential(spec.vaultName);
  await pushCloudCredentialsToBackend();
  return null;
}
