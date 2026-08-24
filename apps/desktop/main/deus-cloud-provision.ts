// The D1 provisioning handshake: after a Deus Cloud sign-in, turn the session
// into a working platform credential — look up the org (auto-created at first
// login), mint a per-device agnt API key (label = hostname, revocable), store
// it in safeStorage, and hand it to the backend child process at runtime.
//
// The mint call goes straight from Electron main to the agnt backend (no CORS
// concerns outside a renderer); the deus-cloud session JWT is the credential.

import { hostname } from "node:os";
import { isSafeStorageAvailable } from "./safe-storage-file";
import {
  deleteCloudCredential,
  foreignToOrg,
  hasStoredCredentials,
  getCloudCredential,
  getCloudCredentialMeta,
  setCloudCredential,
} from "./cloud-credentials";
import {
  announceDeusCloudAuthChanged,
  getStoredDeusCloudSessionToken,
  hasStoredSessionFile,
  setSessionRefreshedHandler,
  setSessionRevokedHandler,
} from "./deus-cloud-auth";
import { AGNT_LOCAL_URL, isLocalCloudEnv, resolveDeusCloudUrl } from "./deus-cloud-auth-contract";
import { logMainProcess } from "./startup-diagnostics";

/**
 * Last device-key provisioning failure for the signed-in account (main-process
 * memory only — it is a transient condition, cleared by a successful mint or
 * sign-out). Surfaced in Settings so the failure is recoverable in-app.
 */
let platformKeyError: string | null = null;

function setPlatformKeyError(message: string | null): void {
  platformKeyError = message;
}

export function getPlatformKeyError(): string | null {
  return platformKeyError;
}

/** Re-run provisioning for the current session (the Settings "Retry" action). */
export async function retryDeviceKeyProvisioning(): Promise<{ ok: boolean; error?: string }> {
  const sessionToken = await getStoredDeusCloudSessionToken().catch(() => null);
  if (!sessionToken) return { ok: false, error: "Not signed in to Deus Cloud" };
  await provisionAfterLogin(sessionToken, resolveDeusCloudUrl());
  const error = getPlatformKeyError();
  return error ? { ok: false, error } : { ok: true };
}

/** agnt platform base URL — same precedence the backend's cloud config uses. */
export function resolveAgntBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fallback = isLocalCloudEnv(env) ? AGNT_LOCAL_URL : "https://api.deusmachine.ai";
  return (env.DEUS_CLOUD_AGNT_URL ?? env.AGNT_BASE_URL ?? fallback).replace(/\/$/, "");
}

/**
 * Bound every platform call. undici's default header timeout is 300s, so a
 * black-hole endpoint would spin the Settings "Retry setup" button — and
 * block sign-out, which awaits the revoke — for five minutes.
 */
export const PLATFORM_TIMEOUT_MS = 15_000;

interface OrgRef {
  id: string;
  name?: string;
}

/** Tolerant-reader over the deus-cloud orgs listing (array or wrapped). */
export function parseOrgList(body: unknown): OrgRef[] {
  // `{ items: [...] }` is what deus-cloud's GET /orgs actually returns; the
  // bare-array and `{ organizations }` shapes are kept as tolerant fallbacks
  // (the latter is /me's shape). Missing the real one made every production
  // sign-in mint nothing — the local mock and these tests had encoded the
  // assumed shape rather than the served one.
  const container =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const named = container
    ? ["items", "organizations"].map((k) => container[k]).find(Array.isArray)
    : undefined;
  const list = Array.isArray(body) ? body : ((named as unknown[]) ?? []);
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = record.id ?? record.organization_id ?? record.organizationId;
    if (typeof id !== "string" || id.length === 0) return [];
    const name = typeof record.name === "string" ? record.name : undefined;
    return [{ id, name }];
  });
}

async function fetchFirstOrg(sessionToken: string, cloudUrl: string): Promise<OrgRef> {
  const response = await fetch(`${cloudUrl}/orgs`, {
    headers: { authorization: `Bearer ${sessionToken}` },
    signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`org lookup failed (${response.status})`);
  }
  const orgs = parseOrgList(await response.json());
  const first = orgs[0];
  if (!first) {
    throw new Error("no organization on this account — sign in again to auto-create one");
  }
  return first;
}

interface MintedKey {
  id: string;
  key: string;
  label: string;
}

async function mintDeviceKey(
  sessionToken: string,
  orgId: string,
  agntBaseUrl: string
): Promise<MintedKey> {
  const label = `deus-desktop ${hostname()}`.slice(0, 100);
  const response = await fetch(`${agntBaseUrl}/dashboard/orgs/${orgId}/api-keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ label }),
    signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`device key mint failed (${response.status})`);
  }
  const body = (await response.json()) as { id?: string; key?: string; label?: string };
  if (!body.key || !body.id) {
    throw new Error("device key mint returned no key");
  }
  return { id: body.id, key: body.key, label: body.label ?? label };
}

/**
 * Push the current credentials into the backend child at runtime — the seam
 * that makes a key minted mid-session work without an app restart. Quiet
 * no-op when the backend isn't up yet (startup calls it again post-spawn).
 */
export async function pushCloudCredentialsToBackend(): Promise<boolean> {
  const port = process.env.DEUS_BACKEND_PORT;
  const authToken = process.env.DEUS_AUTH_TOKEN;
  if (!port || !authToken) return false;
  if ((await hasStoredCredentials()) && !isSafeStorageAvailable()) {
    // Every credential would read as null and the push would CLEAR the
    // backend's working copies over a keyring that is merely still locked.
    // Say nothing instead; provisionAtStartup retries once it opens.
    return false;
  }

  const [apiKey, claudeOauthToken, sessionToken, keyMeta, claudeMeta] = await Promise.all([
    getCloudCredential("agntApiKey"),
    getCloudCredential("claudeOauthToken"),
    getStoredDeusCloudSessionToken().catch(() => null),
    getCloudCredentialMeta("agntApiKey").catch(() => null),
    getCloudCredentialMeta("claudeOauthToken").catch(() => null),
  ]);
  // Same ownership rule as the catch-up sync and the status flags: a token
  // stamped for ANOTHER account's org must not run this org's turns.
  const orgId = keyMeta?.orgId ?? null;
  const claudeForThisOrg = foreignToOrg(claudeMeta, orgId) ? null : claudeOauthToken;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/cloud/credentials`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      body: JSON.stringify({
        apiKey: apiKey ?? null,
        claudeOauthToken: claudeForThisOrg ?? null,
        // deus-cloud mint context: lets the backend request per-repo GitHub
        // App installation tokens at workspace-provision time. Session-token
        // auth — expiry just disables the mint until the next push.
        deusCloudUrl: resolveDeusCloudUrl(),
        deusCloudSessionToken: sessionToken,
        orgId,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Cheapest authenticated probe agnt offers (metadata only, never values).
 * ONLY an explicit 401/403 counts as revoked — a timeout or an offline
 * laptop must not throw away a perfectly good key.
 */
async function deviceKeyStillValid(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${resolveAgntBaseUrl()}/secrets`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    });
    return !(response.status === 401 || response.status === 403);
  } catch {
    return true;
  }
}

/**
 * Ensure this device holds a platform key for the signed-in account. Idempotent:
 */
export async function ensureDeviceKey(sessionToken: string, cloudUrl: string): Promise<boolean> {
  const existing = await getCloudCredential("agntApiKey");
  if (existing) {
    // A key can outlive its ACCOUNT, not just its validity: a 401-expired
    // session clears only the session file, so signing into a different
    // account would silently reuse the previous account's org key — B's
    // workspaces running (and billing) in A's org. Ownership and validity
    // are probed together; offline keeps the key (offline ≠ revoked), a
    // foreign org drops the local copy (the platform copy needs the OTHER
    // account's session to revoke — its dashboard can).
    const [meta, org, valid] = await Promise.all([
      getCloudCredentialMeta("agntApiKey").catch(() => null),
      fetchFirstOrg(sessionToken, cloudUrl).catch(() => null),
      deviceKeyStillValid(existing),
    ]);
    const foreign = Boolean(meta?.orgId && org?.id && meta.orgId !== org.id);
    if (valid && !foreign) {
      // Unknown ownership (org lookup failed) deliberately reuses: treating
      // it as foreign would delete a good key on every same-account hiccup,
      // and the probe re-runs at every startup, so a wrong reuse self-heals.
      if (!org) logMainProcess("[deus-cloud] key ownership unverifiable (offline?) — reusing");
      return true;
    }
    logMainProcess(
      foreign
        ? `[deus-cloud] stored device key belongs to org ${meta?.orgId} — re-minting for ${org?.id}`
        : "[deus-cloud] stored device key rejected by platform — re-minting"
    );
    await deleteCloudCredential("agntApiKey");
  }

  const org = await fetchFirstOrg(sessionToken, cloudUrl);
  const agntBaseUrl = resolveAgntBaseUrl();
  const minted = await mintDeviceKey(sessionToken, org.id, agntBaseUrl);
  await setCloudCredential("agntApiKey", minted.key, {
    keyId: minted.id,
    orgId: org.id,
    label: minted.label,
  });
  logMainProcess(`[deus-cloud] device key minted (org ${org.id}, label "${minted.label}")`);
  return true;
}

/**
 * Sync any agent turn-credential's CANONICAL platform copy (an UNLINKED
 * secret — applies_to_all=false, zero environment links: resolvable only by
 * name-targeted turn lookups, never fanned into sandbox env). `null`
 * deletes. Best-effort without a device key.
 */
export async function syncAgentSecretToPlatform(
  name: string,
  value: string | null
): Promise<boolean> {
  const apiKey = await getCloudCredential("agntApiKey");
  if (!apiKey) return false;
  const url = `${resolveAgntBaseUrl()}/secrets/${name}`;
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  try {
    const response =
      value === null
        ? await fetch(url, {
            method: "DELETE",
            headers,
            signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
          })
        : await fetch(url, {
            method: "PUT",
            headers,
            signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
            body: JSON.stringify({ value, appliesToAll: false }),
          });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The in-flight post-login catch-up. Disconnect awaits it so the pair
 * serializes: the one real overlap between a background platform PUT and a
 * user-initiated delete of the same credential.
 */
let credentialCatchUp: Promise<void> = Promise.resolve();

export function whenCredentialCatchUpSettled(): Promise<void> {
  return credentialCatchUp.catch(() => {});
}

/** Post-login hook: mint if needed, then hand credentials to the backend. */
export async function provisionAfterLogin(sessionToken: string, cloudUrl: string): Promise<void> {
  try {
    await ensureDeviceKey(sessionToken, cloudUrl);
    setPlatformKeyError(null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Remembered, not just logged: this runs after login already reported
    // success, so the log file was the ONLY place the user could learn that
    // their cloud lane is dead.
    setPlatformKeyError(message);
    logMainProcess(`[deus-cloud] device key provisioning failed: ${message}`);
  }
  // Credentials connected before sign-in were local-only — the device key now
  // exists, so the platform copies can catch up. BOTH agents: syncing only
  // Claude leaves a Codex login connected pre-sign-in invisible to the cloud
  // forever (nothing else re-runs this).
  const catchUp = (async () => {
    const [storedClaude, storedCodex] = await Promise.all([
      getCloudCredential("claudeOauthToken").catch(() => null),
      getCloudCredential("codexAuthJson").catch(() => null),
    ]);
    // Record the sync the same way the connect paths do. Without this a
    // credential first uploaded HERE never gets the flag, and a later
    // signed-out disconnect deletes the local copy while reporting success —
    // leaving the platform copy running (and billing) cloud turns.
    //
    // Skipping a credential already synced ELSEWHERE is the other half: these
    // survive sign-out (only the device key is deleted), so a sign-in to a
    // different account would upload the same token into a second org — live
    // in both, and deletable from only the one you are signed into.
    const orgId = (await getCloudCredentialMeta("agntApiKey").catch(() => null))?.orgId ?? null;
    for (const [name, value, secretName] of [
      ["claudeOauthToken", storedClaude, "CLAUDE_CODE_OAUTH_TOKEN"],
      ["codexAuthJson", storedCodex, "CODEX_AUTH_JSON"],
    ] as const) {
      if (!value) continue;
      const meta = await getCloudCredentialMeta(name).catch(() => null);
      if (foreignToOrg(meta, orgId)) {
        logMainProcess(
          `[deus-cloud] ${name} belongs to another account — not syncing it to ${orgId ?? "unknown"}`
        );
        continue;
      }
      // HEAL-ONLY: re-uploading an already-synced credential would silently
      // resurrect a platform copy the user deleted from ANOTHER surface (the
      // web app's Disconnect removes only the platform secret — this desktop's
      // vault copy survives and must not undo that decision on next launch).
      // Rotations still propagate: every explicit connect PUTs unconditionally
      // and re-stamps.
      if (meta?.syncedToPlatform) continue;
      // The user can hit Disconnect while this background PUT is in flight;
      // committing the captured value afterwards would silently resurrect the
      // credential Disconnect just reported removed. Re-check around the PUT
      // (disconnect itself awaits this whole catch-up — see
      // whenCredentialCatchUpSettled — so the pair cannot interleave).
      if ((await getCloudCredential(name).catch(() => null)) !== value) continue;
      if (await syncAgentSecretToPlatform(secretName, value)) {
        if ((await getCloudCredential(name).catch(() => null)) !== value) continue;
        await setCloudCredential(name, value, {
          syncedToPlatform: true,
          ...(orgId ? { syncedOrgId: orgId } : {}),
        });
      }
    }
    await pushCloudCredentialsToBackend();
  })();
  credentialCatchUp = catchUp;
  await catchUp;
}

/**
 * Wait out a still-locked OS keyring before the startup handoff.
 *
 * On Linux the login keyring commonly unlocks a beat after the app starts;
 * running the handoff into that window pushed a set of nulls and left the
 * cloud lane dead for the whole session with nothing to re-trigger it.
 * Bounded: past this the user genuinely has no secure storage.
 */
const SAFE_STORAGE_WAIT_MS = 60_000;
const SAFE_STORAGE_POLL_MS = 2_000;

async function waitForSafeStorage(): Promise<boolean> {
  // Nothing stored = nothing to unlock. Critically, this also means a fresh
  // install never probes the keyring at startup: on macOS that probe is a
  // synchronous Keychain call on the main thread, and with no keychain
  // unlocked it blocks everything behind it — window creation included.
  // The session file lives OUTSIDE the credentials vault, and it is exactly
  // what exists when a prior mint failed: skipping the wait then reads a
  // null session and never provisions after the keyring opens.
  if (!(await hasStoredCredentials()) && !(await hasStoredSessionFile())) return true;
  const deadline = Date.now() + SAFE_STORAGE_WAIT_MS;
  while (!isSafeStorageAvailable()) {
    if (Date.now() >= deadline) {
      logMainProcess("[deus-cloud] secure storage never became available — cloud lane stays off");
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, SAFE_STORAGE_POLL_MS));
  }
  return true;
}

/**
 * Startup, after the backend is up: signed-in & keyless → mint this device's
 * platform key; otherwise just hand any stored credentials to the backend.
 * Fire-and-forget by design — startup must never block on the cloud.
 */
export function provisionAtStartup(
  getSessionToken: () => Promise<string | null>,
  cloudUrl: string
): void {
  // Keep the backend's copy of the session token in step with silent renewals.
  setSessionRefreshedHandler(async () => {
    await pushCloudCredentialsToBackend();
  });
  // A rejected refresh is a server-side revocation: retire the device key
  // locally and push the cleared credentials (no session left to revoke the
  // platform copy — the dashboard can, and the next sign-in re-mints).
  setSessionRevokedHandler(async () => {
    await revokeDeviceKey(null).catch(() => {});
    // The 401 can fire from ANY session read (a github-app status poll, a
    // credentials push) — announce, or renderers keep "signed in" until a
    // remount while the cloud lane is already gone.
    await announceDeusCloudAuthChanged().catch(() => {});
  });
  void (async () => {
    await waitForSafeStorage();
    const token = await getSessionToken().catch(() => null);
    if (token) {
      await provisionAfterLogin(token, cloudUrl);
    } else {
      await pushCloudCredentialsToBackend();
    }
    // Unlike the login path, nothing else announces this background work —
    // a renderer that queried the session mid-provision cached
    // hasPlatformKey:false and, with focus-refetch off, kept it.
    await announceDeusCloudAuthChanged().catch(() => {});
  })();
}

/**
 * Sign-out: best-effort revoke of THIS device's key server-side, then local
 * deletion + backend clear. Called with the session token BEFORE the session
 * file is cleared.
 */
export async function revokeDeviceKey(sessionToken: string | null): Promise<void> {
  const meta = await getCloudCredentialMeta("agntApiKey");
  if (sessionToken && meta?.keyId && meta.orgId) {
    try {
      await fetch(`${resolveAgntBaseUrl()}/dashboard/orgs/${meta.orgId}/api-keys/${meta.keyId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      });
    } catch {
      // Offline sign-out is fine — the key can be revoked from any signed-in
      // device later; local deletion below still locks this device out.
    }
  }
  await deleteCloudCredential("agntApiKey");
  await pushCloudCredentialsToBackend();
}
