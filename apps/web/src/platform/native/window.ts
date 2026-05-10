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
