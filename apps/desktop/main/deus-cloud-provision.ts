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
  hasStoredCredentials,
  getCloudCredential,
  getCloudCredentialMeta,
  setCloudCredential,
} from "./cloud-credentials";
import { getStoredDeusCloudSessionToken, setSessionRefreshedHandler } from "./deus-cloud-auth";
import { AGNT_LOCAL_URL, isLocalCloudEnv, resolveDeusCloudUrl } from "./deus-cloud-auth-contract";
import { logMainProcess } from "./startup-diagnostics";

/**
 * Last device-key provisioning failure for the signed-in account (main-process
 * memory only — it is a transient condition, cleared by a successful mint or
 * sign-out). Surfaced in Settings so the failure is recoverable in-app.
 */
let platformKeyError: string | null = null;

export function setPlatformKeyError(message: string | null): void {
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
const PLATFORM_TIMEOUT_MS = 15_000;

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

  const [apiKey, claudeOauthToken, sessionToken, keyMeta] = await Promise.all([
    getCloudCredential("agntApiKey"),
    getCloudCredential("claudeOauthToken"),
    getStoredDeusCloudSessionToken().catch(() => null),
    getCloudCredentialMeta("agntApiKey").catch(() => null),
  ]);

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
        claudeOauthToken: claudeOauthToken ?? null,
        // deus-cloud mint context: lets the backend request per-repo GitHub
        // App installation tokens at workspace-provision time. Session-token
        // auth — expiry just disables the mint until the next push.
        deusCloudUrl: resolveDeusCloudUrl(),
        deusCloudSessionToken: sessionToken,
        orgId: keyMeta?.orgId ?? null,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure this device holds a platform key for the signed-in account. Idempotent:
 * an existing stored key wins (revocation is handled by the 401 path — agnt
 * rejects a revoked key and Settings offers re-provisioning via sign-in).
 */
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

export async function ensureDeviceKey(sessionToken: string, cloudUrl: string): Promise<boolean> {
  const existing = await getCloudCredential("agntApiKey");
  if (existing && (await deviceKeyStillValid(existing))) {
    return true;
  }
  if (existing) {
    // Revoked from the dashboard (or on another device). Without this the
    // stale key survives every restart and each platform call 401s silently
    // forever — the only recovery was a manual sign-out/sign-in.
    logMainProcess("[deus-cloud] stored device key rejected by platform — re-minting");
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
 * Sync the Claude subscription token's CANONICAL copy to the platform (a
 * user-scoped agnt secret, applies_to_all=false — a turn credential the
 * session DO resolves; never fanned into sandbox env). This is what makes
 * the phone work with the Mac closed. `null` deletes. Best-effort: without
 * a device key (not signed in yet) the token stays local until the next
 * sign-in re-syncs it.
 */
export async function syncClaudeTokenToPlatform(value: string | null): Promise<boolean> {
  return syncAgentSecretToPlatform("CLAUDE_CODE_OAUTH_TOKEN", value);
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
  const [storedClaude, storedCodex] = await Promise.all([
    getCloudCredential("claudeOauthToken").catch(() => null),
    getCloudCredential("codexAuthJson").catch(() => null),
  ]);
  // Record the sync the same way the connect paths do. Without this a
  // credential first uploaded HERE never gets the flag, and a later
  // signed-out disconnect deletes the local copy while reporting success —
  // leaving the platform copy running (and billing) cloud turns.
  if (storedClaude && (await syncClaudeTokenToPlatform(storedClaude))) {
    await setCloudCredential("claudeOauthToken", storedClaude, { syncedToPlatform: true });
  }
  if (storedCodex && (await syncAgentSecretToPlatform("CODEX_AUTH_JSON", storedCodex))) {
    await setCloudCredential("codexAuthJson", storedCodex, { syncedToPlatform: true });
  }
  await pushCloudCredentialsToBackend();
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
  if (!(await hasStoredCredentials())) return true;
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
  void (async () => {
    await waitForSafeStorage();
    const token = await getSessionToken().catch(() => null);
    if (token) {
      await provisionAfterLogin(token, cloudUrl);
    } else {
      await pushCloudCredentialsToBackend();
    }
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
  delete process.env.DEUS_CLOUD_AGNT_API_KEY;
  await pushCloudCredentialsToBackend();
}
