import { capabilities } from "../capabilities";
import { invoke } from "../electron/invoke";

export interface WorkspaceFileTarget extends Record<string, unknown> {
  workspaceId: string;
  relativePath: string;
}

export async function openPath(target: WorkspaceFileTarget): Promise<boolean> {
  if (!capabilities.ipcInvoke) return false;
  try {
    return (await invoke<boolean>("native:openPath", target)) ?? false;
  } catch {
    return false;
  }
}

export async function revealInFinder(target: WorkspaceFileTarget): Promise<boolean> {
  if (!capabilities.ipcInvoke) return false;
  try {
    return (await invoke<boolean>("native:revealInFinder", target)) ?? false;
  } catch {
    return false;
  }
}
