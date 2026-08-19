/**
 * Cloud sandbox presence, derived from the workspace row's `init_stage` (the
 * driver mirrors agnt's workspace status into it). ONE vocabulary for every
 * surface — the sidebar liveness icon and the header chip must never disagree
 * about what "asleep" means.
 *
 *   awake  — sandbox running (or no stage recorded)
 *   asleep — paused/stopped; wakes on send or via the wake affordances
 *   waking — an explicit resume is in flight
 */
export type CloudPresence = "awake" | "asleep" | "waking";

export function cloudPresence(initStage: string | null | undefined): CloudPresence {
  if (initStage === "resuming") return "waking";
  if (initStage === "paused" || initStage === "stopped") return "asleep";
  return "awake";
}
