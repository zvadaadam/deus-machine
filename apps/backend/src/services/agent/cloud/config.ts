// backend/src/services/agent/cloud/config.ts
// Cloud (agnt) connection config: who is signed in, and the key for each organization.
//
// Two credential sources, merged: environment variables (dev workflow, read
// once) and RUNTIME credentials handed over by the desktop main process (the
// D1 handshake: the person's Deus Cloud session, and one device key per
// organization of the account). Runtime values win.
//
// Three questions, one function each:
//  - cloudAccount(): the signed-in person (base URLs and the session). Null =
//    the cloud lane is off, with honest errors at the create/send boundaries.
//  - cloudOrg(orgId?): the credentials for one organization: its own key (or,
//    when no organization keys were pushed at all, the developer key from the
//    environment). No id = the default organization.
//  - defaultCloudOrgId(): the organization a caller that names none means: the
//    platform's first, as the desktop says.
// The connection identity is the account only: keys come and go per
// organization without closing a socket.

import { assertSecureCloudUrl } from "@shared/cloud-url";
import { ConflictError } from "../../../lib/errors";

export interface CloudAccount {
  /** agnt backend base URL (REST + session WebSockets). */
  baseUrl: string;
  /** Deus Cloud (GitHub App installation tokens, the person's own settings). */
  deusCloudUrl: string | null;
  /**
   * The person's Deus Cloud session. It expires; the desktop re-pushes on auth
   * changes. Null in development with only a fallback key.
   */
  sessionToken: string | null;
  /** The session's `sub`, read unverified (the platform verifies the token). */
  accountId: string | null;
}

export interface CloudOrg {
  /** The organization these credentials act in; null for a fallback key no organization names. */
  orgId: string | null;
  baseUrl: string;
  /** Organization API key (agnt_sk_*). */
  apiKey: string;
}

/** Runtime credential handoff shape. `null` clears a value (falls back to env). */
export interface CloudRuntimeCredentials {
  /** One device key per organization, in the platform's order. Replaces the whole map. */
  orgKeys?: Record<string, string> | null;
  baseUrl?: string | null;
  deusCloudUrl?: string | null;
  deusCloudSessionToken?: string | null;
  /**
   * The default organization: the one the platform lists first, as the desktop last
   * read it. Pushed with the keys, also when that organization's own key is missing.
   */
  orgId?: string | null;
}

type ScalarCredential = Exclude<keyof CloudRuntimeCredentials, "orgKeys">;
const SCALARS: readonly ScalarCredential[] = [
  "baseUrl",
  "deusCloudUrl",
  "deusCloudSessionToken",
  "orgId",
];

const runtime: { [K in ScalarCredential]?: string } = {};
let orgKeys = new Map<string, string>();

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
  const deusCloudUrl = rawDeusCloudUrl();
  if (deusCloudUrl) assertSecureCloudUrl(deusCloudUrl);
  return {
    deusCloudUrl,
    deusCloudSessionToken: runtime.deusCloudSessionToken ?? null,
  };
}

function rawAgntBaseUrl(): string {
  return (
    runtime.baseUrl ??
    process.env.DEUS_CLOUD_AGNT_URL ??
    process.env.AGNT_BASE_URL ??
    (isLocalCloudEnv() ? LOCAL_AGNT_URL : "https://api.deusmachine.ai")
  ).replace(/\/$/, "");
}

function rawDeusCloudUrl(): string | null {
  return (
    runtime.deusCloudUrl ??
    process.env.DEUS_CLOUD_URL ??
    (isLocalCloudEnv() ? LOCAL_DEUS_CLOUD_URL : null)
  );
}

function agntBaseUrl(): string {
  const baseUrl = rawAgntBaseUrl();
  assertSecureCloudUrl(baseUrl);
  return baseUrl;
}

/**
 * The developer key (the environment's, for development and the cloud e2e). It stands
 * in for an organization only while no organization keys were pushed: it is one
 * organization's key, and acting in another with it would record work under the
 * wrong organization.
 */
function fallbackKey(): string | null {
  return process.env.DEUS_CLOUD_AGNT_API_KEY ?? process.env.AGNT_API_KEY ?? null;
}

function sessionSubject(token: string | null): string | null {
  if (!token) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * The signed-in person. Null when this backend holds neither a session nor any
 * key: nothing in the cloud can be reached. A session without keys (provisioning
 * failed) is an account whose organizations are not set up yet.
 */
export function cloudAccount(): CloudAccount | null {
  const { deusCloudUrl, deusCloudSessionToken } = getDeusCloudSessionConfig();
  const baseUrl = agntBaseUrl();
  if (!deusCloudSessionToken && orgKeys.size === 0 && !fallbackKey()) return null;
  return {
    baseUrl,
    deusCloudUrl,
    sessionToken: deusCloudSessionToken,
    accountId: sessionSubject(deusCloudSessionToken),
  };
}

/**
 * The organization a caller that names none means: the one the desktop pushed as
 * the platform's first, whether or not this backend holds its key (a row of it is
 * then refused, not sent with another organization's key). Without one, the first
 * organization a key was pushed for, else null.
 */
export function defaultCloudOrgId(): string | null {
  const [first] = orgKeys.keys();
  return runtime.orgId ?? first ?? null;
}

/** The credentials for one organization; no id = the default organization. Null = no usable key. */
export function cloudOrg(orgId?: string | null): CloudOrg | null {
  const id = orgId ?? defaultCloudOrgId();
  const apiKey = orgKeys.size > 0 ? (id ? orgKeys.get(id) : undefined) : fallbackKey();
  if (!apiKey) return null;
  return { orgId: id, baseUrl: agntBaseUrl(), apiKey };
}

/** A row's organization's credentials. A row with no organization yet is in the default one. */
export function cloudOrgOf(row: { organization_id?: string | null }): CloudOrg | null {
  return cloudOrg(row.organization_id ?? null);
}

/** {@link cloudOrg}, for the calls that cannot go on without the organization's key. */
export function requireCloudOrg(orgId?: string | null): CloudOrg {
  const org = cloudOrg(orgId);
  if (!org) {
    throw new ConflictError(
      "This cloud organization is not set up on this computer. Retry the cloud setup from the sidebar, or sign in to Deus Cloud again."
    );
  }
  return org;
}

/** Organizations this backend holds its own key for, in the platform's order. */
export function cloudOrgKeyIds(): string[] {
  return [...orgKeys.keys()];
}

/** Whether this backend acts with the fallback key: one is set and no organization keys were pushed. */
export function hasFallbackCloudKey(): boolean {
  return orgKeys.size === 0 && fallbackKey() !== null;
}

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
function sessionPrincipal(token: string | null | undefined): string | null {
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

/**
 * Who this backend is in the cloud: the platform's addresses and the session's
 * principal. Keys and organizations are not part of it: adding, removing or
 * replacing an organization's key closes nothing. Ordinary bearer renewal keeps
 * the same principal and does not tear down live sockets.
 */
export function getCloudConnectionIdentity(): string {
  return JSON.stringify([
    rawAgntBaseUrl(),
    rawDeusCloudUrl(),
    sessionPrincipal(runtime.deusCloudSessionToken),
  ]);
}

export function setCloudRuntimeCredentials(update: CloudRuntimeCredentials): void {
  if (update.baseUrl) assertSecureCloudUrl(update.baseUrl);
  if (update.deusCloudUrl) assertSecureCloudUrl(update.deusCloudUrl);
  const identityBefore = getCloudConnectionIdentity();
  for (const key of SCALARS) {
    const value = update[key];
    if (value === undefined) continue;
    runtime[key] = value === null ? undefined : value;
  }
  if (update.orgKeys !== undefined) {
    orgKeys = new Map(Object.entries(update.orgKeys ?? {}).filter(([id, key]) => id && key));
  }
  if (getCloudConnectionIdentity() !== identityBefore) {
    const previous = identityController;
    identityController = new AbortController();
    previous.abort(new Error("Your Deus account changed. Try again."));
    onIdentityChanged?.();
  }
}

/** Test seam: clear the runtime overrides. */
export function resetCloudConfigForTests(): void {
  identityController.abort();
  identityController = new AbortController();
  for (const key of SCALARS) runtime[key] = undefined;
  orgKeys = new Map();
}
