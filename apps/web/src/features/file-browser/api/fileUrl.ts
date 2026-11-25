import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { RuntimeError, type RuntimeClient } from "@/platform/ws/runtime-client";
import { resolveBackendEndpoints } from "@/shared/config/backend.config";

export type FileLocation =
  | [kind: "recording", path: string]
  | [kind: "preview", path: string, workspaceId: string];

export async function readFileUrl(
  [kind, path, workspaceId]: FileLocation,
  read = call
): Promise<string> {
  const file = kind === "preview" ? { kind, workspaceId, path } : { kind, path };
  const { url } = await read(api.fileUrl, file);
  if (!url.startsWith("/")) return url;
  return new URL(url, (await resolveBackendEndpoints()).apiBase).href;
}

// Keep one query pending through an outage, so a player waiting for it retains its playhead.
export async function readMediaUrl(
  runtime: RuntimeClient,
  file: FileLocation,
  signal: AbortSignal
): Promise<string> {
  for (;;) {
    signal.throwIfAborted();
    const startedOffline = !runtime.isConnected();
    try {
      return await readFileUrl(file, runtime.call);
    } catch (error) {
      if (!(error instanceof RuntimeError && error.kind === "unavailable")) throw error;
      if (runtime.isConnected()) {
        if (startedOffline) continue; // Authentication arrived while the offline rejection settled.
        throw error;
      }
      const state = runtime.getState();
      if (state === "disposed" || state === "revoked") throw error;
    }
    signal.throwIfAborted();
    await new Promise<void>((resolve) => {
      function finish() {
        stop();
        signal.removeEventListener("abort", finish);
        resolve();
      }
      const stop = runtime.onStateChange((state) => {
        if (state === "online" || state === "disposed" || state === "revoked") finish();
      });
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
