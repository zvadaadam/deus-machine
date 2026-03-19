/**
 * Electron Database Operations (Stubs)
 *
 * In the Electron architecture, DB reads go through the Node.js backend
 * via HTTP/WebSocket. These stubs throw so that the try/catch fallback
 * pattern in service files kicks in and routes through HTTP.
 *
 * These stub functions throw immediately so the try/catch fallback in
 * service files routes through HTTP instead.
 */

import type { RepoGroup } from "@shared/types/workspace";
import type { Session } from "@shared/types/session";
import type { Stats } from "@shared/types/repository";
import type { PaginatedMessages } from "@/features/session/api/session.service";

export function dbGetWorkspacesByRepo(_state?: string): Promise<RepoGroup[]> {
  throw new Error("DB IPC not available in Electron — use HTTP/WS fallback");
}

export function dbGetStats(): Promise<Stats> {
  throw new Error("DB IPC not available in Electron — use HTTP/WS fallback");
}

export function dbGetSession(_id: string): Promise<Session | null> {
  throw new Error("DB IPC not available in Electron — use HTTP/WS fallback");
}

export function dbGetMessages(
  _sessionId: string,
  _opts?: { limit?: number; before?: number; after?: number }
): Promise<PaginatedMessages> {
  throw new Error("DB IPC not available in Electron — use HTTP/WS fallback");
}
