// The D1 provisioning handshake: after a Deus Cloud sign-in, turn the session
// into working platform credentials — list the account's organizations (one is
// auto-created at first login), keep or mint one per-device agnt API key in
// each (label = hostname, revocable), store them in safeStorage, and hand them
// to the backend child process at runtime.
//
// The mint call goes straight from Electron main to the agnt backend (no CORS
// concerns outside a renderer); the deus-cloud session JWT is the credential.

import { hostname } from "node:os";
import { isSafeStorageAvailable } from "./safe-storage-file";
import {
  deleteAllOrgKeys,
  deleteOrgKey,
  getOrgKey,
  getOrgKeys,
  hasStoredCredentials,
  listOrgKeys,
  orderOrgKeys,
  setOrgKey,
} from "./cloud-credentials";
import {
  announceDeusCloudAuthChanged,
  currentLoginGeneration,
  endLoginGeneration,
  getStoredDeusCloudSessionToken,
  hasStoredSessionFile,
  setSessionRefreshedHandler,
  setSessionRevokedHandler,
} from "./deus-cloud-auth";
import { AGNT_LOCAL_URL, isLocalCloudEnv, resolveDeusCloudUrl } from "./deus-cloud-auth-contract";
import { logMainProcess } from "./startup-diagnostics";

/**
 * The first device-key provisioning failure of the last run for the signed-in
 * account (main-process memory only — it is a transient condition, cleared by a
 * run in which every organization has its key, and by sign-out). Surfaced in
 * Settings so the failure is recoverable in-app.
 */
let platformKeyError: string | null = null;

function setPlatformKeyError(message: string | null): void {
  platformKeyError = message;
}

export function getPlatformKeyError(): string | null {
  return platformKeyError;
}

/**
 * The organization the platform lists first for the signed-in account, as last
 * read (main-process memory; cleared by sign-out). It is the default organization,
 * told to the backend with the keys whether or not its own key is held.
 */
let listedDefaultOrgId: string | null = null;

/** Re-run provisioning for the current session (the Settings "Retry" action). */
export async function retryDeviceKeyProvisioning(): Promise<{ ok: boolean; error?: string }> {
  // The session this run is for is the one current when Retry was pressed, before the token read.
  const generation = currentLoginGeneration();
  const sessionToken = await getStoredDeusCloudSessionToken().catch(() => null);
  if (!sessionToken) return { ok: false, error: "Not signed in to Deus Cloud" };
  await provisionAfterLogin(sessionToken, resolveDeusCloudUrl(), generation);
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

/** The account's organizations, in the platform's order. */
async function fetchOrgs(sessionToken: string, cloudUrl: string): Promise<OrgRef[]> {
  const response = await fetch(`${cloudUrl}/orgs`, {
    headers: { authorization: `Bearer ${sessionToken}` },
    signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`org lookup failed (${response.status})`);
  }
  const orgs = parseOrgList(await response.json());
  if (orgs.length === 0) {
    throw new Error("no organization on this account — sign in again to auto-create one");
  }
  return orgs;
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

/** The running backend's spawn token, written on its stdin: never in this process's environment. */
let backendAuthToken: string | null = null;
export function setBackendAuthToken(token: string): void {
  backendAuthToken = token;
}

/**
 * Push the current credentials into the backend child at runtime — the seam
 * that makes a key minted mid-session work without an app restart. Quiet
 * no-op when the backend isn't up yet (startup calls it again post-spawn).
 */
export async function pushCloudCredentialsToBackend(): Promise<boolean> {
  const port = process.env.DEUS_BACKEND_PORT;
  const authToken = backendAuthToken;
  if (!port || !authToken) return false;
  if ((await hasStoredCredentials()) && !isSafeStorageAvailable()) {
    // Every credential would read as null and the push would CLEAR the
    // backend's working copies over a keyring that is merely still locked.
    // Say nothing instead; provisionAtStartup retries once it opens.
    return false;
  }

  const [orgKeys, sessionToken] = await Promise.all([
    getOrgKeys(),
    getStoredDeusCloudSessionToken().catch(() => null),
  ]);
  // The platform's first organization; before the list is read, the first stored
  // key's (the order last read).
  const defaultOrgId = listedDefaultOrgId ?? Object.keys(orgKeys)[0] ?? null;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/cloud/credentials`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      body: JSON.stringify({
        // deus-cloud mint context: lets the backend request per-repo GitHub
        // App installation tokens at workspace-provision time. Session-token
        // auth — expiry just disables the mint until the next push.
        deusCloudUrl: resolveDeusCloudUrl(),
        deusCloudSessionToken: sessionToken,
        // One key per organization, in the platform's order, and the default
        // organization, also when its own key is missing.
        orgKeys,
        orgId: defaultOrgId,
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

/** Best-effort server-side revoke of one stored key (offline is fine). */
async function revokeOnPlatform(
  sessionToken: string,
  key: { orgId: string; keyId?: string }
): Promise<void> {
  if (!key.keyId) return;
  try {
    await fetch(
      `${resolveAgntBaseUrl()}/dashboard/orgs/${encodeURIComponent(key.orgId)}/api-keys/${encodeURIComponent(key.keyId)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      }
    );
  } catch {
    // Offline is fine — the key can be revoked from any signed-in device
    // later; the local deletion still locks this device out.
  }
}

/**
 * Keep this organization's stored key if it still works; otherwise mint one. A key
 * minted for a session that ended meanwhile (`isCurrent` false: a sign-out) is
 * revoked, never stored: sign-out already revoked and deleted what was stored.
 */
async function ensureOrgKey(
  sessionToken: string,
  orgId: string,
  isCurrent: () => boolean
): Promise<void> {
  const existing = await getOrgKey(orgId);
  // ONLY an explicit 401/403 counts as revoked: offline keeps the key.
  if (existing && (await deviceKeyStillValid(existing))) return;
  if (existing) {
    logMainProcess(`[deus-cloud] device key for org ${orgId} rejected by platform — re-minting`);
    await deleteOrgKey(orgId);
  }
  const minted = await mintDeviceKey(sessionToken, orgId, resolveAgntBaseUrl());
  if (!isCurrent()) {
    logMainProcess(`[deus-cloud] signed out while minting a key for org ${orgId} — revoking it`);
    await revokeOnPlatform(sessionToken, { orgId, keyId: minted.id });
    return;
  }
  // No await between the check and the store: sign-out's own reads queue behind it.
  await setOrgKey(orgId, minted.key, { keyId: minted.id, label: minted.label });
  logMainProcess(`[deus-cloud] device key minted (org ${orgId}, label "${minted.label}")`);
}

/**
 * Ensure this device holds a platform key in every organization of the
 * signed-in account. Idempotent: a stored key that still works is kept, a
 * missing or revoked one is minted. One organization failing does not stop the
 * others. A key for an organization the account no longer lists (it left, or
 * this is a different account than the one that minted it) is revoked if
 * possible and deleted locally. The list's ORDER decides only which
 * organization is the default; no key is dropped or minted because it changed.
 *
 * Returns the first failure, or null when every organization has its key.
 * Throws only when the organization list itself cannot be read and nothing is
 * stored: with stored keys, an unreadable list keeps them (offline ≠ revoked;
 * the probe re-runs at every startup, so a wrong reuse self-heals).
 */
export async function ensureDeviceKeys(
  sessionToken: string,
  cloudUrl: string,
  /** False once the session this run is for has ended (a sign-out). */
  isCurrent: () => boolean = () => true
): Promise<string | null> {
  let orgs: OrgRef[];
  try {
    orgs = await fetchOrgs(sessionToken, cloudUrl);
  } catch (error) {
    if ((await listOrgKeys()).length === 0) throw error;
    logMainProcess("[deus-cloud] organization list unavailable (offline?) — reusing stored keys");
    return null;
  }
  // A list read for a session that ended says nothing about what is stored now.
  if (!isCurrent()) return null;
  listedDefaultOrgId = orgs[0].id;
  const listed = new Set(orgs.map((org) => org.id));
  for (const stored of await listOrgKeys()) {
    if (listed.has(stored.orgId)) continue;
    logMainProcess(
      `[deus-cloud] org ${stored.orgId} is no longer on this account — retiring its key`
    );
    await revokeOnPlatform(sessionToken, stored);
    await deleteOrgKey(stored.orgId);
  }
  const failures = await Promise.all(
    orgs.map(async (org) => {
      try {
        await ensureOrgKey(sessionToken, org.id, isCurrent);
        return null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logMainProcess(`[deus-cloud] device key provisioning failed for org ${org.id}: ${message}`);
        return orgs.length > 1 ? `${org.name ?? org.id}: ${message}` : message;
      }
    })
  );
  await orderOrgKeys(orgs.map((org) => org.id));
  return failures.find((failure) => failure !== null) ?? null;
}

/**
 * Keep or mint each organization's key, then hand credentials to the backend: after
 * sign-in, at startup and on Retry. A sign-out while it runs ends it: a key minted
 * meanwhile is revoked instead of stored, and nothing is pushed (sign-out pushed
 * the cleared credentials itself).
 *
 * `generation` is the session's (`currentLoginGeneration()`) as the caller read it
 * when it decided to run, before it awaited the session token: a sign-out during
 * that read must end this run too, though the read may return the old token.
 */
export async function provisionAfterLogin(
  sessionToken: string,
  cloudUrl: string,
  generation: number
): Promise<void> {
  const isCurrent = () => currentLoginGeneration() === generation;
  try {
    const error = await ensureDeviceKeys(sessionToken, cloudUrl, isCurrent);
    if (isCurrent()) setPlatformKeyError(error);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMainProcess(`[deus-cloud] device key provisioning failed: ${message}`);
    // Remembered, not just logged: this runs after login already reported
    // success, so the log file was the ONLY place the user could learn that
    // their cloud lane is dead.
    if (isCurrent()) setPlatformKeyError(message);
  }
  if (!isCurrent()) return;
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
    // The session is over, as at a sign-out: a key still being minted for it is
    // revoked, never stored or pushed.
    endLoginGeneration();
    await revokeDeviceKeys(null).catch(() => {});
    // The 401 can fire from ANY session read (a github-app status poll, a
    // credentials push) — announce, or renderers keep "signed in" until a
    // remount while the cloud lane is already gone.
    await announceDeusCloudAuthChanged().catch(() => {});
  });
  void (async () => {
    await waitForSafeStorage();
    const generation = currentLoginGeneration();
    const token = await getSessionToken().catch(() => null);
    if (token) {
      await provisionAfterLogin(token, cloudUrl, generation);
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
 * Sign-out: best-effort revoke of THIS device's keys server-side (every
 * organization), then local deletion + backend clear. Called with the session
 * token BEFORE the session file is cleared. The provisioning error belongs to
 * the account that left, so it goes too.
 */
export async function revokeDeviceKeys(sessionToken: string | null): Promise<void> {
  const keys = await listOrgKeys().catch(() => []);
  if (sessionToken) {
    await Promise.all(keys.map((key) => revokeOnPlatform(sessionToken, key)));
  }
  await deleteAllOrgKeys();
  setPlatformKeyError(null);
  listedDefaultOrgId = null;
  await pushCloudCredentialsToBackend();
}
