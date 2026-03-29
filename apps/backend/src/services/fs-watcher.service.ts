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

  // Use cwd so chokidar tests ignore patterns against RELATIVE paths.
  // Without this, the dotfile regex matches ".deus" in the absolute workspace
  // path ({repo}/.deus/{slug}), silently ignoring every file.
  const watcher = chokidar.watch(".", {
    cwd: workspacePath,
    ignored: [
      /(^|[/\\])\../, // dotfiles/dirs (relative: .git, .env, .context)
      "**/node_modules/**",
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
  let pendingType: string | null = null;

  const flushChanges = (): void => {
    if (pendingCount > 0) {
      pushEvent("fs:changed", {
        workspace_path: workspacePath,
        change_type: pendingType ?? "mixed",
        affected_count: pendingCount,
      });
    }
    pendingCount = 0;
    pendingType = null;
  };

  const onFileChange = (changeType: string): void => {
    pendingCount++;
    pendingType =
      pendingType === null ? changeType : pendingType === changeType ? changeType : "mixed";

    const existing = debounceTimers.get(workspacePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      workspacePath,
      setTimeout(() => {
        flushChanges();
        debounceTimers.delete(workspacePath);
      }, DEBOUNCE_MS)
    );
  };

  watcher
    .on("add", () => onFileChange("add"))
    .on("change", () => onFileChange("change"))
    .on("unlink", () => onFileChange("unlink"))
    .on("addDir", () => onFileChange("add"))
    .on("unlinkDir", () => onFileChange("unlink"))
    .on("error", (error) => {
      console.error(`[fs-watcher] Error watching ${workspacePath}:`, error);
      watchers.delete(workspacePath);
      watcher.close().catch(() => {});
    });

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
