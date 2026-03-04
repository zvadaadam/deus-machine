/**
 * Tauri Database Operations
 *
 * Typed wrappers for Rust DB read commands via Tauri IPC.
 * These bypass the Node.js backend entirely for hot-path reads
 * (~1ms via IPC vs 50-200ms via HTTP).
 *
 * Pattern follows src/platform/tauri/git.ts exactly.
 */

import { invoke } from "./invoke";
import type { RepoGroup } from "@shared/types/workspace";
import type { Session } from "@shared/types/session";
import type { Stats } from "@shared/types/repository";
import type { PaginatedMessages } from "@/features/session/api/session.service";

export function dbGetWorkspacesByRepo(state?: string): Promise<RepoGroup[]> {
  return invoke<RepoGroup[]>("db_get_workspaces_by_repo", { state: state ?? null });
}

export function dbGetStats(): Promise<Stats> {
  return invoke<Stats>("db_get_stats");
}

export function dbGetSession(id: string): Promise<Session | null> {
  return invoke<Session | null>("db_get_session", { id });
}

export function dbGetMessages(
  sessionId: string,
  opts?: { limit?: number; before?: number; after?: number }
): Promise<PaginatedMessages> {
  // Build payload without null fields — Tauri's serde can't deserialize
  // JSON null to Rust Option<i64>. Missing keys deserialize to None correctly.
  const payload: Record<string, unknown> = { session_id: sessionId };
  if (opts?.limit != null) payload.limit = opts.limit;
  if (opts?.before != null) payload.before = opts.before;
  if (opts?.after != null) payload.after = opts.after;
  return invoke<PaginatedMessages>("db_get_messages", payload);
}
