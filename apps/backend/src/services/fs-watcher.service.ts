import { watch } from "node:fs";
import { fileChanges } from "@shared/api/files";
import { ValidationError } from "../lib/errors";
import { invalidateCache } from "./files.service";
import { publish, refuseSubscribers } from "./streams";

const watchers = new Map<string, ReturnType<typeof startWatch>>();

function ignored(filename: string | null): boolean {
  if (!filename || filename === ".deus/environment.json") return false;
  // Ignore descendants only. The leaf can be a regular file or an editor's hidden temporary file.
  return /(^|\/)(?:\.[^/]+|node_modules|target|dist|build)\//.test(filename);
}

function startWatch(workspaceId: string, workspacePath: string) {
  // Enable Linux when its pinned runtime passes the recursive watch checks: Bun 1.3.6 leaks and misses deep edits, Node 22 misses a delete.
  if (process.platform !== "darwin")
    throw new ValidationError("File watching is unavailable on this platform.");

  const scope = { workspaceId };
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: number | undefined;
  const flush = () => {
    deadline = undefined;
    invalidateCache(workspacePath);
    publish(fileChanges, scope, null);
  };
  const watcher = watch(workspacePath, { recursive: true }, (_kind, filename) => {
    if (!active || ignored(filename)) return;
    // A busy log or database must not postpone every other edit in the checkout.
    const now = performance.now();
    deadline ??= now + 2000;
    clearTimeout(timer);
    if (now >= deadline) flush();
    else timer = setTimeout(flush, Math.min(500, deadline - now));
  });
  // Someone may have edited the checkout while no client was following it.
  invalidateCache(workspacePath);
  const entry = {
    followers: 0,
    idle: undefined as ReturnType<typeof setTimeout> | undefined,
    close() {
      active = false;
      watchers.delete(workspaceId);
      clearTimeout(entry.idle);
      clearTimeout(timer);
      watcher.close();
    },
  };
  watcher.on("error", (error) => {
    if (!active) return;
    entry.close();
    console.warn(`[fs-watcher] Stopped watching ${workspacePath}:`, error);
    refuseSubscribers(fileChanges, scope, "The workspace file watcher stopped.");
  });
  return entry;
}

/** Keep the native watch across a brief disconnect or switch away and back. */
export function watchWorkspace(workspaceId: string, workspacePath: string): () => void {
  let watcher = watchers.get(workspaceId);
  if (!watcher) {
    watcher = startWatch(workspaceId, workspacePath);
    watchers.set(workspaceId, watcher);
  }
  const held = watcher;
  clearTimeout(held.idle);
  held.followers++;
  return () => {
    if (--held.followers || watchers.get(workspaceId) !== held) return;
    held.idle = setTimeout(held.close, 3000);
  };
}

export function destroyAllWatchers(): void {
  for (const watcher of watchers.values()) watcher.close();
}
