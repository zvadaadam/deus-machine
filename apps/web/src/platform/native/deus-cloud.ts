import { capabilities } from "../capabilities";
import { api } from "@shared/api";
import { getErrorMessage } from "@shared/lib/errors";
import type { DeusCloudAuthResult, DeusCloudSessionStatus } from "@shared/types";
import type { GithubAppState } from "@shared/types/github";
import { call } from "@/platform/ws";
import { CLOUD_SESSION_KEY, cloudSessionClaims } from "@/platform/ws/cloud-session";
import { openExternalPending } from "./window";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { isRelayMode } from "@/shared/config/backend.config";
import { queryClient } from "@/shared/api/queryClient";
import { applyDeusCloudAuthChange } from "@/shared/api/cloudAuthCache";
import {
  clearWebCloudSession,
  beginWebCloudLogin,
  markWebCloudSignOut,
  resolveDeusCloudUrl,
} from "@/features/session/cloud/webCloudDirectConfig";

const WEB_SESSION: DeusCloudSessionStatus = {
  signedIn: false,
  accountId: null,
  expiresAt: null,
  tokenType: null,
  cloudUrl: "https://cloud.deusmachine.ai",
  hasPlatformKey: false,
};

/**
 * A browser holds its own Deus Cloud session in web-direct mode and to reach a
 * computer through the relay; only the desktop app signs in through its main process.
 */
const browserSession = (): boolean => isCloudDirectWebMode() || isRelayMode();

/**
 * In web-direct mode the browser's own bearer IS the Deus Cloud session — the
 * canonical session query must reflect it, or Settings tells a signed-in web
 * user they're signed out and offers desktop-only buttons. Claims are read from
 * the JWT payload (display only; agnt verifies the signature on every request).
 */
function webDirectSession(): DeusCloudSessionStatus | null {
  try {
    const bearer = sessionStorage.getItem(CLOUD_SESSION_KEY);
    if (bearer === null) return null;
    const payload = cloudSessionClaims(bearer);
    // Retire the account's cache and direct socket on this passive check. A 401 handles re-auth.
    if (!payload || (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now())) {
      clearWebCloudSession();
      applyDeusCloudAuthChange(queryClient, { ...WEB_SESSION, cloudUrl: resolveDeusCloudUrl() });
      return null;
    }
    return {
      signedIn: true,
      accountId: payload.sub,
      expiresAt:
        typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null,
      tokenType: "Bearer",
      cloudUrl: resolveDeusCloudUrl(),
      hasPlatformKey: false,
    };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<DeusCloudSessionStatus> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.getDeusCloudSession) {
    if (browserSession()) {
      return webDirectSession() ?? { ...WEB_SESSION, cloudUrl: resolveDeusCloudUrl() };
    }
    return WEB_SESSION;
  }

  return window.electronAPI.getDeusCloudSession();
}

export async function startLogin(): Promise<DeusCloudAuthResult> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.startDeusCloudLogin) {
    if (browserSession()) {
      // Full-page redirect through the deus-web WorkOS flow; the promise result
      // is moot once navigation starts.
      beginWebCloudLogin(`${window.location.pathname}${window.location.search}`);
      return { success: true, session: webDirectSession() ?? WEB_SESSION };
    }
    return {
      success: false,
      session: WEB_SESSION,
      error: "Deus Cloud sign-in requires the desktop app",
    };
  }

  return window.electronAPI.startDeusCloudLogin();
}

export async function signOut(): Promise<DeusCloudAuthResult> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.signOutDeusCloud) {
    if (browserSession()) {
      // The browser also holds deus-cloud's own session cookie (set by the
      // login callback) and POST /auth/logout is what clears it. Best-effort:
      // local sign-out must not hang on an unreachable auth origin, and
      // WorkOS's hosted session isn't ours to end from here.
      // Local state goes FIRST — a stalled auth origin must never keep the
      // bearer (and its live direct socket) alive; the cookie cleanup is
      // best-effort and bounded. Marked as deliberate before the reset below:
      // its refetches meet the missing bearer, and the expiry handler must
      // not read that as "re-authenticate".
      markWebCloudSignOut();
      clearWebCloudSession();
      // The account boundary is NOW, not when the remote call settles: drop
      // every account-scoped cache and the direct token (which tears its
      // socket down) before the bounded logout — the caller's own teardown on
      // resolve is idempotent.
      const signedOut = { ...WEB_SESSION, cloudUrl: resolveDeusCloudUrl() };
      applyDeusCloudAuthChange(queryClient, signedOut);
      await fetch(`${resolveDeusCloudUrl()}/auth/logout`, {
        method: "POST",
        credentials: "include",
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
      return { success: true, session: signedOut };
    }
    return {
      success: false,
      session: WEB_SESSION,
      error: "Deus Cloud sign-out requires the desktop app",
    };
  }

  return window.electronAPI.signOutDeusCloud();
}

/** Re-run device-key provisioning after a failed post-login mint. */
export async function retryProvision(): Promise<{ ok: boolean; error?: string }> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.retryDeusCloudProvision) {
    return { ok: false, error: "Cloud setup requires the desktop app" };
  }
  return (await window.electronAPI.retryDeusCloudProvision()) as { ok: boolean; error?: string };
}

export function onAuthChanged(callback: (session: DeusCloudSessionStatus) => void): () => void {
  if (!capabilities.ipcEventListeners || !window.electronAPI?.onDeusCloudAuthChanged) {
    return () => {};
  }

  return window.electronAPI.onDeusCloudAuthChanged(callback);
}

/** The Deus GitHub App for an organization (the default one when none is named). */
export const getGithubAppStatus = (organizationId?: string | null): Promise<GithubAppState> =>
  call(api.githubApp, { organizationId });

/** Whether this client can install the GitHub App: any client with a computer behind it. */
export const canInstallGithubApp = (): boolean => !isCloudDirectWebMode();

/** Open GitHub's page to install the Deus GitHub App for an organization (the default one when none is named). */
export async function installGithubApp(
  organizationId?: string | null
): Promise<{ ok: boolean; error?: string }> {
  const tab = openExternalPending();
  try {
    await tab.open((await call(api.githubAppInstallUrl, { organizationId })).url);
    return { ok: true };
  } catch (error) {
    tab.cancel();
    return { ok: false, error: getErrorMessage(error) };
  }
}
