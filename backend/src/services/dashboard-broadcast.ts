// backend/src/services/dashboard-broadcast.ts
// Shared helper to broadcast workspace list + stats to all connected clients
// (both local WebSocket and virtual relay connections).

import { getDatabase } from "../lib/database";
import { getStats } from "../db";
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

    const workspaces = db.prepare(`
      SELECT
        w.id, w.slug, w.title,
        w.git_branch, w.git_target_branch,
        w.state, w.current_session_id,
        w.pr_url, w.pr_number, w.setup_status, w.error_message,
        w.updated_at,
        r.name as repo_name, r.root_path, r.git_default_branch,
        s.status as session_status, s.model,
        s.last_user_message_at as latest_message_sent_at
      FROM workspaces w
      LEFT JOIN repositories r ON w.repository_id = r.id
      LEFT JOIN sessions s ON w.current_session_id = s.id
      WHERE w.state != 'archived'
      ORDER BY r.sort_order ASC, r.name ASC, w.updated_at DESC
    `).all();

    const stats = getStats(db);

    broadcast(JSON.stringify({ type: "response", resource: "workspaces", data: workspaces }));
    broadcast(JSON.stringify({ type: "response", resource: "stats", data: stats }));
  } catch (err) {
    console.error("[Broadcast] Failed to broadcast workspaces/stats:", err);
  }
}
