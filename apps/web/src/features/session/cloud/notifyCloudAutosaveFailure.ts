import { toast } from "sonner";
import type { CloudSaveFailure } from "@shared/cloud-autosave";

/** Warn that a cloud turn's work was not saved. One toast per turn, however often it is told. */
export function notifyCloudAutosaveFailure({ sessionId, turnId, error }: CloudSaveFailure): void {
  toast.warning("Cloud autosave failed", {
    description: error,
    id: `cloud-autosave-${sessionId}-${turnId}`,
    duration: 10_000,
    closeButton: true,
  });
}
