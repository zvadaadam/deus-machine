// GitHub App linking from the desktop: the browser does the installing on
// GitHub's own pages; main only fetches the signed install URL from
// deus-cloud (session-token auth) and opens it, then reads back the linked
// state. No tokens, no keys — pointers and URLs only.

import { shell } from "electron";
import { ipcMain } from "electron";
import { listOrgKeys } from "./cloud-credentials";
import { PLATFORM_TIMEOUT_MS } from "./deus-cloud-provision";
import { getStoredDeusCloudSessionToken } from "./deus-cloud-auth";
import { resolveDeusCloudUrl } from "./deus-cloud-auth-contract";

export interface GithubAppState {
  /** deus-cloud has the App registered/configured (503 until then). */
  configured: boolean;
  signedIn: boolean;
  installations: Array<{ installationId: number; accountLogin: string }>;
  /** App slug for install deep links (null until registered). */
  appSlug: string | null;
  /** owner/name list the installations can access (live from GitHub).
   *  null = the lookup FAILED — unknown is not the same as "none": treating
   *  a timeout as an empty list rendered every repo as missing access. */
  accessibleRepos: string[] | null;
  error?: string;
}

const EMPTY_STATE: Omit<GithubAppState, "configured" | "signedIn"> = {
  installations: [],
  appSlug: null,
  accessibleRepos: null,
};

/**
 * The session, and the organization asked about: `orgId` when given, else the
 * default organization (the first this device holds a key for, as the backend
 * counts it).
 */
async function orgContext(orgId?: string): Promise<{ token: string; orgId: string } | null> {
  const [token, keys] = await Promise.all([
    getStoredDeusCloudSessionToken().catch(() => null),
    orgId ? Promise.resolve([]) : listOrgKeys().catch(() => []),
  ]);
  const id = orgId ?? keys[0]?.orgId;
  if (!token || !id) return null;
  return { token, orgId: id };
}

/** Only a non-empty string names an organization; anything else (IPC from older callers) is the default. */
function orgIdArgument(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function getGithubAppState(orgId?: string): Promise<GithubAppState> {
  const context = await orgContext(orgId);
  if (!context) {
    return { ...EMPTY_STATE, configured: false, signedIn: false };
  }
  const base = `${resolveDeusCloudUrl()}/orgs/${encodeURIComponent(context.orgId)}/github`;
  const headers = { authorization: `Bearer ${context.token}` };
  try {
    const res = await fetch(`${base}/installation`, {
      headers,
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    });
    // 503 = App not registered; 404 = routes not deployed — both read as
    // not-configured (nothing actionable for the user yet).
    if (res.status === 503 || res.status === 404) {
      return { ...EMPTY_STATE, configured: false, signedIn: true };
    }
    if (!res.ok) {
      return { ...EMPTY_STATE, configured: true, signedIn: true, error: `status ${res.status}` };
    }
    // REST is snake_case; internal shape stays camelCase — map at the seam.
    const body = (await res.json()) as {
      installations?: Array<{ github_installation_identifier: number; account_login: string }>;
      app_slug?: string | null;
    };
    const installations = (body.installations ?? []).map((i) => ({
      installationId: i.github_installation_identifier,
      accountLogin: i.account_login,
    }));
    let accessibleRepos: string[] | null = installations.length > 0 ? null : [];
    if (installations.length > 0) {
      const reposRes = await fetch(`${base}/accessible-repos`, {
        headers,
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      }).catch(() => null);
      if (reposRes?.ok) {
        accessibleRepos = ((await reposRes.json()) as { repos?: string[] }).repos ?? [];
      }
    }
    return {
      configured: Boolean(body.app_slug),
      signedIn: true,
      installations,
      appSlug: body.app_slug ?? null,
      accessibleRepos,
    };
  } catch {
    return { ...EMPTY_STATE, configured: false, signedIn: true, error: "offline" };
  }
}

export async function startGithubAppInstall(
  orgId?: string
): Promise<{ ok: boolean; error?: string }> {
  const context = await orgContext(orgId);
  if (!context) return { ok: false, error: "Sign in to Deus Cloud first" };
  const orgPath = encodeURIComponent(context.orgId);
  try {
    const res = await fetch(`${resolveDeusCloudUrl()}/orgs/${orgPath}/github/install-url`, {
      headers: { authorization: `Bearer ${context.token}` },
      // Bounded like every other user-visible platform call: unbounded, a
      // black-holed endpoint held the Install click for undici's 300s while
      // the button stayed clickable and stacked more hung requests.
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    });
    if (res.status === 404) {
      return { ok: false, error: "GitHub linking is unavailable in this cloud environment." };
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
      const message = body && typeof body.message === "string" ? body.message : null;
      return {
        ok: false,
        error: message ?? `Couldn't start GitHub linking (${res.status}). Try again.`,
      };
    }
    const body = (await res.json()) as { url?: string };
    if (!body.url) return { ok: false, error: "No install URL returned" };
    // shell.openExternal hands the string to the OS, which will happily launch
    // non-http schemes. This URL comes off the network, so it is only ever
    // allowed to be the GitHub installation page it claims to be.
    let installUrl: URL;
    try {
      installUrl = new URL(body.url);
    } catch {
      return { ok: false, error: "Install URL was not a valid URL" };
    }
    if (installUrl.protocol !== "https:" || installUrl.hostname !== "github.com") {
      return { ok: false, error: "Install URL did not point at github.com" };
    }
    await shell.openExternal(installUrl.toString());
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach Deus Cloud" };
  }
}

export function registerGithubAppHandlers(): void {
  // An optional organization id; callers that pass nothing get the default organization.
  ipcMain.handle("deus_cloud:github_app_status", (_event, orgId?: unknown) =>
    getGithubAppState(orgIdArgument(orgId))
  );
  ipcMain.handle("deus_cloud:github_app_install", (_event, orgId?: unknown) =>
    startGithubAppInstall(orgIdArgument(orgId))
  );
}
