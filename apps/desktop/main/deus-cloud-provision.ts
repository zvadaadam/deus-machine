// The D1 provisioning handshake: after a Deus Cloud sign-in, turn the session
// into a working platform credential — look up the org (auto-created at first
// login), mint a per-device agnt API key (label = hostname, revocable), store
// it in safeStorage, and hand it to the backend child process at runtime.
//
// The mint call goes straight from Electron main to the agnt backend (no CORS
// concerns outside a renderer); the deus-cloud session JWT is the credential.

import { hostname } from "node:os";
import {
  deleteCloudCredential,
  getCloudCredential,
  getCloudCredentialMeta,
  setCloudCredential,
} from "./cloud-credentials";
import { logMainProcess } from "./startup-diagnostics";

/** agnt platform base URL — same precedence the backend's cloud config uses. */
export function resolveAgntBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.DEUS_CLOUD_AGNT_URL ?? env.AGNT_BASE_URL ?? "https://api.deusmachine.ai").replace(
    /\/$/,
    ""
  );
}

interface OrgRef {
  id: string;
  name?: string;
}

/** Tolerant-reader over the deus-cloud orgs listing (array or wrapped). */
export function parseOrgList(body: unknown): OrgRef[] {
  const list = Array.isArray(body)
    ? body
    : body &&
        typeof body === "object" &&
        Array.isArray((body as { organizations?: unknown[] }).organizations)
      ? (body as { organizations: unknown[] }).organizations
      : [];
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

  const [apiKey, claudeOauthToken] = await Promise.all([
    getCloudCredential("agntApiKey"),
    getCloudCredential("claudeOauthToken"),
  ]);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/cloud/credentials`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        apiKey: apiKey ?? null,
        claudeOauthToken: claudeOauthToken ?? null,
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
export async function ensureDeviceKey(sessionToken: string, cloudUrl: string): Promise<boolean> {
  const existing = await getCloudCredential("agntApiKey");
  if (existing) {
    return true;
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

/** Post-login hook: mint if needed, then hand credentials to the backend. */
export async function provisionAfterLogin(sessionToken: string, cloudUrl: string): Promise<void> {
  try {
    await ensureDeviceKey(sessionToken, cloudUrl);
  } catch (error) {
    logMainProcess(
      `[deus-cloud] device key provisioning failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  await pushCloudCredentialsToBackend();
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
  void (async () => {
    const token = await getSessionToken().catch(() => null);
    if (token) {
      await provisionAfterLogin(token, cloudUrl);
    } else {
      await pushCloudCredentialsToBackend();
    }
  })();
}

/**
 * Startup: surface the stored key to the backend the boring way — the spawn
 * env. Must run BEFORE spawnBackend (the child copies process.env).
 */
export async function applyCloudCredentialsToEnv(): Promise<void> {
  const apiKey = await getCloudCredential("agntApiKey").catch(() => null);
  if (apiKey && !process.env.DEUS_CLOUD_AGNT_API_KEY) {
    process.env.DEUS_CLOUD_AGNT_API_KEY = apiKey;
  }
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
