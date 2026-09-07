import { TurnEndedEventSchema } from "@deus-hq/api";
import { toast } from "sonner";

/** Live turn failures only; reconnect snapshots must not replay notifications. */
export function notifyCloudAutosaveFailure(event: unknown): void {
  const parsed = TurnEndedEventSchema.safeParse(event);
  if (!parsed.success) return;
  const { gitSync, sessionId, turnId } = parsed.data;
  const error =
    gitSync?.error ||
    (gitSync?.conflict ? "Git push hit a conflict with the remote repository." : undefined);
  if (!error) return;

  toast.warning("Cloud autosave failed", {
    description: error,
    id: `cloud-autosave-${sessionId}-${turnId}`,
    duration: 10_000,
    closeButton: true,
  });
}
