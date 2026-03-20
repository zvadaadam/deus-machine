import { capabilities } from "../capabilities";

// Updates use window.electronAPI directly (not generic invoke) because
// they need typed return values and event subscriptions.

function api() {
  return capabilities.autoUpdate ? window.electronAPI : null;
}

export async function check(): Promise<unknown> {
  return api()?.checkForUpdates() ?? null;
}

export async function download(): Promise<void> {
  await api()?.downloadUpdate();
}

export async function install(): Promise<void> {
  await api()?.installUpdate();
}

export async function getState(): Promise<unknown> {
  // Update state is delivered reactively via onState() listener.
  // No synchronous getter exists in the preload API.
  return null;
}

export function onState(callback: (state: unknown) => void): () => void {
  return api()?.onUpdateState(callback) ?? (() => {});
}
