import { ACTIVE_TURN_STATUSES, type SessionStatus, type WorkspaceKind } from "@shared/enums";
import { locationOf } from "@/features/sidebar/lib/location";

export function willQueueMessage(kind?: WorkspaceKind | null, status?: SessionStatus): boolean {
  return (
    kind != null &&
    locationOf({ kind }) === "local" &&
    status !== undefined &&
    ACTIVE_TURN_STATUSES.includes(status)
  );
}
