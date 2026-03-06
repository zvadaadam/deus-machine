// backend/src/services/dashboard-broadcast.ts
// Shared helper to broadcast workspace list + stats to all connected clients
// (both local WebSocket and virtual relay connections).

import { getDatabase } from "../lib/database";
import { getDashboardWorkspaces, getStats } from "../db";
import { broadcast } from "./ws.service";

/**
 * Query DB and broadcast workspace list + stats to all connected clients.
 * Used by:
 * - /api/notify (sidecar writes)
 * - Session/workspace route handlers (backend mutations)
 */
export function broadcastWorkspacesAndStats(): void {
  try {
    const db = getDatabase();
    const workspaces = getDashboardWorkspaces(db);
    const stats = getStats(db);

    broadcast(JSON.stringify({ type: "response", resource: "workspaces", data: workspaces }));
    broadcast(JSON.stringify({ type: "response", resource: "stats", data: stats }));
  } catch (err) {
    console.error("[Broadcast] Failed to broadcast workspaces/stats:", err);
  }
}
