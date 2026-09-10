// backend/src/services/agent/cloud/config.ts
// Cloud-workspace (agnt) connection config.
//
// Two credential sources, merged: environment variables (dev workflow, read
// once) and RUNTIME credentials handed over by the desktop main process (the
// D1 handshake — a per-device key minted after sign-in and its WorkOS session). Runtime values win. `null` config = cloud lane disabled with
// honest errors at the create/send boundaries.

import { assertSecureCloudUrl } from "@shared/cloud-url";

export interface CloudConfig {
  /** agnt backend base URL (REST + session WebSockets). */
  baseUrl: string;
  /** Organization API key (agnt_sk_*). */
  apiKey: string;
  /**
   * deus-cloud mint context (per-repo GitHub App installation tokens at
   * provision time). All three or nothing — a partial set disables the mint.
   * The session token expires; the desktop re-pushes on auth changes, and a
   * stale token just means no mint (PAT/org-secret path still applies).
   */
  deusCloudUrl: string | null;
  deusCloudSessionToken: string | null;
  orgId: string | null;
}

/** Runtime credential handoff shape. `null` clears a value (falls back to env). */
export interface CloudRuntimeCredentials {
  apiKey?: string | null;
  baseUrl?: string | null;
  deusCloudUrl?: string | null;
  deusCloudSessionToken?: string | null;
  orgId?: string | null;
}

const runtime: { [K in keyof CloudRuntimeCredentials]: string | undefined } = {};

let cached: CloudConfig | null | undefined;

/**
 * `DEUS_CLOUD_ENV=local` targets a locally-running platform. The desktop main
 * process honours the same switch and the backend inherits its environment, so
 * one variable moves BOTH — previously `dev:cloud-local` pointed main at
 * localhost while the backend (which makes the actual workspace calls) kept
 * talking to production.
 */
const LOCAL_AGNT_URL = "http://127.0.0.1:8788";
const LOCAL_DEUS_CLOUD_URL = "http://127.0.0.1:5788";
const isLocalCloudEnv = (): boolean => process.env.DEUS_CLOUD_ENV === "local";

/** Personal account settings need the WorkOS session even before VM-key provisioning succeeds. */
export function getDeusCloudSessionConfig() {
  const deusCloudUrl =
    runtime.deusCloudUrl ??
    process.env.DEUS_CLOUD_URL ??
    (isLocalCloudEnv() ? LOCAL_DEUS_CLOUD_URL : null);
  if (deusCloudUrl) assertSecureCloudUrl(deusCloudUrl);
  return {
    deusCloudUrl,
    deusCloudSessionToken: runtime.deusCloudSessionToken ?? null,
  };
}

/** Product settings use a session even when device-key provisioning is unfinished. */
export function getCloudSettingsConfig() {
  const baseUrl = (
    runtime.baseUrl ??
    process.env.DEUS_CLOUD_AGNT_URL ??
    process.env.AGNT_BASE_URL ??
    (isLocalCloudEnv() ? LOCAL_AGNT_URL : "https://api.deusmachine.ai")
  ).replace(/\/$/, "");
  assertSecureCloudUrl(baseUrl);
  return {
    baseUrl,
    ...getDeusCloudSessionConfig(),
    orgId: runtime.orgId ?? null,
  };
}

/** Read the cloud config (memoized until credentials change). `null` = lane disabled. */
export function getCloudConfig(): CloudConfig | null {
  if (cached !== undefined) return cached;
  const apiKey =
    runtime.apiKey ?? process.env.DEUS_CLOUD_AGNT_API_KEY ?? process.env.AGNT_API_KEY ?? "";
  if (!apiKey) {
    cached = null;
    return cached;
  }
  cached = { ...getCloudSettingsConfig(), apiKey };
  return cached;
}

/**
 * Runtime credential handoff — the seam that makes a key minted mid-session
 * take effect without a process restart. Every getCloudConfig() call site
 * reads the memo, so busting it here is the entire invalidation story.
 */
/**
 * Registered by the cloud driver. Sockets minted under one platform identity
 * must not survive into another: without this, account B's sends rode a
 * session channel authenticated as account A.
 */
let onIdentityChanged: (() => void) | null = null;
let identityController = new AbortController();

/** Pending HTTP requests and response streams belong to the current cloud identity. */
export function getCloudIdentitySignal(): AbortSignal {
  return identityController.signal;
}

export function setCloudIdentityChangedHandler(handler: () => void): void {
  onIdentityChanged = handler;
}

/**
 * Registered by the workspace-init service: runs before the driver opens a
 * session socket. A connect is one of the things that WAKES a paused sandbox
 * (the platform resumes on session registration), and a sandbox E2B has since
 * discarded is then reprovisioned from the DO's stored secret map — whose
 * GitHub App token expires an hour after it was minted. The hook re-mints
 * when that is stale; the driver never blocks a connect on it.
 */
let beforeConnect: ((workspaceId: string) => Promise<void>) | null = null;

export function setCloudConnectHook(hook: (workspaceId: string) => Promise<void>): void {
  beforeConnect = hook;
}

export async function runCloudConnectHook(workspaceId: string): Promise<void> {
  if (beforeConnect) await beforeConnect(workspaceId);
}

/** Cache invalidation only; the platform still verifies the JWT before granting access. */
function sessionPrincipal(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (typeof claims.sub === "string" && claims.sub)
      return JSON.stringify([claims.iss, claims.sub]);
  } catch {
    /* An unreadable token must still invalidate the previous identity. */
  }
  return token;
}

/** Ordinary bearer renewal keeps the same principal and does not tear down live sockets. */
export function getCloudConnectionIdentity(
  config: CloudRuntimeCredentials = getCloudConfig() ?? runtime
): string {
  return JSON.stringify([
    config.apiKey ?? null,
    config.baseUrl ?? null,
    config.orgId ?? null,
    config.deusCloudUrl ?? null,
    sessionPrincipal(config.deusCloudSessionToken ?? undefined),
  ]);
}

export function setCloudRuntimeCredentials(update: CloudRuntimeCredentials): void {
  if (update.baseUrl) assertSecureCloudUrl(update.baseUrl);
  if (update.deusCloudUrl) assertSecureCloudUrl(update.deusCloudUrl);
  const identityBefore = getCloudConnectionIdentity();
  for (const key of [
    "apiKey",
    "baseUrl",
    "deusCloudUrl",
    "deusCloudSessionToken",
    "orgId",
  ] as const) {
    const value = update[key];
    if (value === undefined) continue;
    runtime[key] = value === null ? undefined : value;
  }
  cached = undefined;
  if (getCloudConnectionIdentity() !== identityBefore) {
    const previous = identityController;
    identityController = new AbortController();
    previous.abort(new Error("Your Deus account changed. Try again."));
    onIdentityChanged?.();
  }
}

/** Test seam: clear the memoized config AND runtime overrides. */
export function resetCloudConfigForTests(): void {
  identityController.abort();
  identityController = new AbortController();
  for (const key of Object.keys(runtime) as (keyof CloudRuntimeCredentials)[]) {
    runtime[key] = undefined;
  }
  cached = undefined;
}
