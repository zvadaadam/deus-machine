/**
 * Cloud sandbox presence, derived from the workspace row's `init_stage` (the
 * driver mirrors agnt's workspace status into it). ONE vocabulary for every
 * surface — the sidebar liveness icon and the header chip must never disagree
 * about what "asleep" means.
 *
 *   awake  — sandbox running (or no stage recorded)
 *   asleep — paused/stopped, or a wake that failed (init_stage "error"/
 *            "unhandled") on a still-"ready" row: the sidecar can't serve, so
 *            the panels gate to a retry affordance rather than firing at a
 *            down machine. Wakes on send or via the wake affordances.
 *   waking — an explicit resume is in flight
 */
export type CloudPresence = "awake" | "asleep" | "waking";

export function cloudPresence(initStage: string | null | undefined): CloudPresence {
  if (initStage === "resuming") return "waking";
  if (initStage === "paused" || initStage === "stopped") return "asleep";
  // A failed wake persists init_stage "error" (provider unreachable / resume
  // rejected) on a state="ready" row WITHOUT a state flip, and "unhandled" is
  // parked alongside state="error" elsewhere. Neither is awake: without this
  // branch both fall through to "awake", cloudGateStage returns null, and the
  // panels mount against a sidecar that can't serve. Treat them as asleep so
  // the CloudSandboxGate mounts its "Wake computer" retry.
  if (initStage === "error" || initStage === "unhandled") return "asleep";
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
  // "error" — for a setup stage cloudPresence reads that as "awake", so the
  // panels would fire against a sidecar that never started. The state check
  // below fires before cloudPresence, so an honestly-errored row gates to a
  // failure even when init_stage is "error"/"unhandled" (which cloudPresence
  // otherwise classifies as asleep). Gate it to an honest failure.
  if (workspace.state === "error") return "error";
  if (workspace.state === "initializing") return "provisioning";
  const presence = cloudPresence(workspace.init_stage);
  if (presence === "asleep") return "asleep";
  if (presence === "waking") return "waking";
  return null; // ready + awake → the sidecar can serve
}
