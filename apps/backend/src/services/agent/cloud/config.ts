// backend/src/services/agent/cloud/config.ts
// Cloud-workspace (agnt) connection config.
//
// Two credential sources, merged: environment variables (dev workflow, read
// once) and RUNTIME credentials handed over by the desktop main process (the
// D1 handshake — a per-device key minted after sign-in, tokens saved in
// Settings). Runtime values win. `null` config = cloud lane disabled with
// honest errors at the create/send boundaries.

export interface CloudConfig {
  /** agnt backend base URL (REST + session WebSockets). */
  baseUrl: string;
  /** Organization API key (agnt_sk_*). */
  apiKey: string;
  /** BYOK Anthropic key for turn execution (proxied sandbox-side, turn-scoped). */
  anthropicApiKey: string | null;
  /**
   * Claude subscription token (`claude setup-token`, sk-ant-oat01-…).
   * PREFERRED over anthropicApiKey when present — deus picks the per-turn
   * credential explicitly, so subscription-first is a rule here, not an
   * env-ordering accident.
   */
  claudeOauthToken: string | null;
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
  anthropicApiKey?: string | null;
  claudeOauthToken?: string | null;
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

/** Read the cloud config (memoized until credentials change). `null` = lane disabled. */
export function getCloudConfig(): CloudConfig | null {
  if (cached !== undefined) return cached;
  const apiKey =
    runtime.apiKey ?? process.env.DEUS_CLOUD_AGNT_API_KEY ?? process.env.AGNT_API_KEY ?? "";
  if (!apiKey) {
    cached = null;
    return cached;
  }
  cached = {
    baseUrl: (
      runtime.baseUrl ??
      process.env.DEUS_CLOUD_AGNT_URL ??
      process.env.AGNT_BASE_URL ??
      (isLocalCloudEnv() ? LOCAL_AGNT_URL : "https://api.deusmachine.ai")
    ).replace(/\/$/, ""),
    apiKey,
    anthropicApiKey:
      runtime.anthropicApiKey ??
      process.env.DEUS_CLOUD_ANTHROPIC_KEY ??
      process.env.ANTHROPIC_API_KEY ??
      null,
    claudeOauthToken: runtime.claudeOauthToken ?? null,
    deusCloudUrl:
      runtime.deusCloudUrl ??
      process.env.DEUS_CLOUD_URL ??
      (isLocalCloudEnv() ? LOCAL_DEUS_CLOUD_URL : null),
    deusCloudSessionToken: runtime.deusCloudSessionToken ?? null,
    orgId: runtime.orgId ?? null,
  };
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

export function setCloudIdentityChangedHandler(handler: () => void): void {
  onIdentityChanged = handler;
}

export function setCloudRuntimeCredentials(update: CloudRuntimeCredentials): void {
  const identityBefore = `${runtime.apiKey}|${runtime.baseUrl}|${runtime.orgId}`;
  for (const key of [
    "apiKey",
    "baseUrl",
    "anthropicApiKey",
    "claudeOauthToken",
    "deusCloudUrl",
    "deusCloudSessionToken",
    "orgId",
  ] as const) {
    const value = update[key];
    if (value === undefined) continue;
    runtime[key] = value === null ? undefined : value;
  }
  cached = undefined;
  if (`${runtime.apiKey}|${runtime.baseUrl}|${runtime.orgId}` !== identityBefore) {
    onIdentityChanged?.();
  }
}

/** Test seam: clear the memoized config AND runtime overrides. */
export function resetCloudConfigForTests(): void {
  for (const key of Object.keys(runtime) as (keyof CloudRuntimeCredentials)[]) {
    runtime[key] = undefined;
  }
  cached = undefined;
}
