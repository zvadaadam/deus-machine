/**
 * Cloud simulator device state — the q:event "cloud:simulator" stream.
 *
 * One entry per cloud workspace. Nothing is persisted anywhere — the platform
 * is the truth (it replays the latest status on every connect and serves it
 * over REST): live `cloud:simulator` events feed this store, and a panel that
 * mounts on a workspace nothing was seen for yet seeds it once from the
 * backend's `cloudSimulator` read. Screenshots and the agent's device actions
 * exist ONLY here — a refresh clears them by design.
 */

import { create } from "zustand";
import { match } from "ts-pattern";
import { CloudSimulatorEventSchema } from "@shared/events";
import { onEvent } from "@/platform/ws";

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
  /** Bumped on every cloud:identity. A one-shot status read that started
   *  under an earlier generation answers for the previous account and is
   *  dropped (see CloudSimulatorPanel's seed). */
  generation: number;
}

const MAX_ACTIONS = 20;
let nextActionId = 1;

export const useCloudSimulatorStore = create<CloudSimulatorStore>()(() => ({
  byWorkspace: {},
  generation: 0,
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

/** A status frame (live, or the platform's one-shot read) REPLACES all four
 *  fields: a `stopped` never carries a URL and a non-error never carries an
 *  error. */
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

/** The platform's status as the backend's one-shot `cloudSimulator` read
 *  returns it (camelCase; null = the platform knows of no device). */
export interface CloudSimSeed {
  status: unknown;
  platform?: unknown;
  streamUrl?: unknown;
  error?: unknown;
}

export const cloudSimulatorActions = {
  /** The one-shot read is a FALLBACK for a workspace nothing was seen for yet:
   *  anything a live event already put here is newer by construction and wins.
   *  A null answer (no device was ever started) leaves the entry empty. */
  seedIfUnknown(workspaceId: string, seed: CloudSimSeed | null): void {
    if (!seed) return;
    const next = statusFields({
      status: seed.status,
      platform: seed.platform,
      streamUrl: seed.streamUrl,
      error: seed.error,
    });
    update(workspaceId, (prev) => (prev.status !== null ? prev : { ...prev, ...next }));
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

  /** The platform reports no device for the workspace: drop the entry
   *  (screenshots and actions included — they were that device's). */
  forget(workspaceId: string): void {
    useCloudSimulatorStore.setState((state) => {
      if (!(workspaceId in state.byWorkspace)) return state;
      const { [workspaceId]: _gone, ...rest } = state.byWorkspace;
      return { byWorkspace: rest };
    });
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
    if (event === "cloud:identity") {
      // Sign-out / account switch: every entry was the previous account's
      // device — stream URLs, screenshots, the agent's actions and their
      // arguments. Start over; a mounted panel re-seeds under the new identity.
      useCloudSimulatorStore.setState((state) => ({
        byWorkspace: {},
        generation: state.generation + 1,
      }));
      return;
    }
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
      // The platform knows of no device any more (a REST read said so):
      // back to the empty state — Start on a never-known device.
      .with({ kind: "gone" }, ({ workspaceId }) => cloudSimulatorActions.forget(workspaceId))
      .exhaustive();
  });
}
