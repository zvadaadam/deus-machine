import { getDatabase } from "../lib/database";
import { ConflictError } from "../lib/errors";

/** Project coordination owns a managed workspace's lifecycle and conversation. */
export function assertUnmanagedWorkspace(workspaceId: string): void {
  const membership = getDatabase()
    .prepare("SELECT project_id FROM project_agents WHERE agent_id = ?")
    .get(workspaceId) as { project_id: string } | undefined;
  if (membership) {
    throw new ConflictError("This Agent is managed by a Project. Use its Project controls.", {
      projectId: membership.project_id,
    });
  }
}
