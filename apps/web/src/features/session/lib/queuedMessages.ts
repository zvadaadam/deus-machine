import { ACTIVE_TURN_STATUSES, type SessionStatus, type WorkspaceKind } from "@shared/enums";
import { locationOf } from "@/features/sidebar/lib/location";

export function limitTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    ...(date.toDateString() !== new Date().toDateString() && { day: "numeric", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function willQueueMessage(kind?: WorkspaceKind | null, status?: SessionStatus): boolean {
  return (
    kind != null &&
    locationOf({ kind }) === "local" &&
    status !== undefined &&
    ACTIVE_TURN_STATUSES.includes(status)
  );
}
