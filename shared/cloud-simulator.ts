import { CloudSimulatorStatusSchema, type CloudSimulatorStatus } from "./events";

// A complete mirror names devices, not platformless command errors. Validate
// the whole list before treating an omitted platform as a removed device.
export const CloudSimulatorMirrorSchema = CloudSimulatorStatusSchema.required({
  platform: true,
}).array();

/** The provider's timestamp, or null when it cannot establish ordering. */
export function cloudSimulatorStatusAt(status: CloudSimulatorStatus): number | null {
  if (!status.timestamp) return null;
  const at = Date.parse(status.timestamp);
  return Number.isFinite(at) ? at : null;
}

/** Replays stay silent, but a fresh timestamp is a new command answer even
 * when the visible fields are unchanged: the UI must then release busy. */
export function sameCloudSimulatorStatus(
  a: CloudSimulatorStatus,
  b: CloudSimulatorStatus
): boolean {
  return (
    a.status === b.status &&
    a.platform === b.platform &&
    a.streamUrl === b.streamUrl &&
    a.error === b.error &&
    a.easSessionIdentifier === b.easSessionIdentifier &&
    a.timestamp === b.timestamp
  );
}

function statusRank(status: string): number {
  switch (status) {
    case "ready":
      return 0;
    case "starting":
      return 1;
    case "stopping":
      return 2;
    case "stopped":
      return 4;
    default:
      return 3; // error, or a status this build has never seen
  }
}

/** Prefer a running device over another platform's terminal status. Ties go
 * to the newer provider timestamp, then iOS. Return the original entry so
 * callers retain their ownership and synthetic-park metadata. */
export function selectPrimaryCloudSimulator<
  T extends { status: Pick<CloudSimulatorStatus, "status" | "platform">; at: number | null },
>(devices: Iterable<T> | undefined): T | null {
  let best: T | null = null;
  for (const device of devices ?? []) {
    if (!best) {
      best = device;
      continue;
    }
    const rank = statusRank(device.status.status) - statusRank(best.status.status);
    if (rank < 0) {
      best = device;
      continue;
    }
    if (rank > 0) continue;
    const newer = (device.at ?? -1) - (best.at ?? -1);
    if (
      newer > 0 ||
      (newer === 0 && device.status.platform === "ios" && best.status.platform !== "ios")
    ) {
      best = device;
    }
  }
  return best;
}
