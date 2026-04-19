// shared/aap/types.ts
// Public-surface types for AAP host. Cross the backend ↔ agent-server ↔
// frontend boundary, so they live under shared.
//
// Kept separate from `manifest.ts` (Zod schemas for parsing agentic-app.json)
// because these don't need runtime validation — both producers and consumers
// are trusted in-process code in v1. If Phase 3's RPC layer needs wire-level
// validation of inputs arriving over the relay, Zod versions live in a
// Phase-3-owned file, not here.

// ----------------------------------------------------------------------------
// app identity + running state — pushed via the `apps` / `running_apps`
// query resources that the frontend subscribes to.
// ----------------------------------------------------------------------------

export type RunningStatus = "starting" | "ready" | "stopping";

/** Snapshot of one installed agentic app — what the `apps` resource returns.
 *  A subset of `Manifest` plus `bootstrap` pulled out of `agent`. The split
 *  is intentional: `Manifest` includes internal operational details
 *  (launch.command, launch.args, …) the UI has no business seeing. */
export interface InstalledApp {
  id: string;
  name: string;
  description: string;
  version: string;
  icon?: string;
  bootstrap?: string;
}

/** Snapshot of one currently-running app instance — what the `running_apps`
 *  resource returns. Strict subset of the backend-private `RunningAppEntry`
 *  with the `ChildProcess` reference stripped. Never add process-internal
 *  fields here. */
export interface RunningApp {
  id: string;
  appId: string;
  workspaceId: string | null;
  pid: number;
  port: number;
  url: string;
  status: RunningStatus;
  startedAt: string;
}

// ----------------------------------------------------------------------------
// launch contract — shared between the caller (agent tool, WS mutation,
// internal code) and the backend service.
// ----------------------------------------------------------------------------

export interface LaunchAppArgs {
  appId: string;
  workspaceId: string | null;
  /** Absolute path to the workspace directory (for `{workspace}` substitution). */
  workspacePath: string;
  /** Absolute path to the Deus user-data dir (for `{userData}` substitution). */
  userDataDir: string;
}

export interface LaunchAppResult {
  runningAppId: string;
  url: string;
  bootstrap?: string;
}

// ----------------------------------------------------------------------------
// q:event payloads — one-shot notifications pushed over the WS.
// ----------------------------------------------------------------------------

/** Emitted once when a `launchApp` transitions to `ready`. Phase 4 frontend
 *  uses `workspaceId` to decide whether to auto-open a tab. */
export interface AppsLaunchedEvent {
  appId: string;
  workspaceId: string | null;
  runningAppId: string;
  url: string;
}

/** Emitted once when a running app exits — intentional stop or crash. Phase 4
 *  frontend reacts by closing Browser tabs pointing at the app's URL (the
 *  port is gone; a cached page would break on refresh). Same shape as
 *  AppsLaunchedEvent so consumers can share URL-matching helpers. */
export interface AppsStoppedEvent {
  appId: string;
  workspaceId: string | null;
  runningAppId: string;
  url: string;
}
