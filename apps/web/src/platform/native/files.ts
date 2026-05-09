import { capabilities } from "../capabilities";
import { invoke } from "../electron/invoke";

export async function openPath(filePath: string): Promise<boolean> {
  if (!capabilities.ipcInvoke) return false;
  try {
    return (await invoke<boolean>("native:openPath", { filePath })) ?? false;
  } catch {
    return false;
  }
}

export async function revealInFinder(filePath: string): Promise<boolean> {
  if (!capabilities.ipcInvoke) return false;
  try {
    return (await invoke<boolean>("native:revealInFinder", { filePath })) ?? false;
  } catch {
    return false;
  }
}
