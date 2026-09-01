import { capabilities } from "../capabilities";
import type { DeusCloudAuthResult, DeusCloudSessionStatus } from "@shared/types";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import {
  clearWebCloudSession,
  beginWebCloudLogin,
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
 * In web-direct mode the browser's own bearer IS the Deus Cloud session — the
 * canonical session query must reflect it, or Settings tells a signed-in web
 * user they're signed out and offers desktop-only buttons. Claims are read from
 * the JWT payload (display only; agnt verifies the signature on every request).
 */
function webDirectSession(): DeusCloudSessionStatus | null {
  try {
    const bearer = sessionStorage.getItem("deus_cloud_session");
    if (!bearer) return null;
    const payload = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return {
      signedIn: true,
      accountId: typeof payload.sub === "string" ? payload.sub : null,
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
    if (isCloudDirectWebMode()) {
      return webDirectSession() ?? { ...WEB_SESSION, cloudUrl: resolveDeusCloudUrl() };
    }
    return WEB_SESSION;
  }

  return window.electronAPI.getDeusCloudSession();
}

export async function startLogin(): Promise<DeusCloudAuthResult> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.startDeusCloudLogin) {
    if (isCloudDirectWebMode()) {
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
    if (isCloudDirectWebMode()) {
      clearWebCloudSession();
      return { success: true, session: { ...WEB_SESSION, cloudUrl: resolveDeusCloudUrl() } };
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

export type ClaudeSubscriptionState = import("@shared/types").ClaudeSubscriptionResult;

const WEB_SUBSCRIPTION: ClaudeSubscriptionState = {
  success: false,
  hasClaudeSubscription: false,
  error: "Claude subscription connect requires the desktop app",
};

export async function getClaudeSubscriptionStatus(): Promise<ClaudeSubscriptionState> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.getClaudeSubscriptionStatus) {
    return { ...WEB_SUBSCRIPTION, success: true, error: undefined };
  }
  return window.electronAPI.getClaudeSubscriptionStatus();
}

export async function openAgentSetupTerminal(
  agentId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.openAgentSetupTerminal) {
    return { ok: false, error: "Opening a terminal requires the desktop app" };
  }
  return window.electronAPI.openAgentSetupTerminal(agentId);
}

export async function saveClaudeSubscriptionToken(token: string): Promise<ClaudeSubscriptionState> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.saveClaudeSubscriptionToken) {
    return WEB_SUBSCRIPTION;
  }
  return window.electronAPI.saveClaudeSubscriptionToken(token);
}

export async function disconnectClaudeSubscription(): Promise<ClaudeSubscriptionState> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.disconnectClaudeSubscription) {
    return WEB_SUBSCRIPTION;
  }
  return window.electronAPI.disconnectClaudeSubscription();
}

export interface GithubAppState {
  configured: boolean;
  signedIn: boolean;
  installations: Array<{ installationId: number; accountLogin: string }>;
  appSlug: string | null;
  /** null = lookup failed; unknown is not "none". */
  accessibleRepos: string[] | null;
  error?: string;
}

export async function getGithubAppStatus(): Promise<GithubAppState> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.getGithubAppStatus) {
    return {
      configured: false,
      signedIn: false,
      installations: [],
      appSlug: null,
      accessibleRepos: [],
    };
  }
  return window.electronAPI.getGithubAppStatus();
}

export async function installGithubApp(): Promise<{ ok: boolean; error?: string }> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.installGithubApp) {
    return { ok: false, error: "Installing the GitHub App requires the desktop app" };
  }
  return window.electronAPI.installGithubApp();
}

export type CodexSubscriptionState = import("@shared/types").CodexSubscriptionResult;

const WEB_CODEX: CodexSubscriptionState = {
  success: false,
  hasCodexSubscription: false,
  error: "Codex subscription connect requires the desktop app",
};

export async function getCodexSubscriptionStatus(): Promise<CodexSubscriptionState> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.getCodexSubscriptionStatus) {
    return { ...WEB_CODEX, success: true, error: undefined };
  }
  return window.electronAPI.getCodexSubscriptionStatus();
}

export async function importCodexAuth(): Promise<CodexSubscriptionState> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.importCodexAuth) {
    return WEB_CODEX;
  }
  return window.electronAPI.importCodexAuth();
}

/** One-click ChatGPT sign-in: main spawns `codex login`, imports the result. */
export async function startCodexLogin(): Promise<CodexSubscriptionState> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.startCodexLogin) {
    return { success: false, hasCodexSubscription: false, error: "Requires the desktop app" };
  }
  return window.electronAPI.startCodexLogin() as Promise<CodexSubscriptionState>;
}

export async function disconnectCodexSubscription(): Promise<CodexSubscriptionState> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.disconnectCodexSubscription) {
    return WEB_CODEX;
  }
  return window.electronAPI.disconnectCodexSubscription();
}
