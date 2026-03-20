import { capabilities } from "../capabilities";
import { invoke } from "../electron/invoke";

export interface InstalledApp {
  id: string;
  name: string;
  path: string;
  icon?: string;
}

export async function getInstalled(): Promise<InstalledApp[]> {
  if (!capabilities.openInExternalApp) return [];
  try {
    return (await invoke<InstalledApp[]>("get_installed_apps")) ?? [];
  } catch {
    return [];
  }
}

export async function openIn(appId: string, workspacePath: string): Promise<void> {
  if (!capabilities.openInExternalApp) return;
  await invoke("open_in_app", { appId, workspacePath });
}
