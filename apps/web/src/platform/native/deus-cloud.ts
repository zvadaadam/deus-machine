import { capabilities } from "../capabilities";
import type { DeusCloudAuthResult, DeusCloudSessionStatus } from "@shared/types";

const WEB_SESSION: DeusCloudSessionStatus = {
  signedIn: false,
  accountId: null,
  expiresAt: null,
  tokenType: null,
  cloudUrl: "https://cloud.deusmachine.ai",
  hasPlatformKey: false,
};

export async function getSession(): Promise<DeusCloudSessionStatus> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.getDeusCloudSession) {
    return WEB_SESSION;
  }

  return window.electronAPI.getDeusCloudSession();
}

export async function startLogin(): Promise<DeusCloudAuthResult> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.startDeusCloudLogin) {
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
    return {
      success: false,
      session: WEB_SESSION,
      error: "Deus Cloud sign-out requires the desktop app",
    };
  }

  return window.electronAPI.signOutDeusCloud();
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
  error?: string;
}

export async function getGithubAppStatus(): Promise<GithubAppState> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.getGithubAppStatus) {
    return { configured: false, signedIn: false, installations: [] };
  }
  return window.electronAPI.getGithubAppStatus();
}

export async function installGithubApp(): Promise<{ ok: boolean; error?: string }> {
  if (!capabilities.ipcInvoke || !window.electronAPI?.installGithubApp) {
    return { ok: false, error: "Installing the GitHub App requires the desktop app" };
  }
  return window.electronAPI.installGithubApp();
}
