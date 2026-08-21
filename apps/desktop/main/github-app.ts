// GitHub App linking from the desktop: the browser does the installing on
// GitHub's own pages; main only fetches the signed install URL from
// deus-cloud (session-token auth) and opens it, then reads back the linked
// state. No tokens, no keys — pointers and URLs only.

import { shell } from "electron";
import { ipcMain } from "electron";
import { getCloudCredentialMeta } from "./cloud-credentials";
import { getStoredDeusCloudSessionToken } from "./deus-cloud-auth";
import { resolveDeusCloudUrl } from "./deus-cloud-auth-contract";

export interface GithubAppState {
  /** deus-cloud has the App registered/configured (503 until then). */
  configured: boolean;
  signedIn: boolean;
  installations: Array<{ installationId: number; accountLogin: string }>;
  /** App slug for install deep links (null until registered). */
  appSlug: string | null;
  /** owner/name list the installations can access (live from GitHub). */
  accessibleRepos: string[];
  error?: string;
}

const EMPTY_STATE: Omit<GithubAppState, "configured" | "signedIn"> = {
  installations: [],
  appSlug: null,
  accessibleRepos: [],
};

async function orgContext(): Promise<{ token: string; orgId: string } | null> {
  const [token, meta] = await Promise.all([
    getStoredDeusCloudSessionToken().catch(() => null),
    getCloudCredentialMeta("agntApiKey").catch(() => null),
  ]);
  if (!token || !meta?.orgId) return null;
  return { token, orgId: meta.orgId };
}

export async function getGithubAppState(): Promise<GithubAppState> {
  const context = await orgContext();
  if (!context) {
    return { ...EMPTY_STATE, configured: false, signedIn: false };
  }
  const base = `${resolveDeusCloudUrl()}/orgs/${context.orgId}/github`;
  const headers = { authorization: `Bearer ${context.token}` };
  try {
    const res = await fetch(`${base}/installation`, { headers });
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
    let accessibleRepos: string[] = [];
    if (installations.length > 0) {
      const reposRes = await fetch(`${base}/accessible-repos`, { headers }).catch(() => null);
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

export async function startGithubAppInstall(): Promise<{ ok: boolean; error?: string }> {
  const context = await orgContext();
  if (!context) return { ok: false, error: "Sign in to Deus Cloud first" };
  try {
    const res = await fetch(`${resolveDeusCloudUrl()}/orgs/${context.orgId}/github/install-url`, {
      headers: { authorization: `Bearer ${context.token}` },
    });
    if (res.status === 503 || res.status === 404) {
      return { ok: false, error: "The Deus GitHub App isn't registered yet" };
    }
    if (!res.ok) return { ok: false, error: `install-url failed (${res.status})` };
    const body = (await res.json()) as { url?: string };
    if (!body.url) return { ok: false, error: "No install URL returned" };
    await shell.openExternal(body.url);
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach Deus Cloud" };
  }
}

export function registerGithubAppHandlers(): void {
  ipcMain.handle("deus_cloud:github_app_status", () => getGithubAppState());
  ipcMain.handle("deus_cloud:github_app_install", () => startGithubAppInstall());
}
