/**
 * File System Watcher Service — Backend
 *
 * Manages chokidar watchers for workspace directories.
 * Changes go to the clients following that folder (the `fileChanges` stream).
 */

import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { fileChanges, type FileChangeEvent } from "@shared/api/files";
import { publish } from "./streams";

// Active watchers keyed by workspace path
const watchers = new Map<string, FSWatcher>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

export async function watchWorkspace(workspacePath: string): Promise<void> {
  if (watchers.has(workspacePath)) return; // Already watching

  // cwd makes emitted paths relative; ignore callbacks still receive absolute paths.
  const watcher = chokidar.watch(".", {
    cwd: workspacePath,
    ignored: [
      (entry: string) => {
        const relative = (path.isAbsolute(entry) ? path.relative(workspacePath, entry) : entry)
          .replaceAll("\\", "/")
          .replace(/^\.\//, "");
        if (relative === ".deus" || relative === ".deus/environment.json") return false;
        return (
          /(^|\/)\.[^/]/.test(relative) ||
          /(^|\/)(node_modules|target|dist|build)(\/|$)/.test(relative)
        );
      },
    ],
    persistent: true,
    ignoreInitial: true,
    usePolling: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });

  let pendingCount = 0;
  let pendingType: FileChangeEvent["change_type"] | null = null;

  const flushChanges = (): void => {
    if (pendingCount > 0) {
      publish(
        fileChanges,
        { workspacePath },
        { change_type: pendingType ?? "mixed", affected_count: pendingCount }
      );
    }
    pendingCount = 0;
    pendingType = null;
  };

  const onFileChange = (changeType: "add" | "change" | "unlink"): void => {
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
