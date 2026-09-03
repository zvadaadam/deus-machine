/**
 * Cloud simulator device state — the q:event "cloud:simulator" stream.
 *
 * One entry per cloud workspace. The durable truth is the workspace row (the
 * backend writes `cloud_sim_*` from the platform's simulator.status frames and
 * the `workspaces` query delivers it); the panel seeds this store from the row
 * and live events overwrite it. Screenshots and the agent's device actions
 * exist ONLY here — the platform never persists them and neither do we (no
 * DB, no localStorage): a refresh clears them by design.
 */

import { create } from "zustand";
import { match } from "ts-pattern";
import { CloudSimulatorEventSchema } from "@shared/events";
import { onEvent } from "@/platform/ws";
import type { Workspace } from "@shared/types/workspace";

export type CloudSimPlatform = "ios" | "android";

export interface CloudSimActionResult {
  id: number;
  verb: string;
  args: string[];
  success: boolean;
  /** The platform's error text when the action failed. */
  error: string | null;
  /** Arrival time — the strip renders insertion order; this is for debugging. */
  at: number;
}

export interface CloudSimDevice {
  /** Platform status — starting | ready | stopping | stopped | error, but an
   *  OPEN set (the platform deploys continuously; see CloudSimulatorStatusSchema).
   *  null when no device was ever known to this workspace. */
  status: string | null;
  platform: CloudSimPlatform | null;
  /** The stream is a capability URL: only ever set while starting/ready. */
  streamUrl: string | null;
  /** The platform's error text — only while status is "error". */
  error: string | null;
  /** A Start/Stop the panel sent whose status echo hasn't arrived yet. */
  busy: "starting" | "stopping" | null;
  lastScreenshot: { base64: string; at: number } | null;
  /** Ring of the most recent action results, oldest first. */
  actions: CloudSimActionResult[];
}

/** The absent-entry value: one frozen reference so selectors reading a
 *  workspace with no entry don't see a fresh object every render. */
export const EMPTY_CLOUD_SIM_DEVICE: CloudSimDevice = Object.freeze({
  status: null,
  platform: null,
  streamUrl: null,
  error: null,
  busy: null,
  lastScreenshot: null,
  actions: [] as CloudSimActionResult[],
}) as CloudSimDevice;

interface CloudSimulatorStore {
  byWorkspace: Record<string, CloudSimDevice>;
}

const MAX_ACTIONS = 20;
let nextActionId = 1;

export const useCloudSimulatorStore = create<CloudSimulatorStore>()(() => ({
  byWorkspace: {},
}));

/** Apply a recipe to one workspace's entry; an unchanged result leaves the
 *  store (and every subscribed selector) untouched. */
function update(workspaceId: string, recipe: (prev: CloudSimDevice) => CloudSimDevice): void {
  useCloudSimulatorStore.setState((state) => {
    const prev = state.byWorkspace[workspaceId] ?? EMPTY_CLOUD_SIM_DEVICE;
    const next = recipe(prev);
    if (next === prev) return state;
    return { byWorkspace: { ...state.byWorkspace, [workspaceId]: next } };
  });
}

function parseString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parsePlatform(value: unknown): CloudSimPlatform | null {
  return value === "ios" || value === "android" ? value : null;
}

type StatusFields = Pick<CloudSimDevice, "status" | "platform" | "streamUrl" | "error">;

/** A status frame (and the row that mirrors it) REPLACES all four fields: a
 *  `stopped` never carries a URL and a non-error never carries an error. */
function statusFields(raw: {
  status: unknown;
  platform: unknown;
  streamUrl: unknown;
  error: unknown;
}): StatusFields {
  const status = parseString(raw.status);
  return {
    status,
    platform: parsePlatform(raw.platform),
    streamUrl: status === "starting" || status === "ready" ? parseString(raw.streamUrl) : null,
    error: status === "error" ? parseString(raw.error) : null,
  };
}

function sameStatus(prev: CloudSimDevice, next: StatusFields): boolean {
  return (
    prev.status === next.status &&
    prev.platform === next.platform &&
    prev.streamUrl === next.streamUrl &&
    prev.error === next.error
  );
}

export type CloudSimWorkspaceRow = Pick<
  Workspace,
  "id" | "cloud_sim_status" | "cloud_sim_platform" | "cloud_sim_stream_url" | "cloud_sim_error"
>;

export const cloudSimulatorActions = {
  /** The row is the durable truth: it always wins for the four status fields.
   *  The optimistic `busy` marker survives an IDENTICAL row (the `workspaces`
   *  query re-delivers on unrelated column changes) and clears when the row
   *  actually moved. */
  seedFromWorkspace(row: CloudSimWorkspaceRow): void {
    const next = statusFields({
      status: row.cloud_sim_status,
      platform: row.cloud_sim_platform,
      streamUrl: row.cloud_sim_stream_url,
      error: row.cloud_sim_error,
    });
    update(row.id, (prev) => (sameStatus(prev, next) ? prev : { ...prev, ...next, busy: null }));
  },

  /** A status EVENT means the platform answered — clear `busy` even when the
   *  status it reports is unchanged (the command had no effect; the button
   *  comes back). Identical AND not busy → same reference, no re-render. */
  applyStatusEvent(
    workspaceId: string,
    data: { status: unknown; platform?: unknown; streamUrl?: unknown; error?: unknown }
  ): void {
    const next = statusFields({
      status: data.status,
      platform: data.platform,
      streamUrl: data.streamUrl,
      error: data.error,
    });
    update(workspaceId, (prev) =>
      sameStatus(prev, next) && prev.busy === null ? prev : { ...prev, ...next, busy: null }
    );
  },

  setBusy(workspaceId: string, busy: CloudSimDevice["busy"]): void {
    update(workspaceId, (prev) => (prev.busy === busy ? prev : { ...prev, busy }));
  },

  recordScreenshot(workspaceId: string, base64: string): void {
    update(workspaceId, (prev) => ({ ...prev, lastScreenshot: { base64, at: Date.now() } }));
  },

  recordAction(workspaceId: string, result: Omit<CloudSimActionResult, "id" | "at">): void {
    update(workspaceId, (prev) => ({
      ...prev,
      actions: [...prev.actions, { ...result, id: nextActionId++, at: Date.now() }].slice(
        -MAX_ACTIONS
      ),
    }));
  },
};

// One process-wide listener regardless of how many panels or tab bars read the
// store — per-component subscriptions would double-append the action ring.
let subscribed = false;

export function ensureCloudSimulatorSubscription(): void {
  if (subscribed) return;
  subscribed = true;

  onEvent((event, raw) => {
    if (event !== "cloud:simulator") return;
    const parsed = CloudSimulatorEventSchema.safeParse(raw);
    if (!parsed.success) return;

    // The device belongs to the WORKSPACE (agnt fans its status out to every
    // session), so entries key on workspaceId, never on the session.
    match(parsed.data)
      .with({ kind: "status" }, ({ workspaceId, data }) =>
        cloudSimulatorActions.applyStatusEvent(workspaceId, data)
      )
      .with({ kind: "screenshot" }, ({ workspaceId, data }) => {
        const base64 = parseString(data.imageBase64);
        if (base64) cloudSimulatorActions.recordScreenshot(workspaceId, base64);
      })
      .with({ kind: "action_result" }, ({ workspaceId, data }) =>
        cloudSimulatorActions.recordAction(workspaceId, {
          verb: data.verb,
          args: data.args ?? [],
          success: data.success,
          error: parseString(data.error),
        })
      )
      .exhaustive();
  });
}
