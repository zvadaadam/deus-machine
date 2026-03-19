/**
 * File System Watcher Service — Backend
 *
 * Manages chokidar watchers for workspace directories.
 * File change events are broadcast to all WS clients as q:event frames.
 */

import chokidar, { type FSWatcher } from "chokidar";
import { broadcast } from "./ws.service";

// Active watchers keyed by workspace path
const watchers = new Map<string, FSWatcher>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

function pushEvent(event: string, data: unknown): void {
  broadcast(JSON.stringify({ type: "q:event", event, data }));
}

export async function watchWorkspace(workspacePath: string): Promise<void> {
  if (watchers.has(workspacePath)) return; // Already watching

  const watcher = chokidar.watch(workspacePath, {
    ignored: [
      /(^|[/\\])\../, // dotfiles
      "**/node_modules/**",
      "**/.git/**",
      "**/target/**",
      "**/dist/**",
      "**/build/**",
    ],
    persistent: true,
    ignoreInitial: true,
    usePolling: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });

  let pendingCount = 0;
  let pendingType = "mixed";

  const flushChanges = (): void => {
    if (pendingCount > 0) {
      pushEvent("fs:changed", {
        workspace_path: workspacePath,
        change_type: pendingType,
        affected_count: pendingCount,
      });
    }
    pendingCount = 0;
    pendingType = "mixed";
  };

  const onFileChange = (changeType: string): void => {
    pendingCount++;
    pendingType = pendingType === "mixed" || pendingType === changeType ? changeType : "mixed";

    const existing = debounceTimers.get(workspacePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(workspacePath, setTimeout(() => {
      flushChanges();
      debounceTimers.delete(workspacePath);
    }, DEBOUNCE_MS));
  };

  watcher
    .on("add", () => onFileChange("add"))
    .on("change", () => onFileChange("change"))
    .on("unlink", () => onFileChange("unlink"))
    .on("addDir", () => onFileChange("add"))
    .on("unlinkDir", () => onFileChange("unlink"))
    .on("error", (error) => console.error(`[fs-watcher] Error watching ${workspacePath}:`, error));

  watchers.set(workspacePath, watcher);
}

export async function unwatchWorkspace(workspacePath: string): Promise<void> {
  const watcher = watchers.get(workspacePath);
  if (watcher) {
    await watcher.close();
    watchers.delete(workspacePath);
  }
  const timer = debounceTimers.get(workspacePath);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(workspacePath);
  }
}

/** Clean up all watchers. Called on shutdown. */
export function destroyAllWatchers(): void {
  for (const [_path, watcher] of watchers) {
    watcher.close().catch(() => {});
  }
  watchers.clear();
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}
