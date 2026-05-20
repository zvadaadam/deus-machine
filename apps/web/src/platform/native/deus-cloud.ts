import { capabilities } from "../capabilities";
import type { DeusCloudAuthResult, DeusCloudSessionStatus } from "@shared/types";

const WEB_SESSION: DeusCloudSessionStatus = {
  signedIn: false,
  accountId: null,
  expiresAt: null,
  tokenType: null,
  cloudUrl: "https://cloud.deusmachine.ai",
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
