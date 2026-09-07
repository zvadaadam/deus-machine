/** Shared by the sidebar, header and sidecar panels. Workspace errors take
 * precedence over a stale sleep/wake stage; a failed wake remains retryable. */
export type CloudPresence =
  | "awake"
  | "asleep"
  | "waking"
  | "unavailable"
  | "error"
  | "provisioning";

export function cloudPresence(workspace: {
  state: string;
  init_stage?: string | null;
}): CloudPresence {
  if (workspace.state === "error") return "error";
  if (workspace.state === "initializing") return "provisioning";
  if (workspace.init_stage === "error") return "unavailable";
  if (workspace.init_stage === "resuming") return "waking";
  if (workspace.init_stage === "paused" || workspace.init_stage === "stopped") return "asleep";
  return "awake";
}

export type CloudGateStage = Exclude<CloudPresence, "awake">;

/** Null means the Files/Changes/Terminal panels can serve this workspace. */
export function cloudGateStage(workspace: {
  kind: string;
  state: string;
  init_stage?: string | null;
}): CloudGateStage | null {
  if (workspace.kind !== "cloud") return null;
  const presence = cloudPresence(workspace);
  return presence === "awake" ? null : presence;
}
