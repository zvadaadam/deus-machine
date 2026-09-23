import { capabilities } from "../capabilities";
import { invoke } from "../electron/invoke";

export async function show(): Promise<void> {
  if (!capabilities.windowLifecycle) return;
  await invoke("show_main_window");
}

export async function setTitle(title: string): Promise<void> {
  if (!capabilities.windowLifecycle) return;
  await invoke("native:setTitle", { title });
}

export async function setZoom(level: number): Promise<void> {
  if (!capabilities.nativeWindowChrome) return;
  await invoke("native:setZoom", { level });
}

export async function openExternal(url: string): Promise<void> {
  if (!isHttpUrl(url)) return;

  if (window.electronAPI?.openExternal) {
    await window.electronAPI.openExternal(url);
    return;
  }

  if (capabilities.ipcInvoke) {
    await invoke("native:openExternal", { url });
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

/** A tab opened during a click, for a URL a request is still fetching. */
export interface PendingExternalWindow {
  open(url: string): Promise<void>;
  cancel(): void;
}

/**
 * `openExternal` for a URL the click has to fetch first. A browser allows a
 * new tab only while it handles the click, so the tab opens now, blank, and
 * goes to the URL when `open` gets it; call this synchronously in the click
 * handler. The desktop app opens URLs in the system browser and reserves none.
 */
export function openExternalPending(): PendingExternalWindow {
  if (window.electronAPI?.openExternal || capabilities.ipcInvoke) {
    return { open: openExternal, cancel: () => {} };
  }

  const tab = window.open("about:blank", "_blank");
  // What the tab loads must not reach back into this window.
  if (tab) tab.opener = null;
  return {
    async open(url) {
      if (!isHttpUrl(url)) {
        tab?.close();
        return;
      }
      // Blocked even during the click: go there in this window, not nowhere.
      if (!tab) window.location.assign(url);
      else if (!tab.closed) tab.location.replace(url);
    },
    cancel: () => tab?.close(),
  };
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function enterOnboarding(): Promise<void> {
  if (!capabilities.nativeOnboarding) return;
  await invoke("enter_onboarding_mode");
}

export async function exitOnboarding(): Promise<void> {
  if (!capabilities.nativeOnboarding) return;
  await invoke("exit_onboarding_mode");
}
