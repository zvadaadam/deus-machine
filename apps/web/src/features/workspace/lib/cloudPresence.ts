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

/**
 * Whether a cloud computer's sidecar can serve the Files/Changes/Terminal
 * panels — and if not, WHY (for the gate). `cloudPresence` only reads
 * `init_stage`, which parks the sleep states; it can't see INITIAL provisioning
 * (state "initializing"), where the sidecar isn't up yet and the panels would
 * otherwise show a raw "WebSocket not connected". Returns null when serviceable.
 */
export type CloudGateStage = "provisioning" | "asleep" | "waking" | "error";

export function cloudGateStage(workspace: {
  kind: string;
  state: string;
  init_stage?: string | null;
}): CloudGateStage | null {
  if (workspace.kind !== "cloud") return null;
  // A failed provision keeps its (non-sleep) init_stage but flips state to
  // "error" — cloudPresence would read that as "awake", so the panels would
  // fire against a sidecar that never started. Gate it to an honest failure.
  if (workspace.state === "error") return "error";
  if (workspace.state === "initializing") return "provisioning";
  const presence = cloudPresence(workspace.init_stage);
  if (presence === "asleep") return "asleep";
  if (presence === "waking") return "waking";
  return null; // ready + awake → the sidecar can serve
}
