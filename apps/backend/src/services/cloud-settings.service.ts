import { toCamelCaseKeys } from "@deus-hq/api";
import type {
  CloudOrganizations,
  CloudSettingsOrganizations,
} from "@shared/types/environment-secrets";
import type { GithubAppState } from "@shared/types/github";
import { AppError } from "../lib/errors";
import { invalidate } from "./query-engine";
import {
  cloudAccount,
  cloudOrg,
  cloudOrgKeyIds,
  defaultCloudOrgId,
  getCloudConnectionIdentity,
  getCloudIdentitySignal,
} from "./agent/cloud/config";

/** Fixed dashboard paths use the human's session, never the organization SDK key. */
export async function requestCloudSettings(
  path: string,
  init: RequestInit = {},
  service: "platform" | "product" = "platform"
) {
  const config = cloudAccount();
  if (!config?.sessionToken)
    throw new AppError(401, "Sign in to Deus Cloud to manage cloud settings.");
  const identity = getCloudIdentitySignal();
  const base = service === "platform" ? `${config.baseUrl}/dashboard` : config.deusCloudUrl;
  if (!base) throw new AppError(503, "Deus Cloud is not configured.");
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.sessionToken}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.any([
        identity,
        AbortSignal.timeout(15_000),
        ...(init.signal ? [init.signal] : []),
      ]),
      redirect: "manual",
    });
    const data = response.ok ? await response.json() : await response.json().catch(() => null);
    identity.throwIfAborted();
    if (!response.ok) {
      const errorBody = data as { message?: unknown; code?: unknown } | null;
      throw new AppError(
        response.status,
        typeof errorBody?.message === "string"
          ? errorBody.message
          : !init.method || init.method === "GET"
            ? "Couldn't load cloud settings."
            : "Couldn't update cloud settings.",
        typeof errorBody?.code === "string" ? { code: errorBody.code } : undefined
      );
    }
    return toCamelCaseKeys(data, { opaqueKeys: ["project"] });
  } catch (error) {
    if (identity.aborted) throw new AppError(409, "Your Deus account changed. Try again.");
    throw error;
  }
}

/**
 * The `owner/name` of every repository the organization's GitHub App can reach,
 * asked of Deus Cloud with the person's session. Settings → Environments reads
 * it through its HTTP proxy, the add-repository dialog as `cloudRepositories`.
 */
export async function listAccessibleRepos(
  orgId: string,
  signal?: AbortSignal
): Promise<{ repos: string[] }> {
  const data = (await requestCloudSettings(
    `/orgs/${encodeURIComponent(orgId)}/github/accessible-repos`,
    signal ? { signal } : {},
    "product"
  )) as { repos?: unknown } | null;
  const repos = Array.isArray(data?.repos)
    ? data.repos.filter((name): name is string => typeof name === "string")
    : [];
  return { repos };
}

/**
 * The organization's Deus GitHub App, asked of Deus Cloud with the person's
 * session. A 503 (the App is not registered) or a 404 (the routes are not
 * deployed) is "not configured": nothing the person can act on yet.
 */
export async function getGithubApp(orgId: string | null): Promise<GithubAppState> {
  const none = { installations: [], appSlug: null, accessibleRepos: null };
  if (!cloudAccount()?.sessionToken || !orgId)
    return { ...none, configured: false, signedIn: false };
  let body: {
    installations?: Array<{ githubInstallationIdentifier: number; accountLogin: string }>;
    appSlug?: string | null;
  };
  try {
    body = await requestCloudSettings(
      `/orgs/${encodeURIComponent(orgId)}/github/installation`,
      {},
      "product"
    );
  } catch (error) {
    const status = error instanceof AppError ? error.statusCode : null;
    if (status === 503 || status === 404) return { ...none, configured: false, signedIn: true };
    return {
      ...none,
      configured: !!status,
      signedIn: true,
      error: status ? `status ${status}` : "offline",
    };
  }
  const installations = (body.installations ?? []).map((item) => ({
    installationId: item.githubInstallationIdentifier,
    accountLogin: item.accountLogin,
  }));
  return {
    configured: !!body.appSlug,
    signedIn: true,
    installations,
    appSlug: body.appSlug ?? null,
    accessibleRepos: installations.length
      ? await listAccessibleRepos(orgId).then(
          ({ repos }) => repos,
          () => null
        )
      : [],
  };
}

/** The settings pages' list: the platform's answer, passed through. */
export async function getCloudSettingsOrganizations(): Promise<CloudSettingsOrganizations> {
  return (await requestCloudSettings("/orgs")) as CloudSettingsOrganizations;
}

const ORGANIZATIONS_TTL_MS = 60_000;

/** The platform's list, as last read under one identity (`read`: which read gave it). */
let organizations: {
  identity: string;
  fetchedAt: number;
  read: number;
  list: CloudSettingsOrganizations;
} | null = null;
/** Every read is numbered: two can be in flight, and the older one may answer last. */
let reads = 0;
/** The read under way, if any (one per identity: an identity change abandons it). */
let fetching: { identity: string; list: Promise<CloudSettingsOrganizations> } | null = null;
/** The value subscribers were last sent, so an unchanged one is not sent again. */
let published: string | null = null;

/** The list read under the current identity, however old. Another identity's is dropped. */
function listedOrganizations(): CloudSettingsOrganizations | null {
  if (organizations && organizations.identity !== getCloudConnectionIdentity()) {
    organizations = null;
  }
  return organizations?.list ?? null;
}

/** Read the platform's list now (sharing a read already under way for this identity). */
function fetchOrganizations(): Promise<CloudSettingsOrganizations> {
  const identity = getCloudConnectionIdentity();
  if (fetching?.identity === identity) return fetching.list;
  const list = requestCloudSettings("/orgs") as Promise<CloudSettingsOrganizations>;
  const entry = { identity, list };
  const read = ++reads;
  fetching = entry;
  void list.then(
    (data) => {
      if (fetching === entry) fetching = null;
      // An answer for a previous identity is not this one's.
      if (identity !== getCloudConnectionIdentity()) return;
      // An answer older than the list held already says less than it.
      if (organizations?.identity === identity && organizations.read > read) return;
      organizations = { identity, fetchedAt: Date.now(), read, list: data };
      publishCloudOrganizations();
    },
    () => {
      // A failure keeps the last list read under this identity, and changes nothing.
      if (fetching === entry) fetching = null;
    }
  );
  return list;
}

/** The platform's list for this account, at most a minute old. */
function freshOrganizations(): Promise<CloudSettingsOrganizations> {
  const listed = listedOrganizations();
  if (listed && organizations && Date.now() - organizations.fetchedAt < ORGANIZATIONS_TTL_MS) {
    return Promise.resolve(listed);
  }
  return fetchOrganizations();
}

/**
 * This backend's cloud, for every client (`cloudOrganizations`, a live read, so
 * synchronous): the last list the platform gave for this identity, each organization
 * `ready` by the keys held now. Signed out with no key, nothing; a list older than a
 * minute is read again in the background, and subscribers are sent the change.
 */
export function getCloudOrganizations(): CloudOrganizations {
  // A read never sets `published`: only a publish says what subscribers were sent.
  const value = currentCloudOrganizations();
  const account = cloudAccount();
  if (
    account?.sessionToken &&
    !fetching &&
    (!organizations || Date.now() - organizations.fetchedAt >= ORGANIZATIONS_TTL_MS)
  ) {
    fetchOrganizations().catch(() => {});
  }
  return value;
}

function currentCloudOrganizations(): CloudOrganizations {
  const account = cloudAccount();
  if (!account) {
    return { available: false, accountId: null, defaultOrganizationId: null, items: [] };
  }
  const list = account.sessionToken ? listedOrganizations() : null;
  const items = (list?.items ?? []).map((org) => ({
    id: org.id,
    name: org.name,
    role: org.role,
    ready: cloudOrg(org.id) !== null,
  }));
  return {
    // Any organization this backend can act in: the default one's key may be the one missing.
    available: cloudOrg() !== null || cloudOrgKeyIds().length > 0,
    accountId: list?.accountId ?? null,
    defaultOrganizationId: defaultCloudOrgId() ?? items[0]?.id ?? null,
    items,
  };
}

/** Tell subscribers the value changed, when it did. */
function publishCloudOrganizations(): void {
  const next = JSON.stringify(currentCloudOrganizations());
  if (next === published) return;
  published = next;
  invalidate(["cloudOrganizations"]);
}

/**
 * Credentials changed (pushed by the desktop: a sign-in, a sign-out, an account
 * switch, keys minted), or the backend started with an account: what can be said
 * now is sent at once (signed out, another person's list dropped, `ready` by the
 * new keys), and the list is read again from the platform.
 */
export function refreshCloudOrganizations(): void {
  publishCloudOrganizations();
  if (!cloudAccount()?.sessionToken) return;
  fetching = null;
  fetchOrganizations().catch(() => {});
}

/** Test seam: forget the list. */
export function resetCloudOrganizationsForTests(): void {
  organizations = null;
  fetching = null;
  published = null;
}

/**
 * SDK user scopes are explicit. Obtain ours from the verified dashboard session,
 * and check the person is still a member of the organization the work is in.
 */
export async function getCloudWorkspaceUserId(orgId: string | null): Promise<string | undefined> {
  if (!cloudAccount()?.sessionToken) return undefined;
  const member = (list: CloudSettingsOrganizations) =>
    !!list.accountId && !!orgId && list.items.some((org) => org.id === orgId);
  let context = await freshOrganizations();
  // An organization joined since the list was read: ask once more before refusing.
  if (!member(context) && orgId) context = await fetchOrganizations();
  if (!member(context)) {
    throw new AppError(403, "Your cloud organization changed. Sign in to Deus Cloud again.");
  }
  return context.accountId;
}
