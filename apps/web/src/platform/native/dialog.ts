import { capabilities } from "../capabilities";
import { invoke } from "../electron/invoke";

export async function pickFolder(): Promise<string | null> {
  if (!capabilities.nativeFolderPicker) return null;
  return invoke<string | null>("native:pickFolder");
}

export async function getHomeDir(): Promise<string> {
  if (!capabilities.ipcInvoke) return "~";
  try {
    return (await invoke<string>("native:homeDir")) ?? "~";
  } catch {
    return "~";
  }
}
